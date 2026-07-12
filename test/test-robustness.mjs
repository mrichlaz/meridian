import test from "node:test";
import assert from "node:assert/strict";

import { scaleDeployAmount } from "../config.js";
import { checkCircuitBreaker, LOSS_PAUSE_MS, scoreCandidate } from "../policy-engine.js";
import {
  applyLearnedRangePreference,
  buildAdaptivePreferenceProfile,
  candidatePreferenceAdjustment,
} from "../adaptive-preferences.js";
import { LogisticRegression } from "../ml/model.js";
import { onlineUpdate } from "../ml/trainer.js";
import { actionForLift, computeNumericLift } from "../signal-weights.js";
import { stageMlFeatures, getAndClearStagedMlFeatures } from "../signal-tracker.js";
import { getEffectiveWindowThresholds } from "../screening-scales.js";
import { mergeCandidatePools } from "../tools/screening.js";
import { condenseGmgnCandidate } from "../tools/gmgn.js";
import {
  assertSafeSingleSideCoverage,
  deployLearningMetadata,
  maxBinsForDownsideCoverage,
} from "../tools/dlmm.js";

test("loss circuit breaker recovers after its cooldown", () => {
  const now = Date.parse("2026-07-12T12:00:00Z");
  const losses = [1, 2, 3].map((n) => ({
    pnl_usd: -n,
    recorded_at: new Date(now - 60_000).toISOString(),
  }));
  assert.equal(checkCircuitBreaker({ recentPerformance: losses, now }).blocked, true);
  assert.equal(checkCircuitBreaker({ recentPerformance: losses, now: now + LOSS_PAUSE_MS + 1 }).blocked, false);
});

test("automated risk sizing scales with any configured base amount", () => {
  const multiplierCases = [
    { profile: 1, score: 0.5 },
    { profile: 1, score: 0.65 },
    { profile: 1, score: 1 },
    { profile: 1, score: 1.25 },
  ];
  for (const { profile, score } of multiplierCases) {
    const small = scaleDeployAmount(2, profile, score);
    const large = scaleDeployAmount(8, profile, score);
    assert.equal(large / small, 4);
  }
});

test("fee/active-TVL baseline scales consistently across discovery timeframes", () => {
  const baseline = 0.015;
  const fiveMinute = getEffectiveWindowThresholds({ minFeeActiveTvlRatio: baseline }, "5m").minFeeActiveTvlRatio;
  const thirtyMinute = getEffectiveWindowThresholds({ minFeeActiveTvlRatio: baseline }, "30m").minFeeActiveTvlRatio;
  const oneHour = getEffectiveWindowThresholds({ minFeeActiveTvlRatio: baseline }, "1h").minFeeActiveTvlRatio;
  assert.equal(fiveMinute, baseline);
  assert.ok(thirtyMinute > fiveMinute);
  assert.ok(oneHour > thirtyMinute);
  assert.ok(Math.abs(thirtyMinute - 0.0544954395) < 1e-9);
});

test("three-source merge preserves authoritative pool metric provenance", () => {
  const base = { symbol: "TEST", mint: "mint-test" };
  const merged = mergeCandidatePools({
    meteoraPools: [{ pool: "pool-test", base, discovery_timeframe: "1h", fee_active_tvl_ratio: 0.2, volume_window: 10_000 }],
    gmgnPools: [{ pool: "pool-test", base, discovery_timeframe: "30m", fee_active_tvl_ratio: 0.01, volume_window: 500, gmgn_smart_wallets: 2 }],
    botTrackerPools: [{ pool: "pool-test", base, discovery_timeframe: "5m", fee_active_tvl_ratio: 0.9, bot_traded: true, bot_trade_count: 4 }],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].discovery_timeframe, "1h");
  assert.equal(merged[0].fee_active_tvl_ratio, 0.2);
  assert.equal(merged[0].volume_window, 10_000);
  assert.equal(merged[0].gmgn_smart_wallets, 2);
  assert.deepEqual(merged[0].sources, { meteora: true, gmgn: true, bot_tracker: true });
});

test("pure GMGN candidates carry complete timeframe-aligned screening fields", () => {
  const candidate = condenseGmgnCandidate({
    token: { symbol: "TEST", address: "mint-test", holder_count: 500, market_cap: 1_000_000, volume: 999 },
    pool: { address: "pool-test", name: "TEST-SOL", pool_config: { bin_step: 100 }, token_x: {}, token_y: {} },
    poolDetail: {
      tvl: 50_000,
      active_tvl: 40_000,
      fee_active_tvl_ratio: 0.08,
      volume: 12_000,
      volatility: 2.5,
      base_token_holders: 750,
      token_x: { organic_score: 82 },
    },
    security: {},
    info: {},
    infoAnalysis: {},
    holdersAnalysis: { kolHolding: 0, smartHolding: 0, smartAccumulating: 0 },
    indicatorSignal: null,
    discoveryTimeframe: "30m",
  });
  assert.equal(candidate.discovery_timeframe, "30m");
  assert.equal(candidate.volume_window, 12_000);
  assert.equal(candidate.organic_score, 82);
  assert.equal(candidate.holders, 750);
});

test("one portfolio tail loss pauses new deployment", () => {
  const now = Date.parse("2026-07-12T12:00:00Z");
  const recent = [{
    pnl_usd: -28.04,
    pnl_pct: -6.7,
    initial_value_usd: 338.58,
    recorded_at: new Date(now - 60_000).toISOString(),
  }];
  const result = checkCircuitBreaker({ recentPerformance: recent, now });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /tail loss/);
});

test("deploy learning metadata preserves the full entry snapshot", () => {
  const tracked = {
    deployed_at: "2026-07-12T01:00:00Z",
    signal_snapshot: { organic_score: 91 },
    ml_snapshot: { norm: [0.1, 0.2] },
    entry_mcap: 100_000,
    entry_tvl: 20_000,
    entry_volume: 80_000,
    entry_holders: 1_200,
    entry_score: 74,
    entry_regime: "NEUTRAL",
    entry_fee_volatility_ratio: 0.03,
    entry_volume_persistence_ratio: 2.4,
    entry_toxic_flow: [],
  };
  const metadata = deployLearningMetadata(tracked, { organic_score: 93 });
  assert.deepEqual(metadata.ml_snapshot, tracked.ml_snapshot);
  assert.deepEqual(metadata.signal_snapshot, { organic_score: 93 });
  assert.equal(metadata.entry_score, 74);
  assert.equal(metadata.entry_regime, "NEUTRAL");
  assert.equal(metadata.entry_volume_persistence_ratio, 2.4);
});

test("staged ML snapshots expire with the same TTL as signal snapshots", () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    stageMlFeatures("pool-expiry-test", { norm: [0.5] });
    now += 10 * 60 * 1000 + 1;
    assert.equal(getAndClearStagedMlFeatures("pool-expiry-test"), null);
  } finally {
    Date.now = realNow;
  }
});

test("single-sided range caps adapt to bin step", () => {
  assert.equal(maxBinsForDownsideCoverage(80), 75);
  assert.equal(maxBinsForDownsideCoverage(100), 60);
  assert.equal(maxBinsForDownsideCoverage(125), 48);
  assert.doesNotThrow(() => assertSafeSingleSideCoverage(45));
  assert.throws(() => assertSafeSingleSideCoverage(45.1), /Unsafe single-side range/);
});

test("125 bp pools use a conservative prior before adaptive evidence is ready", () => {
  const candidate = {
    fee_active_tvl_ratio: 0.05,
    organic_score: 75,
    volume_window: 5_000,
    holders: 700,
    volatility: 5,
    token_age_hours: 24,
    volume_5m: 1_000,
    volume_30m: 3_000,
  };
  const coldStart = buildAdaptivePreferenceProfile([]);
  const result100 = scoreCandidate({ ...candidate, bin_step: 100 }, { preferenceProfile: coldStart });
  const result125 = scoreCandidate({ ...candidate, bin_step: 125 }, { preferenceProfile: coldStart });
  assert.ok(result125.score < result100.score);
  assert.ok(result125.reasons.some((reason) => reason.includes("conservative prior")));
});

function preferenceRecords({ count = 240, highStepReturn = -2, lowStepReturn = 2, amountSol = 4.4 } = {}) {
  const start = Date.parse("2026-07-01T00:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const highStep = index % 2 === 1;
    return {
      position: `preference-${index}`,
      base_mint: `mint-${index % 40}`,
      bin_step: highStep ? 125 : 100,
      entry_mcap: highStep ? 700_000 : 2_000_000,
      bin_range: { bins_below: highStep ? 35 : 35 },
      amount_sol: amountSol,
      initial_value_usd: amountSol * 150,
      pnl_pct: highStep ? highStepReturn : lowStepReturn,
      deployed_at: new Date(start + index * 60 * 60 * 1000).toISOString(),
      recorded_at: new Date(start + (index + 1) * 60 * 60 * 1000).toISOString(),
    };
  });
}

test("adaptive preferences penalize negative expectancy without boosting the winner", () => {
  const profile = buildAdaptivePreferenceProfile(preferenceRecords(), { now: Date.parse("2026-07-20T00:00:00Z") });
  const high = candidatePreferenceAdjustment({ bin_step: 125, mcap: 700_000 }, profile);
  const low = candidatePreferenceAdjustment({ bin_step: 100, mcap: 2_000_000 }, profile);
  assert.equal(profile.ready, true);
  assert.ok(high.scoreAdjustment < 0);
  assert.equal(low.scoreAdjustment, 0);
});

test("adaptive preference changes when the rolling evidence reverses", () => {
  const oldProfile = buildAdaptivePreferenceProfile(preferenceRecords());
  const newProfile = buildAdaptivePreferenceProfile(preferenceRecords({ count: 500, highStepReturn: 3, lowStepReturn: -2 }));
  assert.ok(candidatePreferenceAdjustment({ bin_step: 125, mcap: 700_000 }, oldProfile).scoreAdjustment < 0);
  assert.equal(candidatePreferenceAdjustment({ bin_step: 125, mcap: 700_000 }, newProfile).scoreAdjustment, 0);
  assert.ok(candidatePreferenceAdjustment({ bin_step: 100, mcap: 2_000_000 }, newProfile).scoreAdjustment < 0);
});

test("adaptive learning is invariant to configured SOL deploy size", () => {
  const small = buildAdaptivePreferenceProfile(preferenceRecords({ amountSol: 2 }));
  const large = buildAdaptivePreferenceProfile(preferenceRecords({ amountSol: 8 }));
  assert.equal(
    candidatePreferenceAdjustment({ bin_step: 125, mcap: 700_000 }, small).scoreAdjustment,
    candidatePreferenceAdjustment({ bin_step: 125, mcap: 700_000 }, large).scoreAdjustment,
  );
});

test("learned range movement is bounded to ten percent per decision", () => {
  assert.equal(applyLearnedRangePreference(60, 100, 25), 54);
  assert.equal(applyLearnedRangePreference(40, 100, 45), 44);
  assert.equal(applyLearnedRangePreference(60, 100, null), 60);
});

test("Darwin lift keeps direction and ignores noisy quartiles", () => {
  const wins = [{ signal_snapshot: { organic_score: 20, volatility: 2 } }];
  const losses = [{ signal_snapshot: { organic_score: 80, volatility: 10 } }];
  assert.ok(computeNumericLift("organic_score", wins, losses, 2) < 0);
  assert.ok(computeNumericLift("volatility", wins, losses, 2) > 0);
  assert.equal(actionForLift(-0.2, true, false), "hold");
  assert.equal(actionForLift(0.02, true, false), "hold");
  assert.equal(actionForLift(0.2, true, false), "boost");
});

test("PnL estimate is unavailable unless walk-forward calibration exists", () => {
  const model = new LogisticRegression(2);
  model.weights = new Float64Array([0, 0]);
  assert.equal(model.predictPnl(new Float64Array([0, 0])), null);
  model.pnlCalibration = { intercept: -5, slope: 20, min: -10, max: 15, samples: 100 };
  assert.equal(model.predictPnl(new Float64Array([0, 0])), 5);
});

test("single-close online updates cannot mutate the production model", async () => {
  assert.deepEqual(await onlineUpdate({ pnl_pct: 10 }), {
    updated: false,
    reason: "batch_validation_required",
  });
});
