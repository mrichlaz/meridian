/**
 * Personality Presets
 *
 * Inspired by Pwnagotchi's personality system. Each preset tunes the
 * exploration/exploitation balance, risk appetite baseline, and
 * behavior modifiers for different market conditions.
 *
 * Personalities are stored in data/ml/personality.json and can be
 * switched at runtime via CLI or Telegram.
 *
 * Each personality defines:
 *   - riskAppetite   — base level (0=conservative, 1=aggressive)
 *   - explorationRate — 0=exploit known, 1=explore new
 *   - holdStyle      — "flip" | "swing" | "hold"
 *   - decisionThreshold — base strictness (0=only A+, 1=accept B-)
 *   - entropyBeta    — exploration bonus in training (higher=more explore)
 *   - sizeMultiplier — position size relative to default (0.3-1.5)
 *   - emotionInfluence — how much emotions override personality (0-1)
 *   - description    — human-readable explanation
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { PATHS } from "../utils/paths.js";

const PERSONALITY_FILE = join(PATHS.data, "ml", "personality.json");

// ─── Built-in personalities ─────────────────────────────────────

const PREDEFINED = {
  conservative: {
    name: "conservative",
    riskAppetite: 0.25,
    explorationRate: 0.15,
    holdStyle: "hold",
    decisionThreshold: 0.2,
    entropyBeta: 0.005,
    sizeMultiplier: 0.6,
    emotionInfluence: 0.2,
    description: "Minimum risk: only high-confidence pools, small positions, long holds. Best in bear/sideways markets.",
  },

  balanced: {
    name: "balanced",
    riskAppetite: 0.5,
    explorationRate: 0.3,
    holdStyle: "swing",
    decisionThreshold: 0.4,
    entropyBeta: 0.02,
    sizeMultiplier: 1.0,
    emotionInfluence: 0.5,
    description: "Default: moderate risk, balanced exploration/exploitation, medium holds. Good for stable markets.",
  },

  aggressive: {
    name: "aggressive",
    riskAppetite: 0.8,
    explorationRate: 0.2,
    holdStyle: "flip",
    decisionThreshold: 0.6,
    entropyBeta: 0.01,
    sizeMultiplier: 1.3,
    emotionInfluence: 0.3,
    description: "High risk: quick flips, larger positions, exploit winning patterns. Best in strong bull markets.",
  },

  explorer: {
    name: "explorer",
    riskAppetite: 0.4,
    explorationRate: 0.8,
    holdStyle: "swing",
    decisionThreshold: 0.5,
    entropyBeta: 0.05,
    sizeMultiplier: 0.7,
    emotionInfluence: 0.7,
    description: "Learning mode: small bets across many pool types, high curiosity, rapid adaptation. For discovering new strategies.",
  },

  momentum: {
    name: "momentum",
    riskAppetite: 0.55,
    explorationRate: 0.4,
    holdStyle: "swing",
    decisionThreshold: 0.45,
    entropyBeta: 0.03,
    sizeMultiplier: 1.1,
    emotionInfluence: 0.6,
    description: "Trend-following: rides winning streaks, exits quickly on reversals. Emotion-driven adaptation.",
  },

  survivor: {
    name: "survivor",
    riskAppetite: 0.1,
    explorationRate: 0.05,
    holdStyle: "hold",
    decisionThreshold: 0.15,
    entropyBeta: 0.0,
    sizeMultiplier: 0.3,
    emotionInfluence: 0.1,
    description: "Maximum caution. Only deploy when all signals align perfectly. For rebuilding after significant losses.",
  },
};

// ─── Persistence ─────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(PERSONALITY_FILE)) {
    const defaults = {
      active: "balanced",
      activeSince: null,
    };
    saveConfig(defaults);
    return defaults;
  }

  try {
    return JSON.parse(readFileSync(PERSONALITY_FILE, "utf8"));
  } catch {
    return { active: "balanced", activeSince: null };
  }
}

function saveConfig(data) {
  const dir = join(PATHS.data, "ml");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PERSONALITY_FILE, JSON.stringify(data, null, 2));
}

// ─── API ────────────────────────────────────────────────────────

/**
 * Get the currently active personality preset.
 */
export function getActive() {
  const cfg = loadConfig();
  const preset = PREDEFINED[cfg.active] || PREDEFINED.balanced;
  return { ...preset, activeSince: cfg.activeSince };
}

/**
 * Switch to a different personality.
 */
export function setActive(name) {
  if (!PREDEFINED[name]) {
    throw new Error(`Unknown personality: "${name}". Available: ${list().join(", ")}`);
  }

  const cfg = loadConfig();
  cfg.active = name;
  cfg.activeSince = new Date().toISOString();
  saveConfig(cfg);

  return getActive();
}

/**
 * List all available personalities with descriptions.
 */
export function list() {
  return Object.keys(PREDEFINED);
}

/**
 * Get a specific personality by name.
 */
export function getByName(name) {
  return PREDEFINED[name] || null;
}

/**
 * Get the prompt fragment describing the current personality
 * for injection into the LLM system prompt.
 */
export function getPersonalityPrompt() {
  const active = getActive();
  return [
    `PERSONALITY: ${active.name} — ${active.description}`,
    `risk=${fmt(active.riskAppetite)} explore=${fmt(active.explorationRate)} hold=${active.holdStyle} size=${fmt(active.sizeMultiplier)}x`,
  ].join("\n");
}

function fmt(val) {
  return Number(val).toFixed(2);
}

export { PREDEFINED };
