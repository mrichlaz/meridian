/**
 * Logistic Regression Model (pure JS, no dependencies)
 *
 * Trains via mini-batch SGD with L2 regularization and balanced
 * class weighting. Exports/imports as JSON.
 *
 * Architecture:
 *   Input (74-dim) → weights (74) + bias → sigmoid → [0, 1]
 *
 * Total parameters: 75
 * Inference: single dot product + sigmoid (~0.001ms)
 * Training: closed-form gradient, converges reliably with <100 samples
 *
 * Why this over a deep network:
 *   - Pwnagotchi runs A2C with ~3K params on a Pi Zero. We don't need
 *     depth — the 74 hand-crafted features already encode the domain
 *     knowledge. A linear model on top is interpretable, fast, and
 *     learns correctly with gradient descent (unlike the random-search
 *     stub that was here before).
 *   - Logistic regression has a convex loss surface — it always converges
 *     to the global optimum. No hyperparameter tuning needed.
 *   - The sigmoid output IS a probability, directly usable as a score.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { PATHS } from "../utils/paths.js";
import { FEATURE_COUNT } from "./features.js";

const MODEL_FILE = PATHS.mlModel || `${PATHS.data}/ml/ml-model.json`;

// ─── Logistic Regression ────────────────────────────────────────

class LogisticRegression {
  constructor(inputDim = FEATURE_COUNT) {
    this.inputDim = inputDim;
    this.weights = new Float64Array(inputDim); // zeros
    this.bias = 0;
    this.generation = 0;
    this.totalSamples = 0;
    this.trainingLoss = [];
  }

  // ─── Forward pass ─────────────────────────────────────────

  /**
   * Predict probability for a single feature vector.
   * Returns value in [0, 1].
   */
  score(features) {
    let z = this.bias;
    for (let i = 0; i < this.inputDim; i++) {
      z += this.weights[i] * features[i];
    }
    return sigmoid(z);
  }

  /**
   * Batch predict.
   */
  batchScore(featuresArray) {
    return featuresArray.map((f) => this.score(f));
  }

  /**
   * Predict expected PnL (in percentage terms) from the model's
   * probability. Higher score → higher expected PnL.
   *
   * This is a rough calibration — the real relationship is learned
   * from training data. Initially returns linear interpolation.
   */
  predictPnl(features) {
    const prob = this.score(features);
    // Map [0, 1] → [-20%, +30%] linearly
    return -20 + prob * 50;
  }

  // ─── Training ─────────────────────────────────────────────

  /**
   * Train on one batch using SGD with L2 regularization.
   *
   * @param {Array<Float64Array>} features — batch of feature vectors
   * @param {Float64Array} labels — 0 or 1 (1 = profitable position)
   * @param {number} lr — learning rate
   * @param {number} l2 — L2 regularization strength
   * @returns {{ loss: number, accuracy: number }}
   */
  trainBatch(features, labels, lr = 0.01, l2 = 0.001) {
    const n = features.length;
    if (n === 0) return { loss: 0, accuracy: 0 };

    // Gradient accumulators
    const dw = new Float64Array(this.inputDim);
    let db = 0;
    let totalLoss = 0;
    let correct = 0;

    for (let i = 0; i < n; i++) {
      const y = labels[i];
      const yHat = this.score(features[i]);

      // Binary cross-entropy loss
      const eps = 1e-10;
      totalLoss += -(y * Math.log(yHat + eps) + (1 - y) * Math.log(1 - yHat + eps));

      // Accuracy
      const predicted = yHat >= 0.5 ? 1 : 0;
      if (predicted === Math.round(y)) correct++;

      // Gradient: (yHat - y) * x_i
      const error = yHat - y;
      for (let j = 0; j < this.inputDim; j++) {
        dw[j] += error * features[i][j];
      }
      db += error;
    }

    // Average + L2 regularization
    const invN = 1 / n;
    for (let j = 0; j < this.inputDim; j++) {
      dw[j] = dw[j] * invN + l2 * this.weights[j];
      this.weights[j] -= lr * dw[j];
    }
    this.bias -= lr * db * invN;

    this.generation++;
    this.totalSamples += n;

    const avgLoss = totalLoss / n;
    const accuracy = correct / n;

    this.trainingLoss.push({ loss: avgLoss, accuracy });
    if (this.trainingLoss.length > 100) this.trainingLoss.shift();

    return { loss: avgLoss, accuracy };
  }

  /**
   * Full training with multiple epochs and early stopping.
   *
   * @param {Array<Float64Array>} features — all training features
   * @param {Float64Array} labels — binary labels (1 = profitable)
   * @param {Object} opts
   * @returns {Object} training report
   */
  fit(features, labels, opts = {}) {
    const {
      lr = 0.01,
      l2 = 0.001,
      epochs = 20,
      batchSize = 16,
      validationSplit = 0.2,
      patience = 5,
    } = opts;

    const n = features.length;
    if (n < 5) return { trained: false, reason: `need ≥5 samples, got ${n}` };

    // Shuffle indices
    const indices = shuffledIndices(n);
    const valSize = Math.floor(n * validationSplit);
    const trainIdx = indices.slice(0, n - valSize);
    const valIdx = valSize > 0 ? indices.slice(-valSize) : [];

    // Class weights for imbalanced data
    const posCount = Array.from(labels).filter((l) => l >= 0.5).length;
    const posWeight = posCount > 0 && posCount < n
      ? (n - posCount) / posCount
      : 1.0;

    // Weighted learning rate per sample
    const sampleLr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sampleLr[i] = labels[i] >= 0.5 ? lr * Math.min(posWeight, 3.0) : lr;
    }

    let bestValLoss = Infinity;
    let bestWeights = null;
    let bestBias = 0;
    let patienceCounter = 0;
    const lossHistory = [];

    for (let epoch = 0; epoch < epochs; epoch++) {
      // Shuffle training indices each epoch
      const shuffledTrain = shuffleArray([...trainIdx]);
      let epochLoss = 0;
      let epochAcc = 0;
      let batchCount = 0;

      for (let b = 0; b < shuffledTrain.length; b += batchSize) {
        const batchIdx = shuffledTrain.slice(b, b + batchSize);
        const batchFeatures = batchIdx.map((i) => features[i]);
        const batchLabels = new Float64Array(batchIdx.map((i) => labels[i]));

        // Per-sample learning rate (class-weighted)
        const batchLr = batchIdx.reduce((sum, i) => sum + sampleLr[i], 0) / batchIdx.length;

        const { loss, accuracy } = this.trainBatch(
          batchFeatures, batchLabels, batchLr, l2,
        );
        epochLoss += loss;
        epochAcc += accuracy;
        batchCount++;
      }

      epochLoss /= batchCount;
      epochAcc /= batchCount;
      lossHistory.push({ epoch, loss: epochLoss, accuracy: epochAcc });

      // Validation
      if (valIdx.length > 0) {
        const valFeat = valIdx.map((i) => features[i]);
        const valLab = new Float64Array(valIdx.map((i) => labels[i]));
        const { loss: valLoss } = this.trainBatch(valFeat, valLab, 0, 0); // eval only, lr=0
        // Undo the gradient update from eval
        if (bestWeights) {
          this.weights = new Float64Array(bestWeights);
          this.bias = bestBias;
        }

        if (valLoss < bestValLoss) {
          bestValLoss = valLoss;
          bestWeights = new Float64Array(this.weights);
          bestBias = this.bias;
          patienceCounter = 0;
        } else {
          patienceCounter++;
          if (patienceCounter >= patience) break;
        }
      } else {
        // No validation split — just keep best training loss
        if (epochLoss < bestValLoss) {
          bestValLoss = epochLoss;
          bestWeights = new Float64Array(this.weights);
          bestBias = this.bias;
        }
      }
    }

    // Restore best weights
    if (bestWeights) {
      this.weights = bestWeights;
      this.bias = bestBias;
    }

    return {
      trained: true,
      samples: n,
      epochs: lossHistory.length,
      finalLoss: lossHistory[lossHistory.length - 1]?.loss || 0,
      finalAccuracy: lossHistory[lossHistory.length - 1]?.accuracy || 0,
      lossHistory,
    };
  }

  // ─── Persistence ──────────────────────────────────────────

  save(filepath = MODEL_FILE) {
    const blob = {
      type: "logistic_regression",
      inputDim: this.inputDim,
      weights: Array.from(this.weights),
      bias: this.bias,
      generation: this.generation,
      totalSamples: this.totalSamples,
      trainingLoss: this.trainingLoss.slice(-20),
    };
    writeFileSync(filepath, JSON.stringify(blob, null, 2));
  }

  static load(filepath = MODEL_FILE) {
    if (!existsSync(filepath)) return null;
    try {
      const raw = JSON.parse(readFileSync(filepath, "utf8"));
      if (raw.type !== "logistic_regression") return null;

      const m = new LogisticRegression(raw.inputDim || FEATURE_COUNT);
      m.weights = new Float64Array(raw.weights);
      m.bias = raw.bias || 0;
      m.generation = raw.generation || 0;
      m.totalSamples = raw.totalSamples || 0;
      m.trainingLoss = raw.trainingLoss || [];
      return m;
    } catch {
      return null;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function sigmoid(z) {
  // Clamp to avoid overflow
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function shuffledIndices(n) {
  const arr = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  return shuffleArray(arr);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Exports ────────────────────────────────────────────────────

export { LogisticRegression };
