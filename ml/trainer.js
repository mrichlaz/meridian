/**
 * ML Trainer — training pipeline using historical performance data.
 *
 * Integrates with the existing learning loop:
 *   - Triggers after every N closed positions (config.ml.trainEvery)
 *   - Reads all performance records from data/lessons.json
 *   - Reconstructs deploy-time feature vectors via extractFromPerformance()
 *   - Trains logistic regression on binary labels (profitable / not)
 *   - Saves updated model to data/ml/ml-model.json
 *
 * Training approach (Pwnagotchi-inspired):
 *   - Logistic regression: 74 weights + bias = 75 parameters total
 *   - Pwnagotchi runs A2C with ~3K params on a Pi Zero via stable-baselines
 *   - We use logistic regression because our 74 features are already
 *     hand-crafted domain signals — a linear combination is interpretable
 *     and convex (always converges to global optimum)
 *   - Binary labels: pnl_pct > 0 → 1, else 0
 *   - Class-weighted loss to handle imbalanced data
 *   - Automatic validation split + early stopping
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { log } from "../logger.js";
import { LogisticRegression } from "./model.js";
import {
  extractFromPerformance,
  FEATURE_COUNT,
} from "./features.js";
import { PATHS } from "../utils/paths.js";

const ML_DIR = join(PATHS.data, "ml");
const CHECKPOINT_DIR = join(ML_DIR, "checkpoints");

// ─── Defaults ───────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  enabled: true,
  trainEvery: 5,
  minSamples: 10,
  batchSize: 16,
  epochs: 20,
  learningRate: 0.001,
  l2: 0.001,
  kFolds: 5,            // walk-forward folds (chronological, no shuffling)
  // Train on the most recent N closes only (0 = full history). Old-regime
  // trades teach a market that no longer exists — mirrors the evolve window.
  trainWindowRecords: 500,
  saveCheckpoints: true,
  // Expectancy labeling: a trade only counts as a "win" if it cleared this
  // PnL hurdle (round-trip cost + minimum risk premium). pnl_pct > 0 alone
  // rewards scratch wins and teaches the model hit-rate, not expectancy.
  labelHurdlePct: 1.0,
  // Sample weight = clamp(|pnl_pct| / weightScalePct, weightFloor, weightCap):
  // a -30% blowup teaches ~4x more than a +0.3% scratch.
  weightScalePct: 5,
  weightFloor: 0.5,
  weightCap: 4,
};

// ─── Data loading ───────────────────────────────────────────────

function loadTrainingData(opts = {}) {
  const lessonFiles = [PATHS.lessons, join(PATHS.root, "data", "lessons.json")];
  const perfEntries = [];
  const seen = new Set();

  for (const lessonsFile of lessonFiles) {
    if (!lessonsFile || !existsSync(lessonsFile)) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(lessonsFile, "utf8"));
    } catch {
      continue;
    }
    const perf = Array.isArray(raw.performance) ? raw.performance : [];
    for (const entry of perf) {
      const key = `${entry?.position || "?"}:${entry?.recorded_at || entry?.closed_at || entry?.pool_name || "?"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      perfEntries.push(entry);
    }
  }

  if (perfEntries.length === 0) {
    log("ml_trainer", "No performance records found in lessons stores");
  }

  const samples = [];
  const hurdle = Number(opts.labelHurdlePct ?? DEFAULT_CONFIG.labelHurdlePct);
  const weightScale = Number(opts.weightScalePct ?? DEFAULT_CONFIG.weightScalePct);
  const weightFloor = Number(opts.weightFloor ?? DEFAULT_CONFIG.weightFloor);
  const weightCap = Number(opts.weightCap ?? DEFAULT_CONFIG.weightCap);
  for (const entry of perfEntries) {
    if (typeof entry.pnl_pct !== "number") continue;
    if (!entry.signal_snapshot && typeof entry.fee_tvl_ratio !== "number") continue;

    try {
      const features = extractFromPerformance(entry);
      // Expectancy label: only above-hurdle trades are positives, and each
      // sample's gradient is scaled by PnL magnitude so the model optimizes
      // for expected value rather than raw hit-rate.
      const label = entry.pnl_pct > hurdle ? 1 : 0;
      const weight = Math.min(weightCap, Math.max(weightFloor, Math.abs(entry.pnl_pct) / weightScale));
      const ts = Date.parse(entry.recorded_at || entry.closed_at || entry.deployed_at || 0) || 0;
      samples.push({ features, label, weight, ts, pnl_pct: entry.pnl_pct });
    } catch {
      // skip malformed
    }
  }

  // Chronological order — required for walk-forward validation.
  samples.sort((a, b) => a.ts - b.ts);
  return samples;
}

// ─── Standardization stats ──────────────────────────────────────

/**
 * Per-feature mean/std over a training slice. Applied inside the model
 * (see model.js setStandardization) so training and inference always see
 * the same scaling. Constant features get std=1 → standardized to 0.
 */
function computeStandardization(featArray) {
  const dim = featArray[0]?.length || FEATURE_COUNT;
  const means = new Float64Array(dim);
  const stds = new Float64Array(dim);
  const n = featArray.length;
  for (const f of featArray) {
    for (let i = 0; i < dim; i++) means[i] += f[i] ?? 0;
  }
  for (let i = 0; i < dim; i++) means[i] /= n;
  for (const f of featArray) {
    for (let i = 0; i < dim; i++) {
      const d = (f[i] ?? 0) - means[i];
      stds[i] += d * d;
    }
  }
  for (let i = 0; i < dim; i++) {
    stds[i] = Math.sqrt(stds[i] / n);
    if (stds[i] < 1e-9) stds[i] = 1;
  }
  return { means, stds };
}

// ─── Validation ─────────────────────────────────────────────────

function computeValidationMetric(model, features, labels) {
  const probs = model.batchScore(features);
  const predictions = probs.map((p) => (p >= 0.5 ? 1 : 0));

  let correct = 0;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < labels.length; i++) {
    if (predictions[i] === labels[i]) correct++;
    if (labels[i] === 1 && predictions[i] === 1) tp++;
    if (labels[i] === 0 && predictions[i] === 1) fp++;
    if (labels[i] === 0 && predictions[i] === 0) tn++;
    if (labels[i] === 1 && predictions[i] === 0) fn++;
  }

  const accuracy = correct / labels.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

  // Rank lift — the metric that matches how the model is USED. The model is
  // a ranker blended into the policy score, not a 0.5-threshold classifier:
  // with a ~20% positive rate the majority base rate makes classification
  // accuracy structurally unbeatable, while ranking skill (do high scores
  // win more than low scores?) is exactly what raises deploy quality.
  // lift = win rate of the top-scored half minus the bottom half, in pp.
  let lift = null;
  if (labels.length >= 8) {
    const order = probs.map((_, i) => i).sort((a, b) => probs[b] - probs[a]);
    const half = Math.floor(order.length / 2);
    const winRate = (idxs) => idxs.reduce((s, i) => s + (labels[i] >= 0.5 ? 1 : 0), 0) / idxs.length;
    lift = (winRate(order.slice(0, half)) - winRate(order.slice(order.length - half))) * 100;
  }

  return {
    accuracy: Math.round(accuracy * 10000) / 100,
    precision: Math.round(precision * 100) / 100,
    recall: Math.round(recall * 100) / 100,
    f1: Math.round(f1 * 100) / 100,
    directionAccuracy: Math.round(accuracy * 10000) / 100,
    lift: lift != null ? Math.round(lift * 100) / 100 : null,
    probabilities: probs,
  };
}

function fitPnlCalibration(probabilities, pnlValues) {
  if (probabilities.length < 30 || probabilities.length !== pnlValues.length) return null;
  const meanProb = probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length;
  const meanPnl = pnlValues.reduce((sum, value) => sum + value, 0) / pnlValues.length;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const probDelta = probabilities[i] - meanProb;
    covariance += probDelta * (pnlValues[i] - meanPnl);
    variance += probDelta * probDelta;
  }
  if (variance < 1e-9) return null;
  const slope = covariance / variance;
  const intercept = meanPnl - slope * meanProb;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;

  const sortedPnl = [...pnlValues].sort((a, b) => a - b);
  const percentile = (q) => sortedPnl[Math.min(sortedPnl.length - 1, Math.floor((sortedPnl.length - 1) * q))];
  return {
    intercept,
    slope,
    min: percentile(0.05),
    max: percentile(0.95),
    samples: probabilities.length,
    source: "walk_forward_oos",
  };
}

// ─── Main training ──────────────────────────────────────────────

/**
 * Train with walk-forward validation (proper for time-ordered trade data).
 * Samples are chronological; each fold i (i >= 1) is validated by a fresh
 * model trained only on samples strictly BEFORE that fold. Shuffled k-fold
 * would leak future market state into the past (lookahead bias).
 * Returns averaged metrics across folds plus `edge` — accuracy over the
 * majority-class base rate, which is the number that actually indicates skill.
 */
export async function trainModel({ config: mlConfig, force = false } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...mlConfig };
  if (!cfg.enabled && !force) {
    return { trained: false, reason: "disabled" };
  }

  let allSamples = loadTrainingData(cfg);
  const totalLabeled = allSamples.length;
  const windowRecords = Math.max(0, Number(cfg.trainWindowRecords ?? 0));
  if (windowRecords > 0 && allSamples.length > windowRecords) {
    allSamples = allSamples.slice(-windowRecords); // chronological — keep most recent
    log("ml_trainer", `Recency window: training on last ${allSamples.length} of ${totalLabeled} labeled closes`);
  }
  const effectiveMinSamples = Math.max(Number(cfg.minSamples) || 0, FEATURE_COUNT * 3);
  if (allSamples.length < effectiveMinSamples) {
    log("ml_trainer", `Insufficient data: ${allSamples.length} samples, need ${effectiveMinSamples} for ${FEATURE_COUNT} features`);
    return { trained: false, reason: "insufficient_data", sampleCount: allSamples.length, requiredSamples: effectiveMinSamples };
  }

  // Walk-forward folds over chronological samples
  const k = Math.max(2, Math.min(cfg.kFolds, allSamples.length));
  const foldSize = Math.floor(allSamples.length / k);

  const foldMetrics = [];
  let valTotal = 0;
  let valCorrect = 0;
  let valPositives = 0;
  const oosProbabilities = [];
  const oosPnlValues = [];

  for (let fold = 1; fold < k; fold++) {
    const valStart = fold * foldSize;
    const valEnd = fold === k - 1 ? allSamples.length : valStart + foldSize;
    const trainSlice = allSamples.slice(0, valStart);
    const valSlice = allSamples.slice(valStart, valEnd);
    if (trainSlice.length < 3 || valSlice.length === 0) continue;

    const trainFeatures = trainSlice.map((s) => s.features);
    const trainLabels = new Float64Array(trainSlice.map((s) => s.label));
    const trainWeights = new Float64Array(trainSlice.map((s) => s.weight ?? 1));
    const valFeatures = valSlice.map((s) => s.features);
    const valLabels = new Float64Array(valSlice.map((s) => s.label));

    // Fresh model per fold, trained only on the past. Standardization stats
    // also come only from the training slice — no peeking at the val fold.
    const model = new LogisticRegression(FEATURE_COUNT);
    const foldStats = computeStandardization(trainFeatures);
    model.setStandardization(foldStats.means, foldStats.stds);
    const report = model.fit(trainFeatures, trainLabels, {
      lr: cfg.learningRate,
      l2: cfg.l2,
      epochs: cfg.epochs,
      batchSize: cfg.batchSize,
      validationSplit: 0, // we evaluate manually
      patience: 5,
      sampleWeights: trainWeights,
    });

    const metricWithPredictions = computeValidationMetric(model, valFeatures, valLabels);
    const { probabilities, ...metric } = metricWithPredictions;
    oosProbabilities.push(...probabilities);
    oosPnlValues.push(...valSlice.map((sample) => sample.pnl_pct));
    foldMetrics.push(metric);
    valTotal += valLabels.length;
    valCorrect += Math.round((metric.accuracy / 100) * valLabels.length);
    valPositives += Array.from(valLabels).filter((l) => l >= 0.5).length;

    log("ml_trainer", `Walk-forward fold ${fold}/${k - 1}: train n=${trainSlice.length} → val n=${valSlice.length} acc=${metric.accuracy}% f1=${metric.f1} (train: ${report.finalAccuracy?.toFixed(1) || "N/A"}%)`);
  }

  // Average metrics across folds + skill edge over the majority base rate.
  // accuracy == base rate means the model learned nothing (predicting the
  // majority class scores the same) — only `edge` > 0 indicates real signal.
  const posRate = valTotal > 0 ? valPositives / valTotal : 0.5;
  const baseRate = Math.max(posRate, 1 - posRate) * 100;
  const wfAccuracy = valTotal > 0 ? (valCorrect / valTotal) * 100 : 0;
  const avgMetric = {
    accuracy: avg(foldMetrics, "accuracy"),
    precision: avg(foldMetrics, "precision"),
    recall: avg(foldMetrics, "recall"),
    f1: avg(foldMetrics, "f1"),
    directionAccuracy: avg(foldMetrics, "directionAccuracy"),
    foldCount: foldMetrics.length,
    baseRate: Math.round(baseRate * 100) / 100,
    edge: Math.round((wfAccuracy - baseRate) * 100) / 100,
    // Out-of-sample rank lift averaged over folds that had one (>= 8 val samples).
    lift: (() => {
      const withLift = foldMetrics.filter((m) => m.lift != null);
      return withLift.length ? avg(withLift, "lift") : null;
    })(),
  };

  // Train final model on all data
  const allFeatures = allSamples.map((s) => s.features);
  const allLabels = new Float64Array(allSamples.map((s) => s.label));
  const allWeights = new Float64Array(allSamples.map((s) => s.weight ?? 1));
  const finalModel = new LogisticRegression(FEATURE_COUNT);
  const finalStats = computeStandardization(allFeatures);
  finalModel.setStandardization(finalStats.means, finalStats.stds);
  const finalReport = finalModel.fit(allFeatures, allLabels, {
    lr: cfg.learningRate,
    l2: cfg.l2,
    epochs: cfg.epochs,
    batchSize: cfg.batchSize,
    validationSplit: 0,
    patience: 5,
    sampleWeights: allWeights,
  });

  // Persist the out-of-sample metrics. cvLift (rank metric) is what gates
  // the blend lambda — it matches the model's use as a ranker. cvEdge
  // (classification accuracy vs base rate) is kept as a legacy diagnostic.
  finalModel.cvEdge = avgMetric.edge;
  finalModel.cvLift = avgMetric.lift;
  finalModel.pnlCalibration = Number(avgMetric.lift) > 0
    ? fitPnlCalibration(oosProbabilities, oosPnlValues)
    : null;

  // Save final model
  finalModel.save();

  log("ml_trainer", `Walk-forward: avg acc=${avgMetric.accuracy}% (base rate ${avgMetric.baseRate}%, edge ${avgMetric.edge}pp) rank lift=${avgMetric.lift != null ? `${avgMetric.lift}pp` : "n/a"} f1=${avgMetric.f1}. Final trained on ${allSamples.length} samples.`);

  if (cfg.saveCheckpoints) {
    saveCheckpoint(finalModel, {
      sampleCount: allSamples.length,
      kFolds: k,
      cvMetric: avgMetric,
      foldMetrics,
      timestamp: new Date().toISOString(),
    });
  }

  return {
    trained: true,
    modelGeneration: finalModel.generation,
    sampleCount: allSamples.length,
    totalLabeled,
    trainWindowRecords: windowRecords,
    folds: k,
    cv: avgMetric,
    foldMetrics,
    finalLoss: finalReport.finalLoss,
    finalAccuracy: finalReport.finalAccuracy,
  };
}

// ─── Legacy online-update compatibility shim ───────────────────

export async function onlineUpdate(_perf) {
  // Production models are promoted only after chronological validation in
  // trainModel(). A one-sample mutation would make the persisted validation
  // metrics and the blend weight stale immediately.
  return { updated: false, reason: "batch_validation_required" };
}

// ─── Blend lambda ───────────────────────────────────────────────

export function computeBlendLambda(valMetric, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lambda = cfg.currentLambda || 0.1;

  if (!valMetric) return lambda;

  // Gate on out-of-sample EDGE over the majority base rate, not raw accuracy —
  // with imbalanced labels, "accuracy > 55%" is often just the base rate.
  const edge = valMetric.edge ?? ((valMetric.accuracy || 50) - (valMetric.baseRate ?? 50));
  if (edge > 3) {
    lambda = Math.min(0.7, lambda + 0.05);
  } else if (edge < 0) {
    lambda = Math.max(0.1, lambda - 0.05);
  }

  return Math.round(lambda * 100) / 100;
}

function avg(arr, key) {
  if (!arr.length) return 0;
  const sum = arr.reduce((a, b) => a + (b[key] || 0), 0);
  return Math.round(sum / arr.length * 100) / 100;
}

// ─── Checkpoint ─────────────────────────────────────────────────

function saveCheckpoint(model, metadata) {
  if (!existsSync(CHECKPOINT_DIR)) {
    mkdirSync(CHECKPOINT_DIR, { recursive: true });
  }

  const gen = String(model.generation).padStart(6, "0");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `checkpoint-gen${gen}-${timestamp}.json`;
  const filepath = join(CHECKPOINT_DIR, filename);

  const blob = {
    type: "logistic_regression",
    inputDim: model.inputDim,
    weights: Array.from(model.weights),
    bias: model.bias,
    generation: model.generation,
    totalSamples: model.totalSamples,
    pnlCalibration: model.pnlCalibration,
    metadata,
  };

  writeFileSync(filepath, JSON.stringify(blob, null, 2));
  log("ml_trainer", `Saved checkpoint: ${filename}`);
}

export { loadTrainingData, DEFAULT_CONFIG };
