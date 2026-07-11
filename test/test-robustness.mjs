import test from "node:test";
import assert from "node:assert/strict";

import { checkCircuitBreaker, LOSS_PAUSE_MS } from "../policy-engine.js";
import { LogisticRegression } from "../ml/model.js";
import { onlineUpdate } from "../ml/trainer.js";
import { actionForLift, computeNumericLift } from "../signal-weights.js";
import { stageMlFeatures, getAndClearStagedMlFeatures } from "../signal-tracker.js";
import { deployLearningMetadata } from "../tools/dlmm.js";

test("loss circuit breaker recovers after its cooldown", () => {
  const now = Date.parse("2026-07-12T12:00:00Z");
  const losses = [1, 2, 3].map((n) => ({
    pnl_usd: -n,
    recorded_at: new Date(now - 60_000).toISOString(),
  }));
  assert.equal(checkCircuitBreaker({ recentPerformance: losses, now }).blocked, true);
  assert.equal(checkCircuitBreaker({ recentPerformance: losses, now: now + LOSS_PAUSE_MS + 1 }).blocked, false);
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
