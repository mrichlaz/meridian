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
  kFolds: 5,            // Fix #4: k-fold cross-validation
  saveCheckpoints: true,
};

// ─── Data loading ───────────────────────────────────────────────

function loadTrainingData() {
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
  for (const entry of perfEntries) {
    if (typeof entry.pnl_pct !== "number") continue;
    if (!entry.signal_snapshot && typeof entry.fee_tvl_ratio !== "number") continue;

    try {
      const features = extractFromPerformance(entry);
      const label = entry.pnl_pct > 0 ? 1 : 0;
      samples.push({ features, label, pnl_pct: entry.pnl_pct });
    } catch {
      // skip malformed
    }
  }

  return samples;
}

function shuffledIndices(n) {
  const arr = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

  return {
    accuracy: Math.round(accuracy * 10000) / 100,
    precision: Math.round(precision * 100) / 100,
    recall: Math.round(recall * 100) / 100,
    f1: Math.round(f1 * 100) / 100,
    directionAccuracy: Math.round(accuracy * 10000) / 100,
  };
}

// ─── Main training ──────────────────────────────────────────────

/**
 * Train with k-fold cross-validation.
 * For each fold, trains a fresh model on k-1 folds, evaluates on held-out fold.
 * Returns averaged metrics across all folds.
 */
export async function trainModel({ config: mlConfig, force = false } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...mlConfig };
  if (!cfg.enabled && !force) {
    return { trained: false, reason: "disabled" };
  }

  const allSamples = loadTrainingData();
  if (allSamples.length < cfg.minSamples) {
    log("ml_trainer", `Insufficient data: ${allSamples.length} samples, need ${cfg.minSamples}`);
    return { trained: false, reason: "insufficient_data", sampleCount: allSamples.length };
  }

  // Determine k (folds): at most kFolds, at least 2, at most sampleCount
  const k = Math.max(2, Math.min(cfg.kFolds, allSamples.length));
  const indices = shuffledIndices(allSamples.length);
  const foldSize = Math.floor(allSamples.length / k);

  const foldMetrics = [];
  const foldLossHistories = [];

  for (let fold = 0; fold < k; fold++) {
    // Split into train/val for this fold
    const valStart = fold * foldSize;
    const valEnd = fold === k - 1 ? allSamples.length : valStart + foldSize;
    const valFoldIdx = indices.slice(valStart, valEnd);
    const trainFoldIdx = [
      ...indices.slice(0, valStart),
      ...indices.slice(valEnd),
    ];

    const trainFeatures = trainFoldIdx.map((i) => allSamples[i].features);
    const trainLabels = new Float64Array(trainFoldIdx.map((i) => allSamples[i].label));
    const valFeatures = valFoldIdx.map((i) => allSamples[i].features);
    const valLabels = new Float64Array(valFoldIdx.map((i) => allSamples[i].label));

    // Fresh model per fold
    const model = new LogisticRegression(FEATURE_COUNT);
    const report = model.fit(trainFeatures, trainLabels, {
      lr: cfg.learningRate,
      l2: cfg.l2,
      epochs: cfg.epochs,
      batchSize: cfg.batchSize,
      validationSplit: 0, // we evaluate manually
      patience: 5,
    });

    const metric = computeValidationMetric(model, valFeatures, valLabels);
    foldMetrics.push(metric);
    if (report.lossHistory?.length) foldLossHistories.push(report.lossHistory);

    log("ml_trainer", `Fold ${fold + 1}/${k}: acc=${metric.accuracy}% f1=${metric.f1} (train: ${report.finalAccuracy?.toFixed(1) || "N/A"}%)`);
  }

  // Average metrics across folds
  const avgMetric = {
    accuracy: avg(foldMetrics, "accuracy"),
    precision: avg(foldMetrics, "precision"),
    recall: avg(foldMetrics, "recall"),
    f1: avg(foldMetrics, "f1"),
    directionAccuracy: avg(foldMetrics, "directionAccuracy"),
    foldCount: k,
  };

  // Train final model on all data
  const allFeatures = allSamples.map((s) => s.features);
  const allLabels = new Float64Array(allSamples.map((s) => s.label));
  const finalModel = new LogisticRegression(FEATURE_COUNT);
  const finalReport = finalModel.fit(allFeatures, allLabels, {
    lr: cfg.learningRate,
    l2: cfg.l2,
    epochs: cfg.epochs,
    batchSize: cfg.batchSize,
    validationSplit: 0,
    patience: 5,
  });

  // Save final model
  finalModel.save();

  log("ml_trainer", `CV: ${k}-fold avg acc=${avgMetric.accuracy}% f1=${avgMetric.f1}. Final trained on all ${allSamples.length} samples.`);

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
    folds: k,
    cv: avgMetric,
    foldMetrics,
    finalLoss: finalReport.finalLoss,
    finalAccuracy: finalReport.finalAccuracy,
  };
}

// ─── Online update (single sample after each close) ─────────────

export async function onlineUpdate(perf) {
  try {
    const features = extractFromPerformance(perf);
    const model = LogisticRegression.load();
    if (!model) return { updated: false, reason: "no_model" };

    const label = (perf.pnl_pct || 0) > 0 ? 1 : 0;
    model.trainBatch([features], new Float64Array([label]), 0.005, 0.0001);
    model.save();

    return { updated: true, generation: model.generation };
  } catch (err) {
    log("ml_trainer", `Online update failed: ${err.message}`);
    return { updated: false, error: err.message };
  }
}

// ─── Blend lambda ───────────────────────────────────────────────

export function computeBlendLambda(valMetric, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lambda = cfg.currentLambda || 0.1;

  if (!valMetric) return lambda;

  const acc = valMetric.accuracy || 50;
  if (acc > 55) {
    lambda = Math.min(0.7, lambda + 0.05);
  } else if (acc < 45) {
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
    metadata,
  };

  writeFileSync(filepath, JSON.stringify(blob, null, 2));
  log("ml_trainer", `Saved checkpoint: ${filename}`);
}

export { loadTrainingData, DEFAULT_CONFIG };
