/**
 * Logistic Regression Model (pure JS, no dependencies)
 *
 * Trains via mini-batch SGD with Adam optimizer, L2 regularization,
 * and proper class-weighted cross-entropy loss.
 *
 * Fix #2: Adam optimizer with momentum + adaptive learning rates
 * Fix #3: Class-weighted loss (not learning rate multipliers)
 *
 * Architecture: Input (FEATURE_COUNT) → weights + bias → sigmoid → [0, 1]
 * Feature count auto-derived from FEATURE_SPEC (currently 78 features, 79 params).
 * Inference: single dot product + sigmoid (~0.001ms)
 *
 * Why logistic regression:
 *   - Pwnagotchi runs A2C with ~3K params on a Pi Zero. 79 params on
 *     hand-crafted, domain-informed features is the right size.
 *   - Convex loss surface → always converges to global optimum.
 *   - Zero runtime dependencies — trains inline in the same Node process.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { PATHS } from "../utils/paths.js";
import { FEATURE_COUNT } from "./features.js";

const MODEL_FILE = PATHS.mlModel || `${PATHS.data}/ml/ml-model.json`;

// ─── Adam Optimizer ─────────────────────────────────────────────

/**
 * Adam (Adaptive Moment Estimation) — stateful optimizer.
 * Maintains per-parameter first/second moment estimates with
 * bias correction for mini-batch SGD.
 */
class Adam {
  constructor(dim, lr = 0.001, beta1 = 0.9, beta2 = 0.999, eps = 1e-8) {
    this.lr = lr;
    this.beta1 = beta1;
    this.beta2 = beta2;
    this.eps = eps;
    this.t = 0;

    // Weight moments
    this.m = new Float64Array(dim);   // first moment (momentum)
    this.v = new Float64Array(dim);   // second moment (RMSprop)
    // Bias moments (single scalar)
    this.mB = 0;
    this.vB = 0;
  }

  /**
   * Apply a gradient step. Modifies weights and bias in-place.
   *
   * @param {Float64Array} weights — model weights (updated in-place)
   * @param {Float64Array} dw — weight gradients
   * @param {number} db — bias gradient
   */
  step(weights, dw, db) {
    this.t++;

    // Weight update
    for (let i = 0; i < weights.length; i++) {
      this.m[i] = this.beta1 * this.m[i] + (1 - this.beta1) * dw[i];
      this.v[i] = this.beta2 * this.v[i] + (1 - this.beta2) * dw[i] * dw[i];

      const mHat = this.m[i] / (1 - this.beta1 ** this.t);
      const vHat = this.v[i] / (1 - this.beta2 ** this.t);

      weights[i] -= this.lr * mHat / (Math.sqrt(vHat) + this.eps);
    }

    // Bias update
    this.mB = this.beta1 * this.mB + (1 - this.beta1) * db;
    this.vB = this.beta2 * this.vB + (1 - this.beta2) * db * db;

    const mHatB = this.mB / (1 - this.beta1 ** this.t);
    const vHatB = this.vB / (1 - this.beta2 ** this.t);

    return this.lr * mHatB / (Math.sqrt(vHatB) + this.eps); // returns Δbias
  }
}

// ─── Logistic Regression ────────────────────────────────────────

class LogisticRegression {
  constructor(inputDim = FEATURE_COUNT) {
    this.inputDim = inputDim;
    this.weights = new Float64Array(inputDim);
    this.bias = 0;
    this.generation = 0;
    this.totalSamples = 0;
    this.trainingLoss = [];
    this.predictiveness = 0;
    // Out-of-sample skill: walk-forward accuracy minus majority base rate
    // (percentage points). Gates the ML blend lambda; null = never validated.
    this.cvEdge = null;
    this.cvLift = null;
    // Optional linear calibration fitted only from walk-forward predictions.
    // Without it, a classifier probability must not be presented as PnL.
    this.pnlCalibration = null;
    // Dataset standardization stats (see setStandardization)
    this.featureMeans = null;
    this.featureStds = null;
    // Xavier initialization: small random weights centered on zero
    // avoids all-zero symmetry that Adam + L2 can't escape
    for (let i = 0; i < inputDim; i++) {
      this.weights[i] = (Math.random() - 0.5) * 0.02;
    }
  }

  // ─── Standardization ──────────────────────────────────────
  // The pipeline's min-max normalization uses fixed universe-wide bounds
  // (e.g. mcap [0, 100M]) while real candidates cluster in the bottom few
  // percent of those ranges. Without re-centering, informative features have
  // ~zero variance, L2 pins the weights at zero, and the model collapses to
  // the intercept (every score ≈ base rate). Dataset z-scoring restores unit
  // variance so the same L2 leaves the weights learnable.

  setStandardization(means, stds) {
    this.featureMeans = means ? Float64Array.from(means) : null;
    this.featureStds = stds ? Float64Array.from(stds) : null;
  }

  _prep(features) {
    if (!this.featureMeans || !this.featureStds) return features;
    const out = new Float64Array(this.inputDim);
    for (let i = 0; i < this.inputDim; i++) {
      const std = this.featureStds[i] > 1e-9 ? this.featureStds[i] : 1;
      out[i] = ((features[i] ?? 0) - (this.featureMeans[i] ?? 0)) / std;
    }
    return out;
  }

  // ─── Forward pass ─────────────────────────────────────────

  _scorePrepped(x) {
    let z = this.bias;
    for (let i = 0; i < this.inputDim; i++) {
      z += this.weights[i] * x[i];
    }
    return sigmoid(z);
  }

  score(features) {
    return this._scorePrepped(this._prep(features));
  }

  batchScore(featuresArray) {
    return featuresArray.map((f) => this.score(f));
  }

  predictPnl(features) {
    if (!this.pnlCalibration) return null;
    const prob = this.score(features);
    const estimate = this.pnlCalibration.intercept + this.pnlCalibration.slope * prob;
    return Math.max(this.pnlCalibration.min, Math.min(this.pnlCalibration.max, estimate));
  }

  // ─── Loss computation ─────────────────────────────────────

  /**
   * Compute weighted binary cross-entropy + L2 for one sample.
   *
   * Fix #3: Class weight applied to loss, not learning rate.
   *   L = -(weight × y × log(ŷ) + (1-y) × log(1-ŷ)) + λ/2 × ||w||²
   *
   * Gradient:
   *   ∂L/∂w = (ŷ - y) × weight_modifier × x  +  λ × w
   *        where weight_modifier = posWeight if y=1 else 1.0
   *   ∂L/∂b = (ŷ - y) × weight_modifier
   */
  computeGradient(features, label, posWeight, l2, sampleWeight = 1.0) {
    // Gradient must be taken w.r.t. the same (standardized) inputs the
    // forward pass uses — z = w·x_std, so ∂z/∂w = x_std.
    const x = this._prep(features);
    const yHat = this._scorePrepped(x);
    const y = label;

    // Loss = weighted BCE + L2 (class weight × per-sample expectancy weight)
    const eps = 1e-10;
    const bce = (y > 0
      ? -posWeight * Math.log(yHat + eps)
      : -Math.log(1 - yHat + eps)) * sampleWeight;
    let l2Penalty = 0;
    for (let i = 0; i < this.inputDim; i++) {
      l2Penalty += this.weights[i] * this.weights[i];
    }
    const loss = bce + (l2 / 2) * l2Penalty;

    // Accuracy
    const predicted = yHat >= 0.5 ? 1 : 0;
    const correct = predicted === Math.round(y) ? 1 : 0;

    // Gradient of BCE term
    const error = yHat - y;
    const weightMod = (y > 0 ? posWeight : 1.0) * sampleWeight;

    const dw = new Float64Array(this.inputDim);
    for (let i = 0; i < this.inputDim; i++) {
      dw[i] = error * weightMod * x[i] + l2 * this.weights[i];
    }
    const db = error * weightMod;

    return { loss, correct, dw, db };
  }

  // ─── Training ─────────────────────────────────────────────

  /**
   * Train one batch with Adam optimizer.
   */
  trainBatch(features, labels, lr = 0.001, l2 = 0.001, posWeight = 1.0, sampleWeights = null) {
    const n = features.length;
    if (n === 0) return { loss: 0, accuracy: 0 };

    // Create optimizer if it doesn't exist or need re-init
    if (!this._adam || this._adam.lr !== lr) {
      this._adam = new Adam(this.inputDim, lr);
    }

    // Accumulate gradients across batch
    const dw = new Float64Array(this.inputDim);
    let db = 0;
    let totalLoss = 0;
    let correct = 0;

    for (let i = 0; i < n; i++) {
      const { loss, correct: c, dw: gradW, db: gradB } =
        this.computeGradient(features[i], labels[i], posWeight, l2, sampleWeights?.[i] ?? 1.0);

      totalLoss += loss;
      correct += c;
      for (let j = 0; j < this.inputDim; j++) dw[j] += gradW[j];
      db += gradB;
    }

    // Average gradients
    const invN = 1 / n;
    for (let j = 0; j < this.inputDim; j++) dw[j] *= invN;
    db *= invN;

    // Apply Adam step
    const deltaBias = this._adam.step(this.weights, dw, db);
    this.bias -= deltaBias;

    this.generation++;
    this.totalSamples += n;

    const avgLoss = totalLoss / n;
    const accuracy = correct / n;

    this.trainingLoss.push({ loss: avgLoss, accuracy });
    if (this.trainingLoss.length > 100) this.trainingLoss.shift();

    return { loss: avgLoss, accuracy };
  }

  /**
   * Full training with Adam, early stopping, and class weighting.
   */
  fit(features, labels, opts = {}) {
    const {
      lr = 0.001,
      l2 = 0.001,
      epochs = 20,
      batchSize = 16,
      validationSplit = 0.2,
      patience = 5,
      sampleWeights = null, // per-sample expectancy weights (Float64Array, aligned with features)
    } = opts;

    const n = features.length;
    if (n < 5) return { trained: false, reason: `need ≥5 samples, got ${n}` };

    // Compute class weights: inverse frequency, capped at 3.0
    // posWeight = (num negatives) / (num positives)
    // This ensures both classes contribute equally to total loss.
    const posCount = Array.from(labels).filter((l) => l >= 0.5).length;
    const posWeight = posCount > 0 && posCount < n
      ? Math.min((n - posCount) / posCount, 3.0)
      : 1.0;

    // Shuffle indices
    const indices = shuffledIndices(n);
    const valSize = Math.floor(n * validationSplit);
    const trainIdx = indices.slice(0, n - valSize);
    const valIdx = valSize > 0 ? indices.slice(-valSize) : [];

    let bestValLoss = Infinity;
    let bestWeights = null;
    let bestBias = 0;
    let patienceCounter = 0;
    const lossHistory = [];

    for (let epoch = 0; epoch < epochs; epoch++) {
      const shuffled = shuffleArray([...trainIdx]);
      let epochLoss = 0;
      let epochAcc = 0;
      let batchCount = 0;

      for (let b = 0; b < shuffled.length; b += batchSize) {
        const batchIdx = shuffled.slice(b, Math.min(b + batchSize, shuffled.length));
        const batchFeatures = batchIdx.map((i) => features[i]);
        const batchLabels = new Float64Array(batchIdx.map((i) => labels[i]));
        const batchWeights = sampleWeights
          ? new Float64Array(batchIdx.map((i) => sampleWeights[i] ?? 1))
          : null;

        const { loss, accuracy } = this.trainBatch(
          batchFeatures, batchLabels, lr, l2, posWeight, batchWeights,
        );
        epochLoss += loss;
        epochAcc += accuracy;
        batchCount++;
      }

      epochLoss /= batchCount;
      epochAcc /= batchCount;

      // Validation
      let valLoss = epochLoss; // default if no val set
      if (valIdx.length > 0) {
        valLoss = this.validate(valIdx.map((i) => features[i]),
          new Float64Array(valIdx.map((i) => labels[i])), l2, posWeight);
      }

      lossHistory.push({ epoch, trainLoss: epochLoss, trainAcc: epochAcc, valLoss });

      if (valLoss < bestValLoss) {
        bestValLoss = valLoss;
        bestWeights = new Float64Array(this.weights);
        bestBias = this.bias;
        patienceCounter = 0;
      } else {
        patienceCounter++;
        if (patienceCounter >= patience) break;
      }
    }

    // Restore best weights
    if (bestWeights) {
      this.weights = bestWeights;
      this.bias = bestBias;
    }

    // Clear adam state for next training run (fresh momentum)
    this._adam = null;

    // Compute predictiveness: fraction of predictions that are meaningfully
    // outside the neutral shrugging zone [0.35, 0.65]. A model that always
    // outputs ~0.5 has 0 predictiveness and shouldn't get blend weight.
    let outsideNeutral = 0;
    for (let i = 0; i < n; i++) {
      const s = this.score(features[i]);
      if (s < 0.35 || s > 0.65) outsideNeutral++;
    }
    this.predictiveness = n > 0 ? outsideNeutral / n : 0;

    return {
      trained: true,
      samples: n,
      posWeight,
      epochs: lossHistory.length,
      finalLoss: lossHistory[lossHistory.length - 1]?.trainLoss || 0,
      finalAccuracy: lossHistory[lossHistory.length - 1]?.trainAcc || 0,
      finalValLoss: lossHistory[lossHistory.length - 1]?.valLoss || 0,
      lossHistory,
    };
  }

  /**
   * Compute validation loss (no gradient update).
   */
  validate(features, labels, l2, posWeight) {
    let totalLoss = 0;
    for (let i = 0; i < features.length; i++) {
      const { loss } = this.computeGradient(features[i], labels[i], posWeight, l2);
      totalLoss += loss;
    }
    return totalLoss / features.length;
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
      predictiveness: this.predictiveness,
      cvEdge: this.cvEdge,
      cvLift: this.cvLift ?? null,
      pnlCalibration: this.pnlCalibration,
      featureMeans: this.featureMeans ? Array.from(this.featureMeans) : null,
      featureStds: this.featureStds ? Array.from(this.featureStds) : null,
      trainingLoss: this.trainingLoss.slice(-20),
    };
    writeFileSync(filepath, JSON.stringify(blob, null, 2));
  }

  static load(filepath = MODEL_FILE) {
    if (!existsSync(filepath)) return null;
    try {
      const raw = JSON.parse(readFileSync(filepath, "utf8"));
      if (raw.type !== "logistic_regression") return null;

      const inputDim = raw.inputDim || raw.weights?.length || FEATURE_COUNT;
      const m = new LogisticRegression(inputDim);
      m.weights = new Float64Array(inputDim);
      for (let i = 0; i < inputDim; i++) m.weights[i] = Number(raw.weights?.[i] || 0);
      m.bias = raw.bias || 0;
      m.generation = raw.generation || 0;
      m.totalSamples = raw.totalSamples || 0;
      m.predictiveness = raw.predictiveness ?? 0;
      m.cvEdge = raw.cvEdge ?? null;
      m.cvLift = raw.cvLift ?? null;
      m.pnlCalibration = raw.pnlCalibration &&
        Number.isFinite(raw.pnlCalibration.intercept) &&
        Number.isFinite(raw.pnlCalibration.slope) &&
        Number.isFinite(raw.pnlCalibration.min) &&
        Number.isFinite(raw.pnlCalibration.max)
        ? raw.pnlCalibration
        : null;
      if (Array.isArray(raw.featureMeans) && Array.isArray(raw.featureStds)) {
        m.setStandardization(raw.featureMeans, raw.featureStds);
      }
      m.trainingLoss = raw.trainingLoss || [];
      return m;
    } catch {
      return null;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function sigmoid(z) {
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

export { LogisticRegression };
