/**
 * ML CLI — subcommands for managing the deep learning system.
 *
 * Commands:
 *   ml status        — model info, emotion state, personality
 *   ml train         — force a training run
 *   ml score <pool>  — score a specific pool
 *   ml features      — show top feature influences
 *   ml emotion       — emotion state details
 *   ml personality   — list/switch personalities
 *   ml reset         — reset model weights
 */

import { log } from "../logger.js";
import { LogisticRegression } from "./model.js";
import { trainModel, onlineUpdate, loadTrainingData } from "./trainer.js";
import { scoreCandidate, scoreAndRank, explainScore, getMlPromptContext, getBlendLambda, setBlendLambda } from "./inference.js";
import { getCurrentState, resetEmotions, getEmotionTrend, getEmotionPrompt } from "./emotions.js";
import { getActive, setActive, list as listPersonalities } from "./personalities.js";
import { getTopCandidates } from "../tools/screening.js";
import { normalizeVector } from "./features.js";

export async function handleMlCommand(args, config) {
  const sub = args[0] || "status";

  switch (sub) {
    case "status":
      return mlStatus(config);
    case "train":
      return mlTrain(config, args.slice(1));
    case "score":
      return mlScore(args[1], config);
    case "features":
      return mlFeatures(args[1], config);
    case "emotion":
      return mlEmotion(args.slice(1));
    case "personality":
      return mlPersonality(args.slice(1));
    case "reset":
      return mlReset();
    case "stress-test":
      return mlStressTest(config, args.slice(1));
    default:
      return `Unknown ml subcommand: ${sub}. Available: status, train, score, features, emotion, personality, reset, stress-test`;
  }
}

// ─── Commands ───────────────────────────────────────────────────

function mlStatus(config) {
  const model = LogisticRegression.load();
  const emo = getCurrentState();
  const personality = getActive();
  const lambda = getBlendLambda();
  const data = loadTrainingData();

  const lines = [];
  lines.push("── ML Status ──");

  // Model
  if (model) {
    lines.push(`Model: gen ${model.generation}, ${model.totalSamples} samples`);
    const recentLoss = model.trainingLoss?.[model.trainingLoss.length - 1];
    if (recentLoss) {
      lines.push(`  Last loss: ${recentLoss.total?.toFixed(4) || "N/A"}`);
    }
  } else {
    lines.push("Model: not trained yet");
  }

  // Data
  lines.push(`Training data: ${data.length} labeled positions`);

  // Blend
  lines.push(`Blend λ: ${lambda} (${Math.round(lambda * 100)}% ML / ${Math.round((1 - lambda) * 100)}% heuristic)`);

  // Emotion
  lines.push("");
  lines.push(`── Emotion ──`);
  lines.push(`Confidence:     ${bar(emo.confidence)}`);
  lines.push(`Risk appetite:  ${bar(emo.riskAppetite)}`);
  lines.push(`Boredom:        ${bar(emo.boredom)}`);
  lines.push(`Curiosity:      ${bar(emo.curiosity)}`);
  lines.push(`Satisfaction:   ${bar(emo.satisfaction)}`);

  if (emo.streak.current) {
    lines.push(`Streak: ${emo.streak.current === "win" ? "🟢" : "🔴"} ${emo.streak[emo.streak.current + "s"]}x ${emo.streak.current}`);
  }

  // Personality
  lines.push("");
  lines.push(`── Personality ──`);
  lines.push(`Active: ${personality.name} — ${personality.description}`);
  lines.push(`Available: ${listPersonalities().join(", ")}`);

  // Config
  const mlCfg = config?.ml || {};
  lines.push("");
  lines.push(`── Config ──`);
  lines.push(`Enabled: ${mlCfg.enabled !== false ? "yes" : "no"}`);
  lines.push(`Train every: ${mlCfg.trainEvery || 5} positions`);
  lines.push(`Min samples: ${mlCfg.minSamples || 10}`);

  return lines.join("\n");
}

async function mlTrain(config, args) {
  const mlCfg = config?.ml || {};
  const emotionState = getCurrentState();
  const result = await trainModel({ config: mlCfg, emotionState });

  if (!result.trained) {
    return `Training skipped — ${result.reason || "unknown"}`;
  }

  const lines = [];
  lines.push(`Trained on ${result.trainSize} samples (${result.valSize} validation)`);
  lines.push(`Samples: ${result.sampleCount} total`);
  if (result.finalLoss) {
    lines.push(`Final loss: ${result.finalLoss.totalLoss?.toFixed(4) || "N/A"}`);
  }
  if (result.validation) {
    lines.push(`Validation: Spearman=${result.validation.spearman?.toFixed(3) || "N/A"} DirectionAcc=${result.validation.directionAccuracy?.toFixed(1) || "N/A"}%`);
  }

  return lines.join("\n");
}

async function mlScore(poolAddress, config) {
  if (!poolAddress) return "Usage: ml score <pool_address>";

  // Fetch candidates and find the target
  const candidates = await getTopCandidates({ limit: 20 });
  const target = candidates.find(
    (c) => c.pool === poolAddress || c.pool_address === poolAddress,
  );

  if (!target) {
    // Try scoring just the address with minimal data
    const result = scoreCandidate({ pool: poolAddress, pool_address: poolAddress });
    return `Pool not in top candidates. Score with minimal features: ml=${result.mlScore.toFixed(3)} blend=${result.blendedScore.toFixed(3)}`;
  }

  const result = scoreCandidate(target);
  const lines = [];
  lines.push(`── ${target.name || poolAddress} ──`);
  lines.push(`ML score:       ${result.mlScore.toFixed(3)}`);
  lines.push(`Heuristic:      ${result.heuristicScore.toFixed(0)}`);
  lines.push(`Blended (λ=${result.lambda}): ${result.blendedScore.toFixed(3)}`);
  lines.push(`Critic (exp PnL): ${result.criticValue.toFixed(2)}%`);
  lines.push(`Model used:   ${result.modelUsed ? "yes" : "no"}`);

  // Show top features
  const explanation = explainScore(target);
  if (explanation.topInfluences?.length > 0) {
    lines.push("");
    lines.push("Top feature influences:");
    for (const inf of explanation.topInfluences.slice(0, 5)) {
      lines.push(`  ${inf.name}: raw=${inf.raw} impact=${inf.impact}`);
    }
  }

  return lines.join("\n");
}

async function mlFeatures(poolAddress, config) {
  if (!poolAddress) return "Usage: ml features <pool_address>";

  const candidates = await getTopCandidates({ limit: 20 });
  const target = candidates.find(
    (c) => c.pool === poolAddress || c.pool_address === poolAddress,
  );

  if (!target) return `Pool ${poolAddress} not found in top candidates`;

  const explanation = explainScore(target);
  if (!explanation || !explanation.topInfluences?.length) {
    return "No model loaded — cannot analyze features";
  }

  const lines = [];
  lines.push(`── Feature Analysis: ${target.name || poolAddress} ──`);
  lines.push(`Base score: ${explanation.baseScore?.toFixed(3) || "N/A"}`);
  lines.push("");
  lines.push("Top 10 features by influence:");

  for (let i = 0; i < explanation.topInfluences.length; i++) {
    const inf = explanation.topInfluences[i];
    lines.push(`  ${i + 1}. ${inf.name}  value=${inf.value}  raw=${inf.raw}  Δscore=${inf.impact}`);
  }

  return lines.join("\n");
}

async function mlEmotion(args) {
  const sub = args[0];
  if (sub === "trend") {
    const trend = getEmotionTrend(30);
    if (!trend) return "No emotion history yet";
    const lines = [];
    lines.push(`── Emotion Trend (${trend.samples} samples) ──`);
    lines.push(trend.summary);
    return lines.join("\n");
  }

  if (sub === "prompt") {
    return getEmotionPrompt();
  }

  if (sub === "reset") {
    resetEmotions();
    return "Emotions reset to defaults";
  }

  // Default: show current state
  const emo = getCurrentState();
  const lines = [];
  lines.push("── Current Emotion State ──");
  lines.push(`Confidence:     ${bar(emo.confidence)}`);
  lines.push(`Risk appetite:  ${bar(emo.riskAppetite)}`);
  lines.push(`Boredom:        ${bar(emo.boredom)}`);
  lines.push(`Curiosity:      ${bar(emo.curiosity)}`);
  lines.push(`Satisfaction:   ${bar(emo.satisfaction)}`);
  lines.push(`Cycles: ${emo.cycles.total} total, ${emo.cycles.deployed} deployed, ${emo.cycles.skipped} skipped`);
  lines.push(`Streak: ${emo.streak.current || "none"} (wins:${emo.streak.wins} losses:${emo.streak.losses})`);

  return lines.join("\n");
}

async function mlPersonality(args) {
  const sub = args[0];

  if (sub === "list") {
    const names = listPersonalities();
    const { getByName } = await import("./personalities.js");
    const lines = ["── Available Personalities ──"];
    for (const name of names) {
      const p = getByName(name);
      if (p) lines.push(`  ${name}: ${p.description}`);
    }
    return lines.join("\n");
  }

  if (sub === "set") {
    const name = args[1];
    if (!name) return "Usage: ml personality set <name>";
    try {
      setActive(name);
      return `Switched to ${name} personality`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  // Default: show active
  const active = getActive();
  return `Active: ${active.name} — ${active.description}\nAvailable: ${listPersonalities().join(", ")}\nSwitch: ml personality set <name>`;
}

function mlReset() {
  try {
    const path = PATHS?.mlModel;
    if (path && existsSync(path)) {
      unlinkSync(path);
      setBlendLambda(0.1);
      return "Model weights reset. Next training cycle will create a fresh model.";
    }
    return "No model file found to reset";
  } catch (err) {
    return `Reset failed: ${err.message}`;
  }
}

import { unlinkSync, existsSync } from "fs";
import { PATHS } from "../utils/paths.js";


/**
 * Stress-test: score all current candidates and show the distribution.
 */
async function mlStressTest(config, args) {
  const limit = parseInt(args[0]) || 30;
  const candidates = await getTopCandidates({ limit });

  if (!candidates || candidates.length === 0) {
    return "No candidates available for stress test";
  }

  const scored = scoreAndRank(candidates);

  const lines = [];
  lines.push(`── Stress Test: ${scored.length} candidates ──`);
  lines.push("");

  // Score distribution
  const mlScores = scored.map((c) => c._ml.mlScore);
  const blends = scored.map((c) => c._ml.blendedScore);
  const heuristics = scored.map((c) => c._ml.heuristicScore);

  const mlMean = mean(mlScores);
  const mlStd = std(mlScores, mlMean);
  const blendMean = mean(blends);

  lines.push(`ML scores:   mean=${mlMean.toFixed(3)} σ=${mlStd.toFixed(3)} min=${Math.min(...mlScores).toFixed(3)} max=${Math.max(...mlScores).toFixed(3)}`);
  lines.push(`Blended:     mean=${blendMean.toFixed(3)}`);
  lines.push(`Heuristic:   mean=${mean(heuristics).toFixed(0)}`);

  // Bucket distribution
  const buckets = { strong: 0, moderate: 0, weak: 0 };
  for (const s of scored) {
    if (s._ml.mlScore >= 0.7) buckets.strong++;
    else if (s._ml.mlScore >= 0.4) buckets.moderate++;
    else buckets.weak++;
  }
  lines.push(`Distribution: ${buckets.strong} strong, ${buckets.moderate} moderate, ${buckets.weak} weak`);

  // Top 5
  lines.push("");
  lines.push("Top 5 by blended score:");
  for (let i = 0; i < Math.min(5, scored.length); i++) {
    const c = scored[i];
    lines.push(`  ${i + 1}. ${c.name || "?"}: ml=${c._ml.mlScore.toFixed(3)} blend=${c._ml.blendedScore.toFixed(3)} heur=${c._ml.heuristicScore.toFixed(0)}`);
  }

  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────

function bar(value, width = 10) {
  const filled = Math.round(value * width);
  return `${value.toFixed(2)} |${"#".repeat(filled)}${"-".repeat(width - filled)}|`;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr, meanVal) {
  const m = meanVal || mean(arr);
  const sqDiffs = arr.map((v) => (v - m) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / arr.length);
}
