/**
 * ML Inference — blended scoring & LLM prompt injection.
 *
 * This is the "runtime" module that plugs the trained model into
 * the screening pipeline. It:
 *
 *   1. Scores every candidate via the Actor-Critic network
 *   2. Blends ML score with the existing heuristic score (λ blending)
 *   3. Ranks candidates by blended score (optionally)
 *   4. Generates LLM prompt fragments with ML score context
 *   5. Exposes the model's prediction as a "tool" the LLM can query
 *
 * Integration point: called from tools/screening.js → getTopCandidates()
 * and from index.js → buildScreeningCycle() for the LLM prompt.
 */

import { LogisticRegression } from "./model.js";
import {
  extractFeatures,
  normalizeVector,
  FEATURE_SPEC,
  FEATURE_COUNT,
} from "./features.js";
import { getCurrentState } from "./emotions.js";
import { getActive } from "./personalities.js";
import { recallForPool } from "../pool-memory.js";
import { log } from "../logger.js";

// ─── Configuration ──────────────────────────────────────────────

let _blendLambda = null; // cached, updated when training runs
let _lastScoringTime = null;

// ─── Scoring ────────────────────────────────────────────────────

/**
 * Score a single candidate with the ML model.
 *
 * @param {Object} candidate — condensed pool from screening pipeline
 * @param {Object} [opts] — { poolMemory, signalWeights, context, emotions }
 * @returns {{ mlScore: number, heuristicScore: number, blendedScore: number, confidence: number }}
 */
export function scoreCandidate(candidate, opts = {}) {
  // Extract and normalize features
  const raw = extractFeatures({
    candidate,
    poolMemory: opts.poolMemory,
    signalWeights: opts.signalWeights,
    studyData: opts.studyData,
    context: opts.context,
  });
  const features = normalizeVector(raw);

  // Heuristic score (same formula as existing scoreCandidate in screening.js)
  const feeTvl = Number(candidate.fee_active_tvl_ratio || 0);
  const organic = Number(candidate.organic_score || 0);
  const volume = Number(candidate.volume_window || 0);
  const holders = Number(candidate.holders || 0);
  const heuristicScore = feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;

  // ML score
  let mlScore = 0.5; // neutral default
  let criticValue = 0;
  let modelUsed = false;

  try {
    const model = LogisticRegression.load();
    if (model) {
      mlScore = model.score(features);
      criticValue = model.predictPnl(features);
      modelUsed = true;
    }
  } catch (err) {
    log("ml_inference", `Scoring failed: ${err.message}`);
  }

  // Emotional modifier from personality + emotions
  const emo = opts.emotions || getCurrentState();
  const personality = getActive();
  const emotionalBoost = computeEmotionalBoost(mlScore, emo, personality);

  // Blended score
  const lambda = getBlendLambda();
  const blendedScore = lambda * mlScore * emotionalBoost + (1 - lambda) * normalizeHeuristic(heuristicScore);

  _lastScoringTime = new Date().toISOString();

  return {
    mlScore: round(mlScore),
    criticValue: round(criticValue),
    heuristicScore: round(heuristicScore),
    blendedScore: round(blendedScore),
    // Confidence = predictiveness (can the model actually separate?) times
    // blended score range — a model that always outputs 0.5 has zero confidence.
    confidence: modelUsed
      ? round((getBlendLambda() * (Math.abs(mlScore - 0.5) * 2)) + 0.05, 2)
      : 0,
    modelUsed,
    lambda,
  };
}

/**
 * Score and rank an array of candidates.
 * Returns sorted by blendedScore descending, with ML metadata attached.
 */
export function scoreAndRank(candidates, opts = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const emotions = opts.emotions || getCurrentState();

  const scored = candidates.map((candidate, i) => {
    let poolMemory = null;
    if (candidate.pool || candidate.pool_address) {
      poolMemory = recallForPool(candidate.pool || candidate.pool_address);
    }

    const result = scoreCandidate(candidate, {
      ...opts,
      poolMemory,
      emotions,
    });

    return {
      ...candidate,
      _ml: result,
      _rank: i,
    };
  });

  // Sort by blendedScore descending
  scored.sort((a, b) => b._ml.blendedScore - a._ml.blendedScore);

  return scored;
}

// ─── LLM Prompt Injection ───────────────────────────────────────

/**
 * Generate an ML context block for injection into the SCREENER prompt.
 * Shows the LLM what the model predicts about each candidate.
 */
export function getMlPromptContext(scoredCandidates) {
  if (!scoredCandidates || scoredCandidates.length === 0) return "";

  const lines = [];
  const emo = getCurrentState();
  const personality = getActive();

  lines.push("── ML PREDICTIONS ──");
  const lambda = getBlendLambda();
  lines.push(`Personality: ${personality.name} | λ: ${lambda} | Confidence: ${fmt(emo.confidence)}`);

  for (let i = 0; i < Math.min(scoredCandidates.length, 5); i++) {
    const c = scoredCandidates[i];
    const ml = c._ml || {};
    const label = ml.blendedScore >= 0.6 ? "STRONG"
                : ml.blendedScore >= 0.45 ? "MODERATE"
                : ml.blendedScore >= 0.3 ? "WEAK"
                : "LOW";
    lines.push(
      `  ${c.name || c.pool_address?.slice(0, 8) || "?"}: ` +
      `ml=${fmt(ml.mlScore)} blend=${fmt(ml.blendedScore)} heur=${fmt(ml.heuristicScore)} ` +
      `(critic=${fmt(ml.criticValue)}%) [${label}]`,
    );
  }

  // Top candidate analysis
  if (scoredCandidates.length > 0 && scoredCandidates[0]._ml) {
    const top = scoredCandidates[0];
    const ml = top._ml;
    lines.push("");
    lines.push(`Top candidate by ML: ${top.name || top.pool_address}`);
    if (ml.modelUsed) {
      lines.push(`  ML score: ${fmt(ml.mlScore)} (λ=${ml.lambda} → blend=${fmt(ml.blendedScore)})`);
      lines.push(`  Expected PnL (critic): ${fmt(ml.criticValue)}%`);
      lines.push(`  Model confidence: ${fmt(emo.confidence)}`);
    } else {
      lines.push("  No trained model — using heuristic scoring only.");
    }
  }

  return lines.join("\n");
}

/**
 * Generate the emotional context fragment for the system prompt.
 * Combines emotion state + personality into a short text block.
 */
export function getEmotionalPromptContext() {
  const emo = getCurrentState();
  const personality = getActive();

  const lines = [];

  // Mood
  if (emo.satisfaction > 0.7 && emo.confidence > 0.6) {
    lines.push("MOOD: optimistic — recent positions performing well");
  } else if (emo.boredom > 0.6) {
    lines.push("MOOD: restless — idle too long, prefer action");
  } else if (emo.riskAppetite < 0.3) {
    lines.push("MOOD: cautious — recent losses warrant stricter filtering");
  } else if (emo.curiosity > 0.7) {
    lines.push("MOOD: curious — explore new pool types");
  } else {
    lines.push("MOOD: neutral");
  }

  lines.push([
    `EMOTION: conf=${fmt(emo.confidence)} risk=${fmt(emo.riskAppetite)}`,
    `bore=${fmt(emo.boredom)} curio=${fmt(emo.curiosity)} sat=${fmt(emo.satisfaction)}`,
  ].join(" "));

  lines.push(`PERSONALITY: ${personality.name} — ${personality.description}`);

  if (emo.streak.current === "win" && emo.streak.wins >= 2) {
    lines.push(`STREAK: ${emo.streak.wins} consecutive wins`);
  } else if (emo.streak.current === "loss" && emo.streak.losses >= 1) {
    lines.push(`STREAK: ${emo.streak.losses} consecutive loss(es)`);
  }

  return lines.join("\n");
}

// ─── Feature Debug ──────────────────────────────────────────────

/**
 * Debug helper: show which features most influenced a score.
 * Useful for the `/ml features` CLI command.
 */
export function explainScore(candidate, opts = {}) {
  const raw = extractFeatures({ candidate, ...opts });
  const features = normalizeVector(raw);
  const model = LogisticRegression.load();

  const featureNames = FEATURE_SPEC;
  const importance = [];

  // Approximate feature importance by perturbing each feature
  // and measuring score change
  if (model) {
    const baseScore = model.score(features);
    for (let i = 0; i < FEATURE_COUNT; i++) {
      const perturbed = new Float64Array(features);
      perturbed[i] = 1 - perturbed[i]; // flip
      const newScore = model.score(perturbed);
      importance.push({
        index: i,
        name: featureNames[i],
        value: features[i],
        rawValue: raw[i],
        delta: Math.abs(newScore - baseScore),
      });
    }
    importance.sort((a, b) => b.delta - a.delta);
  }

  return {
    baseScore: model ? model.score(features) : null,
    normalizedFeatures: Array.from(features).slice(0, 20).map((v, i) => ({
      name: featureNames[i],
      value: round(v),
      raw: typeof raw[i] === "number" ? round(raw[i]) : raw[i],
    })),
    topInfluences: importance.slice(0, 10).map((inf) => ({
      name: inf.name,
      value: round(inf.value),
      raw: round(inf.rawValue),
      impact: round(inf.delta),
    })),
  };
}

// ─── Lambda Management ──────────────────────────────────────────

/**
 * Get the current blend lambda (weight of ML vs heuristic).
 * Starts low (0.1) and ramps up only when the model shows it can
 * separate winners from losers — measured by score spread across
 * prediction buckets.
 */
export function getBlendLambda() {
  if (_blendLambda != null) return _blendLambda;

  try {
    const model = LogisticRegression.load();
    if (model && model.totalSamples > 10) {
      const p = model.predictiveness || 0;
      _blendLambda = 0.1 + Math.min(0.4, p * 0.5);
    }
  } catch {}

  return _blendLambda || 0.1;
}

/** Invalidate the cached blend lambda — call after training. */
export function invalidateBlendLambda() {
  _blendLambda = null;
}

/**
 * Update the blend lambda (called after training validates the model).
 */
export function setBlendLambda(lambda) {
  _blendLambda = Math.max(0.05, Math.min(0.9, lambda));
}

// ─── Helpers ────────────────────────────────────────────────────

function round(v, decimals = 3) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Number(v.toFixed(decimals));
}

function fmt(val) {
  if (val == null || !Number.isFinite(val)) return "0.00";
  return val.toFixed(2);
}

/**
 * Normalize heuristic score (which can be up to 20,000+) to [0, 1].
 */
function normalizeHeuristic(score) {
  // Cap at ~18,000 which would be fee_tvl_ratio=20 and organic=100
  return Math.min(1, Math.max(0, score / 15000));
}

/**
 * Emotional boost: amplifies or dampens the ML score based on
 * current emotional state and personality.
 */
function computeEmotionalBoost(mlScore, emo, personality) {
  if (!emo || !personality) return 1.0;

  // Base: personality defines the exploration/exploitation balance
  const base = 1.0;

  // Risk appetite adjustment
  // High risk appetite → slightly boost scores (more optimistic)
  // Low risk appetite → slightly dampen scores (more conservative)
  const riskAdj = (emo.riskAppetite - 0.5) * 0.2;

  // Confidence adjustment
  // Higher confidence → less boost needed (model already sharp)
  const confAdj = (0.5 - emo.confidence) * 0.1;

  // Boredom adjustment
  // When bored, lower the threshold slightly for borderline candidates
  // But only if the candidate is at least decent (mlScore > 0.3)
  let boreAdj = 0;
  if (mlScore > 0.3 && emo.boredom > 0.5) {
    boreAdj = (emo.boredom - 0.5) * 0.3;
  }

  const total = base + (riskAdj + confAdj + boreAdj) * personality.emotionInfluence;
  return Math.max(0.7, Math.min(1.3, total));
}

/**
 * Try to load signal weights from the Darwinian system.
 */
export { _blendLambda, _lastScoringTime, invalidateBlendLambda };
