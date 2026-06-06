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
  learningRate: 0.01,
  l2: 0.001,
  validationSplit: 0.2,
  saveCheckpoints: true,
};

// ─── Data loading ───────────────────────────────────────────────

function loadTrainingData() {
  const lessonsFile = PATHS.lessons;
  if (!existsSync(lessonsFile)) {
    log("ml_trainer", "No lessons.json found");
    return [];
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(lessonsFile, "utf8"));
  } catch {
    return [];
  }

  const perf = Array.isArray(raw.performance) ? raw.performance : [];
  const samples = [];

  for (const entry of perf) {
    if (typeof entry.pnl_pct !== "number") continue;
    if (!entry.signal_snapshot && typeof entry.fee_tvl_ratio !== "number") continue;

    try {
      const features = extractFromPerformance(entry);
      // Binary label: profitable (1) or not (0)
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

  // Spearman rank correlation between predicted score and actual PnL
  // (approximate — compare rank order of scores vs labels)
  const spearman = 0; // placeholder; could be computed from full pnl_pct values

  return {
    accuracy: Math.round(accuracy * 10000) / 100,
    precision: Math.round(precision * 100) / 100,
    recall: Math.round(recall * 100) / 100,
    f1: Math.round(f1 * 100) / 100,
    directionAccuracy: Math.round(accuracy * 10000) / 100,
    spearman,
  };
}

// ─── Main training ──────────────────────────────────────────────

export async function trainModel({ config: mlConfig } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...mlConfig };
  if (!cfg.enabled) {
    return { trained: false, reason: "disabled" };
  }

  const allSamples = loadTrainingData();
  if (allSamples.length < cfg.minSamples) {
    log("ml_trainer", `Insufficient data: ${allSamples.length} samples, need ${cfg.minSamples}`);
    return { trained: false, reason: "insufficient_data", sampleCount: allSamples.length };
  }

  // Load or create model
  let model = LogisticRegression.load();
  if (!model) {
    log("ml_trainer", "Creating new logistic regression model");
    model = new LogisticRegression(FEATURE_COUNT);
  }

  // Shuffle and split
  const indices = shuffledIndices(allSamples.length);
  const valSize = Math.floor(allSamples.length * cfg.validationSplit);
  const trainIdx = indices.slice(0, allSamples.length - valSize);
  const valIdx = valSize > 0 ? indices.slice(-valSize) : [];

  const trainFeatures = trainIdx.map((i) => allSamples[i].features);
  const trainLabels = new Float64Array(trainIdx.map((i) => allSamples[i].label));

  // Train
  const report = model.fit(trainFeatures, trainLabels, {
    lr: cfg.learningRate,
    l2: cfg.l2,
    epochs: cfg.epochs,
    batchSize: cfg.batchSize,
    validationSplit: 0,
    patience: 5,
  });

  // Validation
  let valMetric = null;
  if (valIdx.length > 0) {
    const valFeatures = valIdx.map((i) => allSamples[i].features);
    const valLabels = new Float64Array(valIdx.map((i) => allSamples[i].label));
    valMetric = computeValidationMetric(model, valFeatures, valLabels);
    log("ml_trainer", `Validation: acc=${valMetric.accuracy}% f1=${valMetric.f1} precision=${valMetric.precision} recall=${valMetric.recall}`);
  }

  // Save
  model.save();

  if (cfg.saveCheckpoints) {
    saveCheckpoint(model, {
      sampleCount: allSamples.length,
      trainSize: trainFeatures.length,
      valSize: valIdx.length,
      validation: valMetric,
      timestamp: new Date().toISOString(),
    });
  }

  log("ml_trainer", `Trained on ${trainFeatures.length} samples, final loss: ${report.finalLoss?.toFixed(4) || "N/A"}`);

  return {
    trained: true,
    modelGeneration: model.generation,
    sampleCount: allSamples.length,
    trainSize: trainFeatures.length,
    valSize: valIdx.length,
    epochs: report.epochs,
    finalLoss: report.finalLoss,
    finalAccuracy: report.finalAccuracy,
    validation: valMetric,
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
