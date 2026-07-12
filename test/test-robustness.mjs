import test from "node:test";
import assert from "node:assert/strict";

import { scaleDeployAmount } from "../config.js";
import { checkCircuitBreaker, LOSS_PAUSE_MS, scoreCandidate } from "../policy-engine.js";
import { LogisticRegression } from "../ml/model.js";
import { onlineUpdate } from "../ml/trainer.js";
import { actionForLift, computeNumericLift } from "../signal-weights.js";
import { stageMlFeatures, getAndClearStagedMlFeatures } from "../signal-tracker.js";
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

test("125 bp pools receive an adverse-selection score penalty", () => {
  const candidate = {
    fee_active_tvl_ratio: 0.1,
    organic_score: 85,
    volume_window: 50_000,
    holders: 2_000,
    volatility: 5,
    token_age_hours: 24,
    volume_5m: 2_000,
    volume_30m: 8_000,
  };
  const result100 = scoreCandidate({ ...candidate, bin_step: 100 });
  const result125 = scoreCandidate({ ...candidate, bin_step: 125 });
  assert.ok(result125.score < result100.score);
  assert.ok(result125.reasons.some((reason) => reason.includes("adverse-selection")));
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
