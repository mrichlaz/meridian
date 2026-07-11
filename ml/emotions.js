/**
 * Emotional / Intrinsic Motivation Layer
 *
 * Inspired by Pwnagotchi's pleasure/boredom system. Tracks emotional
 * state across cycles and modulates agent behaviour:
 *
 *   confidence   — how much the model trusts its own predictions
 *   boredom      — rises when agent skips deploy opportunities
 *   riskAppetite  — shifts with win/loss streak
 *   curiosity    — drive to explore new pool types
 *   satisfaction — derived from recent PnL performance
 *
 * These states:
 *   1. Shape the training reward signal (affects model weights)
 *   2. Modulate the LLM's decision threshold (bored → looser, confident → tighter)
 *   3. Feed into personality presets for exploration/exploitation balance
 *   4. Are persisted to data/ml/emotion-state.json between runs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { PATHS } from "../utils/paths.js";

const EMOTION_FILE = join(PATHS.data, "ml", "emotion-state.json");

// ─── Defaults ───────────────────────────────────────────────────

const DEFAULT_STATE = {
  confidence: 0.5,
  boredom: 0.3,
  riskAppetite: 0.5,
  curiosity: 0.5,
  satisfaction: 0.5,
  lastUpdated: null,
  history: [],
  cycles: {
    total: 0,
    skipped: 0,
    deployed: 0,
    closed: 0,
  },
  streak: {
    wins: 0,
    losses: 0,
    current: "", // "win" | "loss" | ""
  },
};

// ─── Persistence ─────────────────────────────────────────────────

function load() {
  if (!existsSync(EMOTION_FILE)) return { ...DEFAULT_STATE };

  try {
    const raw = JSON.parse(readFileSync(EMOTION_FILE, "utf8"));
    return {
      ...DEFAULT_STATE,
      ...raw,
      lastUpdated: raw.lastUpdated || null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function save(state) {
  const dir = join(PATHS.data, "ml");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  state.lastUpdated = new Date().toISOString();

  // Keep history to last 200 entries
  if (state.history && state.history.length > 200) {
    state.history = state.history.slice(-200);
  }

  writeFileSync(EMOTION_FILE, JSON.stringify(state, null, 2));
}

// ─── Event handlers ─────────────────────────────────────────────

/**
 * Called after the agent closes a position.
 * Adjusts confidence, satisfaction, and risk appetite based on outcome.
 */
export function onPositionClosed(perf) {
  const state = load();
  state.cycles.closed++;

  const pnlPct = perf.pnl_pct || 0;
  const efficiency = perf.range_efficiency || 50;

  // Update streak
  if (pnlPct > 0) {
    state.streak.wins++;
    state.streak.losses = 0;
    state.streak.current = "win";
  } else {
    state.streak.losses++;
    state.streak.wins = 0;
    state.streak.current = "loss";
  }

  // ─── Satisfaction ────────────────────────────
  // Maps PnL% to 0-1: -20% → 0.2, 0% → 0.5, +20% → 0.8
  const rawSat = 0.5 + (pnlPct / 40);
  state.satisfaction = clamp(ema(state.satisfaction, rawSat, 0.3), 0.1, 0.9);

  // ─── Confidence ──────────────────────────────
  // Confidence rises when model predictions match reality.
  // For now, we derive it from satisfaction + streak stability.
  if (pnlPct > 0 && efficiency > 60) {
    state.confidence = clamp(state.confidence + 0.05, 0.1, 0.9);
  } else if (pnlPct < -5) {
    state.confidence = clamp(state.confidence - 0.08, 0.1, 0.9);
  }

  // ─── Market context delta (entry → exit) ────
  // Richer emotional feedback from market movement during the hold.
  const entryMcap = perf.entry_mcap;
  const exitMcap = perf.exit_mcap;
  if (entryMcap && exitMcap && entryMcap > 0) {
    const mcapGrowth = ((exitMcap - entryMcap) / entryMcap) * 100;
    if (mcapGrowth > 50) {
      // Held through massive mcap growth — satisfaction boost even if PnL mediocre
      state.satisfaction = clamp(state.satisfaction + 0.06, 0.1, 0.9);
      state.confidence = clamp(state.confidence + 0.03, 0.1, 0.9);
    } else if (mcapGrowth < -30) {
      // Held through a dump — note it but don't penalize (could be the market)
      state.confidence = clamp(state.confidence - 0.02, 0.1, 0.9);
    }
  }

  // ─── Risk Appetite ───────────────────────────
  // Winning streaks build risk appetite; losing streaks reduce it.
  if (state.streak.wins >= 2) {
    state.riskAppetite = clamp(state.riskAppetite + 0.06, 0.1, 0.9);
  } else if (state.streak.losses >= 2) {
    state.riskAppetite = clamp(state.riskAppetite - 0.12, 0.1, 0.9);
  }

  // ─── Boredom ─────────────────────────────────
  // Reset on close — the agent did something.
  state.boredom = clamp(state.boredom - 0.1, 0.0, 0.9);

  // ─── Curiosity ───────────────────────────────
  // If we just closed a pool we've never seen before, curiosity goes up.
  const isNewPool = !state.seenPools?.includes?.(perf.pool_name);
  if (isNewPool) {
    state.curiosity = clamp(state.curiosity + 0.04, 0.1, 0.9);
    if (!state.seenPools) state.seenPools = [];
    state.seenPools.push(perf.pool_name);
    if (state.seenPools.length > 200) state.seenPools = state.seenPools.slice(-200);
  }

  recordEvent(state, "close", { pnlPct, efficiency, pool: perf.pool_name });
  save(state);

  return { ...state };
}

/**
 * Called after the screener completes one cycle (deploy OR skip).
 */
export function onScreenerCycle({ deployed, skipReason }) {
  const state = load();
  state.cycles.total++;

  if (deployed) {
    state.cycles.deployed++;
    state.boredom = clamp(state.boredom - 0.15, 0.0, 0.9);
    // Deploying into a low-confidence state → excitement
    if (state.confidence < 0.3) {
      state.confidence = clamp(state.confidence + 0.02, 0.1, 0.9);
    }
  } else {
    state.cycles.skipped++;
    // Boredom rises when we skip deployments
    const skipPenalty = skipReason === "no candidates" ? 0.10
                      : skipReason === "all filtered" ? 0.07
                      : skipReason === "llm rejected" ? 0.04
                      : 0.05;
    state.boredom = clamp(state.boredom + skipPenalty, 0.0, 0.9);
  }

  // Confidence decays slightly on skip (environment might have changed)
  if (!deployed) {
    state.confidence = clamp(state.confidence - 0.01, 0.1, 0.9);
  }

  recordEvent(state, "screen", { deployed, skipReason });
  save(state);

  return { ...state };
}

/**
 * Called after the ML model finishes training.
 * Sigifically adjusts confidence based on validation results.
 */
export function onModelTrained(trainingResult) {
  const state = load();
  const val = trainingResult?.cv || trainingResult?.validation;

  if (val) {
    const lift = Number(val.lift);
    const dirAcc = Number(val.directionAccuracy || 50);
    if (Number.isFinite(lift) && lift >= 5) {
      state.confidence = clamp(state.confidence + 0.08, 0.1, 0.9);
    } else if ((Number.isFinite(lift) && lift < 0) || dirAcc < 45) {
      state.confidence = clamp(state.confidence - 0.06, 0.1, 0.9);
    }
  }

  recordEvent(state, "train", {
    samples: trainingResult?.sampleCount,
    dirAcc: val?.directionAccuracy,
    lift: val?.lift,
  });
  save(state);

  return { ...state };
}

/**
 * Called when the model raises a new observation about performance.
 * Adjusts emotions based on structured observations.
 */
export function onObservation({ observation }) {
  const state = load();

  if (!observation) return { ...state };

  const text = observation.toLowerCase();
  if (text.includes("winning streak") || text.includes("profit streak")) {
    state.confidence = clamp(state.confidence + 0.04, 0.1, 0.9);
    state.riskAppetite = clamp(state.riskAppetite + 0.03, 0.1, 0.9);
  }
  if (text.includes("losing streak") || text.includes("loss streak")) {
    state.confidence = clamp(state.confidence - 0.05, 0.1, 0.9);
    state.riskAppetite = clamp(state.riskAppetite - 0.08, 0.1, 0.9);
    state.curiosity = clamp(state.curiosity + 0.03, 0.1, 0.9); // learn from failure
  }
  if (text.includes("new pool type") || text.includes("unexplored")) {
    state.curiosity = clamp(state.curiosity + 0.05, 0.1, 0.9);
  }

  save(state);
  return { ...state };
}

/**
 * Emit current emotional state as a text prompt fragment
 * for the LLM. This gives the reasoning layer awareness of
 * the agent's "mood".
 */
export function getEmotionPrompt() {
  const state = load();
  const lines = [];

  const { confidence, boredom, riskAppetite, curiosity, satisfaction } = state;

  // Mood label
  if (satisfaction > 0.7 && confidence > 0.6) {
    lines.push("MOOD: optimistic — recent positions performing well, proceed with confidence");
  } else if (boredom > 0.6) {
    lines.push("MOOD: restless — idle too long, prefer action over further analysis");
  } else if (riskAppetite < 0.3) {
    lines.push("MOOD: cautious — recent losses warrant stricter candidate filtering");
  } else if (curiosity > 0.7) {
    lines.push("MOOD: curious — explore new pool types, avoid repetition");
  } else {
    lines.push("MOOD: neutral — balanced evaluation");
  }

  // Numeric state
  lines.push(`EMOTION: confidence=${fmt(confidence)} risk=${fmt(riskAppetite)} boredom=${fmt(boredom)} curiosity=${fmt(curiosity)} satisfaction=${fmt(satisfaction)}`);

  // Streak
  if (state.streak.current === "win" && state.streak.wins >= 2) {
    lines.push(`STREAK: ${state.streak.wins} consecutive wins`);
  } else if (state.streak.current === "loss" && state.streak.losses >= 2) {
    lines.push(`STREAK: ${state.streak.losses} consecutive losses`);
  }

  return lines.join("\n");
}

/**
 * Get behavioral modifier for the screening cycle.
 *
 * Returns an object that can be read by index.js to adjust:
 *   - Decision threshold (how good a candidate must be to deploy)
 *   - Position sizing (how much to deploy per position)
 *   - Exploration rate (willingness to try borderline candidates)
 */
export function getBehavioralModifiers() {
  const state = load();

  return {
    // 0 = strict (only perfect candidates), 1 = loose (accept borderline)
    decisionThreshold: clamp(1.0 - state.confidence + state.boredom * 0.5, 0.1, 1.0),

    // Position size multiplier: risk appetite × confidence
    // Low appetite/low confidence → smaller positions
    sizeMultiplier: clamp(state.riskAppetite * (0.5 + state.confidence * 0.5), 0.3, 1.2),

    // 0 = exploit known patterns, 1 = explore new ones
    explorationRate: clamp(state.boredom * 0.7 + state.curiosity * 0.3, 0.1, 0.9),

    // Raw emotional state
    ...getCurrentState(),
  };
}

/**
 * Get just the current state object (no modifier computation).
 */
export function getCurrentState() {
  const s = load();
  return {
    confidence: s.confidence,
    boredom: s.boredom,
    riskAppetite: s.riskAppetite,
    curiosity: s.curiosity,
    satisfaction: s.satisfaction,
    streak: { ...s.streak },
    cycles: { ...s.cycles },
  };
}

/**
 * Reset all emotions to defaults (useful when switching strategies).
 */
export function resetEmotions() {
  const state = { ...DEFAULT_STATE, lastUpdated: new Date().toISOString() };
  save(state);
  return { ...state };
}

/**
 * Force-set a specific emotion value (for debugging / manual override).
 */
export function setEmotion(field, value) {
  if (!DEFAULT_STATE.hasOwnProperty(field)) {
    throw new Error(`Unknown emotion field: ${field}`);
  }
  const state = load();
  state[field] = clamp(value, 0.0, 1.0);
  save(state);
  return { ...state };
}

/**
 * Get a summary of emotion trends over the last N cycles.
 */
export function getEmotionTrend(cycles = 20) {
  const state = load();
  const history = (state.history || []).slice(-cycles);

  if (history.length === 0) return null;

  const first = history[0];
  const last = history[history.length - 1];

  const fmt = (v) => typeof v === "number" ? v.toFixed(2) : "N/A";

  return {
    samples: history.length,
    confidence: { from: first.confidence, to: last.confidence, delta: last.confidence - first.confidence },
    satisfaction: { from: first.satisfaction, to: last.satisfaction, delta: last.satisfaction - first.satisfaction },
    riskAppetite: { from: first.riskAppetite, to: last.riskAppetite, delta: last.riskAppetite - first.riskAppetite },
    summary: [
      `confidence: ${fmt(first.confidence)} → ${fmt(last.confidence)}`,
      `satisfaction: ${fmt(first.satisfaction)} → ${fmt(last.satisfaction)}`,
      `risk appetite: ${fmt(first.riskAppetite)} → ${fmt(last.riskAppetite)}`,
    ].join(" | "),
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Exponential moving average.
 */
function ema(current, next, alpha) {
  return current * (1 - alpha) + next * alpha;
}

function fmt(val, decimals = 2) {
  return Number(val).toFixed(decimals);
}

function recordEvent(state, type, data) {
  if (!state.history) state.history = [];
  state.history.push({
    type,
    timestamp: new Date().toISOString(),
    confidence: state.confidence,
    satisfaction: state.satisfaction,
    riskAppetite: state.riskAppetite,
    boredom: state.boredom,
    curiosity: state.curiosity,
    ...data,
  });
}

// ─── Exports ────────────────────────────────────────────────────

export { load };
