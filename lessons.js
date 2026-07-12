/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { getSharedLessonsForPrompt, pushHiveLesson, pushHivePerformanceEvent } from "./hivemind.js";

import { PATHS } from "./utils/paths.js";
import { config, reloadScreeningThresholds, THRESHOLD_SCHEMA, getThresholdSpec } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = PATHS.userConfig;

const LESSONS_FILE = PATHS.lessons;
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
  "entry_mcap",
  "entry_tvl",
  "entry_volume",
];
const MAX_MANUAL_LESSON_LENGTH = 400;
const PERFORMANCE_REJECTS_FILE = PATHS.performanceRejects;
const PERFORMANCE_REJECTS_LIMIT = 200;

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

function buildSignalSnapshot(perf) {
  const snapshot = { ...(perf.signal_snapshot || {}) };
  if (perf.base_mint && snapshot.base_mint == null) snapshot.base_mint = perf.base_mint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && perf[field] != null) {
      snapshot[field] = perf[field];
    }
  }
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
  const data = load();

  // One performance record per position: the external-close backfill (state
  // sync in getMyPositions) and a later close_position call on the same
  // vanished position would otherwise both record, double-counting the
  // deploy in pool-memory cooldown/win-rate math.
  if (perf.position && data.performance.some((p) => p.position === perf.position)) {
    log("lessons", `Performance for position ${String(perf.position).slice(0, 12)} already recorded — skipping duplicate`);
    return;
  }

  // ── Validate before doing any computation that could be polluted by
  //    bad data. Bad records go to a quarantine log, not into lessons.
  const validation = validatePerformanceRecord(perf);
  if (!validation.valid) {
    quarantinePerformanceRecord(perf, validation.reason);
    log("lessons_warn", `Rejected performance record for ${perf.pool_name || perf.pool}: ${validation.reason}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const signalSnapshot = buildSignalSnapshot(perf);
  const entry = {
    ...perf,
    signal_snapshot: signalSnapshot,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  // Derive and store a lesson
  const lesson = derivePerformanceLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);
  if (lesson) {
    void pushHiveLesson(lesson);
  }

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      position: perf.position,
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      fees_earned_usd: perf.fees_earned_usd,
      fees_earned_sol: perf.fees_earned_sol,
      fee_earned_pct: perf.initial_value_usd > 0 ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100 : null,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  const closeCount = data.performance.length;

  // Threshold and quiet-hours evolution retain the established five-close
  // cadence. Darwin and ML use their existing configured cadences below.
  if (closeCount % MIN_EVOLVE_POSITIONS === 0 && config.management.evolveEnabled !== false) {
    if (config.management.thresholdEvolveEnabled !== false) {
      const result = evolveThresholds(data.performance, config);
      if (result?.changes && Object.keys(result.changes).length > 0) {
        reloadScreeningThresholds();
        log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
      }
    } else {
      log("evolve", "Threshold evolution skipped (thresholdEvolveEnabled=false)");
    }

    try {
      const qResult = evolveQuietHours(data.performance, config);
      if (qResult) {
        log("evolve", `Quiet hours evolved: "${qResult.from}" → "${qResult.to}" (${qResult.detail})`);
      }
    } catch (err) {
      log("evolve", `Quiet-hours evolution failed (non-fatal): ${err.message}`);
    }

  }

  const darwinEvery = Math.max(1, Math.round(Number(config.darwin?.recalcEvery) || MIN_EVOLVE_POSITIONS));
  if (config.darwin?.enabled && closeCount % darwinEvery === 0) {
    const { recalculateWeights } = await import("./signal-weights.js");
    const wResult = recalculateWeights(data.performance, config);
    if (wResult.changes.length > 0) {
      log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
    }
  }

  const mlTrainEvery = Math.max(1, Math.round(Number(config.ml?.trainEvery) || MIN_EVOLVE_POSITIONS));
  if (config.ml?.enabled && closeCount % mlTrainEvery === 0) {
    try {
      const { onModelTrained } = await import("./ml/emotions.js");
      const { trainModel } = await import("./ml/trainer.js");
      const { invalidateBlendLambda } = await import("./ml/inference.js");
      const trainResult = await trainModel({ config: config.ml });
      if (trainResult.trained) {
        invalidateBlendLambda();
        onModelTrained(trainResult);
        const lossText = Number.isFinite(trainResult.finalLoss) ? trainResult.finalLoss.toFixed(4) : "N/A";
        log("evolve", `ML: validated retrain on ${trainResult.sampleCount} samples, loss=${lossText}`);
      }
    } catch (mlErr) {
      log("ml_error", `ML training failed: ${mlErr.message}`);
    }
  }

  // Update emotions on position close
  try {
    const { onPositionClosed } = await import("./ml/emotions.js");
    onPositionClosed(entry);
  } catch {}

  void pushHivePerformanceEvent({
    ...entry,
    base_mint: perf.base_mint || null,
    fees_earned_sol: perf.fees_earned_sol || 0,
    eventId: `close:${perf.position}:${entry.recorded_at}`,
  });

}

// ─── Performance record validation (3A) ─────────────────────────

/**
 * Validate a performance record before it enters the learning system.
 * Returns `{ valid: true }` or `{ valid: false, reason: "..." }`.
 *
 * Catches:
 *  - missing required identifiers
 *  - non-finite numeric fields
 *  - SOL/USD unit-mixed records (e.g. final_value_usd = 2 for a 2 SOL close)
 *  - absurd close pnl (<= -90%) without an explicit stop-loss reason
 *  - obviously inverted records (final > 2× initial + 2× fees, etc.)
 */
export function validatePerformanceRecord(perf) {
  if (!perf || typeof perf !== "object") {
    return { valid: false, reason: "record is not an object" };
  }
  if (!perf.position || typeof perf.position !== "string") {
    return { valid: false, reason: "missing position address" };
  }
  if (!perf.pool || typeof perf.pool !== "string") {
    return { valid: false, reason: "missing pool address" };
  }
  if (!perf.pool_name || typeof perf.pool_name !== "string") {
    return { valid: false, reason: "missing pool name" };
  }
  if (!perf.strategy || !["spot", "curve", "bid_ask"].includes(perf.strategy)) {
    return { valid: false, reason: `invalid strategy ${perf.strategy}` };
  }

  // All numeric fields must be finite numbers
  const numericFields = [
    "initial_value_usd", "final_value_usd", "fees_earned_usd",
    "amount_sol", "bin_step", "minutes_held", "minutes_in_range",
  ];
  for (const field of numericFields) {
    if (perf[field] != null && !Number.isFinite(Number(perf[field]))) {
      return { valid: false, reason: `${field} is not a finite number` };
    }
  }

  // initial_value_usd must be > 0 (anything else is unsalvageable for PnL)
  if (!Number.isFinite(Number(perf.initial_value_usd)) || Number(perf.initial_value_usd) <= 0) {
    return { valid: false, reason: "initial_value_usd must be > 0" };
  }

  // final_value_usd must be >= 0 (negative close value is nonsensical)
  if (perf.final_value_usd != null && Number(perf.final_value_usd) < 0) {
    return { valid: false, reason: "final_value_usd is negative" };
  }

  // fees_earned_usd must be >= 0
  if (perf.fees_earned_usd != null && Number(perf.fees_earned_usd) < 0) {
    return { valid: false, reason: "fees_earned_usd is negative" };
  }

  // minutes_held / minutes_in_range sanity
  if (perf.minutes_held != null) {
    const held = Number(perf.minutes_held);
    if (held < 0) {
      return { valid: false, reason: "minutes_held is negative" };
    }
    if (perf.minutes_in_range != null && Number(perf.minutes_in_range) > held) {
      return { valid: false, reason: "minutes_in_range > minutes_held" };
    }
  }

  // SOL/USD unit mix — when a SOL-sized value is written into a USD field
  // e.g. final_value_usd = 2 for a 2 SOL close. Only flag on bigger sizes to
  // avoid false positives on very small dust positions.
  if (
    Number.isFinite(Number(perf.initial_value_usd)) &&
    Number.isFinite(Number(perf.final_value_usd)) &&
    Number.isFinite(Number(perf.amount_sol)) &&
    Number(perf.initial_value_usd) >= 20 &&
    Number(perf.amount_sol) >= 0.25 &&
    Number(perf.final_value_usd) > 0 &&
    Number(perf.final_value_usd) <= Number(perf.amount_sol) * 2
  ) {
    return { valid: false, reason: "suspected SOL/USD unit mismatch on final_value_usd" };
  }

  // Inverted-record check: final value cannot exceed initial + fees by more
  // than 10× (otherwise something is clearly off). This catches fat-finger
  // entries that would skew evolution.
  if (
    Number.isFinite(Number(perf.initial_value_usd)) &&
    Number.isFinite(Number(perf.final_value_usd)) &&
    Number.isFinite(Number(perf.fees_earned_usd))
  ) {
    const maxPlausibleFinal =
      Number(perf.initial_value_usd) * 10 + Number(perf.fees_earned_usd) + 1;
    if (Number(perf.final_value_usd) > maxPlausibleFinal) {
      return { valid: false, reason: "final_value_usd is implausibly large (>10× initial + fees)" };
    }
  }

  // Derive PnL for the next two checks
  const pnl_pct = Number(perf.initial_value_usd) > 0
    ? (((Number(perf.final_value_usd) + Number(perf.fees_earned_usd || 0)) - Number(perf.initial_value_usd)) / Number(perf.initial_value_usd)) * 100
    : 0;
  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  if (
    Number.isFinite(pnl_pct) &&
    Number(perf.initial_value_usd) >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss")
  ) {
    return { valid: false, reason: `absurd closed PnL ${pnl_pct.toFixed(2)}% without stop-loss reason` };
  }

  return { valid: true };
}

function loadRejects() {
  if (!fs.existsSync(PERFORMANCE_REJECTS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(PERFORMANCE_REJECTS_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveRejects(rejects) {
  try {
    fs.writeFileSync(PERFORMANCE_REJECTS_FILE, JSON.stringify(rejects, null, 2));
  } catch (e) {
    log("lessons_warn", `Failed to write ${PERFORMANCE_REJECTS_FILE}: ${e.message}`);
  }
}

function quarantinePerformanceRecord(perf, reason) {
  const rejects = loadRejects();
  rejects.push({
    rejected_at: new Date().toISOString(),
    reason,
    position: perf?.position,
    pool: perf?.pool,
    pool_name: perf?.pool_name,
    initial_value_usd: perf?.initial_value_usd,
    final_value_usd: perf?.final_value_usd,
    fees_earned_usd: perf?.fees_earned_usd,
    amount_sol: perf?.amount_sol,
    strategy: perf?.strategy,
    pnl_pct: perf?.pnl_pct,
    close_reason: perf?.close_reason,
  });
  // Cap the quarantine log so the file doesn't grow without bound.
  if (rejects.length > PERFORMANCE_REJECTS_LIMIT) {
    rejects.splice(0, rejects.length - PERFORMANCE_REJECTS_LIMIT);
  }
  saveRejects(rejects);
}

export function getPerformanceRejects(limit = 20) {
  const rejects = loadRejects();
  return rejects.slice(-limit).reverse();
}

export function clearPerformanceRejects() {
  saveRejects([]);
  return { cleared: true };
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
export function derivePerformanceLesson(perf) {
  const tags = [];
  const feeYieldPct = perf.initial_value_usd > 0
    ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
    : 0;

  // Categorize outcome
  const outcome = perf.pnl_pct >= 5 ? "good"
    : (perf.pnl_pct >= 0 && feeYieldPct >= 2) ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct >= -5 ? "poor"
    : "bad";

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
    perf.entry_mcap != null ? `entry_mcap=${perf.entry_mcap}` : null,
    perf.exit_mcap != null ? `exit_mcap=${perf.exit_mcap}` : null,
  ].filter(Boolean).join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  } else if (outcome === "poor") {
    rule = `UNDERPERFORMED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
    tags.push("underperformed", perf.strategy);
  }

  if (!rule) return null;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const positiveEvidence =
    feeYieldPct >= 1 ||
    (perf.fees_earned_usd || 0) >= 3 ||
    perf.pnl_pct >= 3;
  const negativeEvidence =
    perf.pnl_pct <= -5 ||
    perf.range_efficiency <= 30 ||
    closeReasonText.includes("out of range") ||
    closeReasonText.includes("oor") ||
    closeReasonText.includes("low yield") ||
    closeReasonText.includes("volume");

  let confidence = 0.35;
  if (outcome === "good") {
    confidence = positiveEvidence ? 0.82 : 0.22;
  } else if (outcome === "bad") {
    confidence = negativeEvidence ? 0.88 : 0.45;
  } else if (outcome === "poor") {
    confidence = negativeEvidence ? 0.68 : 0.32;
  }

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    sourceType: "performance",
    confidence: Math.round(confidence * 100) / 100,
    context,
    pnl_pct: perf.pnl_pct,
    fees_earned_usd: perf.fees_earned_usd,
    initial_value_usd: perf.initial_value_usd,
    range_efficiency: perf.range_efficiency,
    close_reason: perf.close_reason,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * Uses a centralized `THRESHOLD_SCHEMA` (see config.js) so we only ever
 * touch keys that actually exist in the live config. The legacy
 * `maxVolatility` / `minFeeTvlRatio` keys are no longer referenced.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
// Evolve learns from the last N closes only. Full-history learning meant a
// month of trades under an OLD rule regime (different stops/exits/strategy)
// kept dominating the statistics long after the rules changed — thresholds
// were being fit to a distribution that no longer exists. ~200 records is a
// few days at typical trade rates: current-regime data, still enough for
// stable quantiles.
const EVOLVE_WINDOW_RECORDS = 200;

export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;
  perfData = perfData.slice(-EVOLVE_WINDOW_RECORDS);

  // Use robust subsets/statistics instead of fragile edge values (e.g. min
  // winner pnl = 0.0%). This keeps evolution from ratcheting thresholds lower
  // just because one tiny/noisy winner or one odd TVL record exists.
  const winners = perfData.filter((p) => p.pnl_pct > 0);
  const meaningfulWinners = perfData.filter((p) => Number(p.pnl_pct) >= 1);
  const losers  = perfData.filter((p) => p.pnl_pct < -5);

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes   = {};
  const rationale = {};

  const quantile = (values, q) => {
    const sorted = values.filter(isFiniteNum).map(Number).sort((a, b) => a - b);
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return sorted[base + 1] !== undefined
      ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
      : sorted[base];
  };

  // ── 1. minFeeActiveTvlRatio ────────────────────────────────────
  // Raise the floor if low-fee pools consistently underperform. Lower the
  // floor if winners are mostly above the current floor (room to relax).
  {
    const spec = getThresholdSpec("minFeeActiveTvlRatio");
    if (spec) {
      const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
      const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
      const current    = config[spec.section][spec.field];

      if (current != null && Number.isFinite(Number(current))) {
        // Tighten — losers cluster at low fees
        if (loserFees.length >= 3) {
          const loserFeeP75 = quantile(loserFees, 0.75);
          if (loserFeeP75 != null && loserFeeP75 < Number(current) * 1.35) {
            const target = loserFeeP75 * 1.15;
            const proposed = clamp(nudge(Number(current), target, spec.step), spec.min, spec.max);
            const rounded = Number(proposed.toFixed(spec.decimals));
            if (rounded > Number(current)) {
              changes.minFeeActiveTvlRatio = rounded;
              rationale.minFeeActiveTvlRatio =
                `Loser fee/aTVL 75th percentile was ${loserFeeP75.toFixed(4)} — raised floor from ${current} → ${rounded}`;
            }
          }
        }

        // Relax — winners span comfortably above the current floor
        if (winnerFees.length >= 3) {
          const winnerFeeP25 = quantile(winnerFees, 0.25);
          if (winnerFeeP25 != null && winnerFeeP25 > Number(current) * 1.6) {
            const target = winnerFeeP25 * 0.9;
            const proposed = clamp(nudge(Number(current), target, spec.step), spec.min, spec.max);
            const rounded = Number(proposed.toFixed(spec.decimals));
            if (rounded < Number(current) && !changes.minFeeActiveTvlRatio) {
              changes.minFeeActiveTvlRatio = rounded;
              rationale.minFeeActiveTvlRatio =
                `Winner fee/aTVL 25th percentile was ${winnerFeeP25.toFixed(4)} — relaxed floor from ${current} → ${rounded}`;
            }
          }
        }
      }
    }
  }

  // ── 2. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const spec = getThresholdSpec("minOrganic");
    if (spec) {
      const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
      const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
      const current        = config[spec.section][spec.field];

      if (current != null && Number.isFinite(Number(current))
          && loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
        const avgLoserOrganic  = avg(loserOrganics);
        const avgWinnerOrganic = avg(winnerOrganics);
        if (avgWinnerOrganic - avgLoserOrganic >= 10) {
          const winnerOrganicP25 = quantile(winnerOrganics, 0.25);
          if (winnerOrganicP25 != null) {
            const target = Math.max(winnerOrganicP25 - 3, Number(current));
            const proposed = clamp(nudge(Number(current), target, spec.step), spec.min, spec.max);
            const rounded = Math.round(proposed);
            if (rounded > Number(current)) {
              changes.minOrganic = rounded;
              rationale.minOrganic =
                `Winner organic 25th percentile ${winnerOrganicP25.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${rounded}`;
            }
          }
        }
      }
    }
  }

  // ── 3. minTvl / maxTvl ─────────────────────────────────────────
  // If winners trend toward higher TVL → raise minTvl (or raise maxTvl).
  // If losers cluster at low TVL → also raise minTvl.
  {
    const minSpec = getThresholdSpec("minTvl");
    const maxSpec = getThresholdSpec("maxTvl");
    if (minSpec) {
      const winnerTvls = winners.map((p) => Number(p.entry_tvl ?? p.tvl)).filter(isFiniteNum);
      const loserTvls  = losers.map((p) => Number(p.entry_tvl ?? p.tvl)).filter(isFiniteNum);
      const current    = config[minSpec.section][minSpec.field];
      if (current != null && Number.isFinite(Number(current))) {
        if (loserTvls.length >= 3) {
          const loserTvlP75 = quantile(loserTvls, 0.75);
          if (loserTvlP75 != null && loserTvlP75 < Number(current)) {
            const target = loserTvlP75 * 1.1;
            const proposed = clamp(nudge(Number(current), target, minSpec.step), minSpec.min, minSpec.max);
            const rounded = Math.round(proposed);
            if (rounded > Number(current)) {
              changes.minTvl = rounded;
              rationale.minTvl = `Loser TVL 75th percentile was $${loserTvlP75.toFixed(0)} — raised from $${current} → $${rounded}`;
            }
          }
        }
        if (winnerTvls.length >= 3 && !changes.minTvl) {
          const winnerTvlP25 = quantile(winnerTvls, 0.25);
          if (winnerTvlP25 != null && winnerTvlP25 > Number(current) * 1.5) {
            const target = winnerTvlP25 * 0.9;
            const proposed = clamp(nudge(Number(current), target, minSpec.step), minSpec.min, minSpec.max);
            const rounded = Math.round(proposed);
            if (rounded < Number(current)) {
              changes.minTvl = rounded;
              rationale.minTvl = `Winner TVL 25th percentile was $${winnerTvlP25.toFixed(0)} — relaxed from $${current} → $${rounded}`;
            }
          }
        }
      }
    }
    if (maxSpec) {
      const winnerTvls = winners.map((p) => Number(p.entry_tvl ?? p.tvl)).filter(isFiniteNum);
      const loserTvls  = losers.map((p) => Number(p.entry_tvl ?? p.tvl)).filter(isFiniteNum);
      const current    = config[maxSpec.section][maxSpec.field];
      if (current != null && Number.isFinite(Number(current))) {
        if (loserTvls.length >= 3) {
          const loserTvlP90 = quantile(loserTvls, 0.9);
          if (loserTvlP90 != null && loserTvlP90 > Number(current)) {
            const target = loserTvlP90 * 1.05;
            const proposed = clamp(nudge(Number(current), target, maxSpec.step), maxSpec.min, maxSpec.max);
            const rounded = Math.round(proposed);
            if (rounded > Number(current)) {
              changes.maxTvl = rounded;
              rationale.maxTvl = `Loser TVL 90th percentile was $${loserTvlP90.toFixed(0)} — raised ceiling from $${current} → $${rounded}`;
            }
          }
        }
        if (winnerTvls.length >= 3 && !changes.maxTvl) {
          const winnerTvlP90 = quantile(winnerTvls, 0.9);
          if (winnerTvlP90 != null && winnerTvlP90 < Number(current) * 0.6) {
            const target = winnerTvlP90 * 1.15;
            const proposed = clamp(nudge(Number(current), target, maxSpec.step), maxSpec.min, maxSpec.max);
            const rounded = Math.round(proposed);
            if (rounded < Number(current)) {
              changes.maxTvl = rounded;
              rationale.maxTvl = `Winner TVL 90th percentile was $${winnerTvlP90.toFixed(0)} — lowered ceiling from $${current} → $${rounded}`;
            }
          }
        }
      }
    }
  }

  // ── 4. takeProfitPct / stopLossPct ──────────────────────────────
  // If winners are clustered near current TP, lower it to capture sooner.
  // If losers exit with shallower losses, raise the stop loss (give more
  // room) so the position doesn't get stopped out prematurely.
  {
    // TP evolution only makes sense when trailing TP is OFF. With trailing on,
    // winners exit at the trailing threshold, so "winners cluster near +1-2%"
    // is an artifact of the exit rule (censored data), not market information.
    // Evolving TP toward that cluster is a self-reinforcing collapse:
    // lower TP → smaller winners → evolve lowers TP again, down to the floor.
    const tpSpec = getThresholdSpec("takeProfitPct");
    if (tpSpec && config.management?.trailingTakeProfit !== true) {
      const tpValues = meaningfulWinners
        .map((p) => Number(p.pnl_pct))
        .filter(isFiniteNum)
        .filter((v) => v >= 1);
      const current = config[tpSpec.section][tpSpec.field];
      if (current != null && tpValues.length >= 3) {
        const tpP25 = quantile(tpValues, 0.25);
        if (tpP25 != null && tpP25 < Number(current) * 0.6) {
          const target = Math.max(tpP25 * 0.9, tpSpec.min);
          const proposed = clamp(nudge(Number(current), target, tpSpec.step), tpSpec.min, tpSpec.max);
          const rounded = Number(proposed.toFixed(tpSpec.decimals));
          if (rounded < Number(current)) {
            changes.takeProfitPct = rounded;
            rationale.takeProfitPct = `Winner PnL 25th percentile was ${tpP25.toFixed(1)}% — lowered TP from ${current}% → ${rounded}%`;
          }
        }
      }
    }
    // SL evolution: place the disaster stop just beyond the realized loss
    // tail (p90 of losses), inside the schema's sane band. The old rule read
    // shallow typical losses (p75 ≈ -0.3%) as license to move the stop toward
    // zero — that whipsaws every normal in-range wiggle. Typical losses say
    // nothing about where crash protection belongs; the tail does.
    const slSpec = getThresholdSpec("stopLossPct");
    if (slSpec) {
      const slValues = perfData
        .map((p) => Number(p.pnl_pct))
        .filter(isFiniteNum)
        .filter((v) => v < 0);
      const current = config[slSpec.section][slSpec.field];
      // Require real losses before adjusting — a book of scratch losses
      // carries no information about tail placement.
      const meaningfulLosses = slValues.filter((v) => v <= -3);
      if (current != null && slValues.length >= 5 && meaningfulLosses.length >= 3) {
        const lossP90 = quantile(slValues, 0.1); // 90th percentile of loss depth (most negative decile boundary)
        if (lossP90 != null) {
          const target = lossP90 * 1.2; // stop sits 20% beyond the realized tail
          const proposed = clamp(nudge(Number(current), target, slSpec.step), slSpec.min, slSpec.max);
          const rounded = Number(proposed.toFixed(slSpec.decimals));
          if (Math.abs(rounded - Number(current)) >= 0.5) {
            changes.stopLossPct = rounded;
            rationale.stopLossPct = `Loss-tail p90 was ${lossP90.toFixed(1)}% — moved SL from ${current}% → ${rounded}% (band ${slSpec.min}..${slSpec.max})`;
          }
        }
      }
    }
  }

  // ── 5. Concentration thresholds (maxTop10Pct / maxBundlePct / maxBotHoldersPct)
  // If any of these keeps showing up in losers, tighten it.
  for (const persistedKey of ["maxTop10Pct", "maxBundlePct", "maxBotHoldersPct"]) {
    const spec = getThresholdSpec(persistedKey);
    if (!spec) continue;
    const perfField =
      persistedKey === "maxTop10Pct" ? "entry_top10_pct" :
      persistedKey === "maxBundlePct" ? "entry_bundle_pct" :
      "entry_bot_holders_pct";
    const values = losers
      .map((p) => Number(p[perfField]))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (values.length < 3) continue;
    const current = config[spec.section][spec.field];
    if (current == null) continue;
    const loserP90 = quantile(values, 0.9);
    if (loserP90 != null && loserP90 < Number(current) * 0.7) {
      const target = loserP90 * 1.1;
      const proposed = clamp(nudge(Number(current), target, spec.step), spec.min, spec.max);
      const rounded = Math.round(proposed);
      if (rounded < Number(current) && !changes[persistedKey]) {
        changes[persistedKey] = rounded;
        rationale[persistedKey] = `Loser ${persistedKey} 90th percentile was ${loserP90.toFixed(1)}% — tightened from ${current}% → ${rounded}%`;
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to user-config.json ───────────────────────
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config object immediately
  for (const [key, val] of Object.entries(changes)) {
    const spec = getThresholdSpec(key);
    if (spec && config[spec.section] && spec.field in config[spec.section]) {
      config[spec.section][spec.field] = val;
    }
  }

  // Log a lesson summarizing the evolution
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale };
}

// ── Quiet-hours evolution ─────────────────────────────────────────
// config.policy.quietHoursUtc was seeded from a fixed analysis (08-12 and
// 20-24 UTC were the only negative 4h blocks in two independent export
// windows). Session flow shifts, so re-derive the windows from recent close
// history instead of trusting the seed forever. A block qualifies as quiet
// when it is BOTH well-sampled and net negative; at most two blocks are
// damped so evolution can never strangle most of the trading day. An empty
// result (no negative well-sampled block) clears the damping — that is the
// correct learning outcome, not a failure mode.
const QUIET_HOURS_BLOCK = 4;              // UTC hours per block
const QUIET_HOURS_MIN_PER_BLOCK = 12;     // min closes before a block can be judged
const QUIET_HOURS_MAX_BLOCKS = 2;         // never dampen more than 8h/day
const QUIET_HOURS_MIN_RECORDS = 100;      // ~2-3 days at typical trade rates

export function evolveQuietHours(perfData, config) {
  if (config.policy?.quietHoursAuto === false) return null;
  if (!perfData || perfData.length < QUIET_HOURS_MIN_RECORDS) return null;
  const records = perfData.slice(-EVOLVE_WINDOW_RECORDS);

  const blocks = new Map(); // block start hour -> { n, pnl }
  for (const p of records) {
    const pnl = Number(p.pnl_usd);
    if (!Number.isFinite(pnl)) continue;
    let deployedMs = Date.parse(p.deployed_at || "");
    if (!Number.isFinite(deployedMs)) {
      const closed = Date.parse(p.recorded_at || "");
      const held = Number(p.minutes_held);
      if (!Number.isFinite(closed) || !Number.isFinite(held)) continue;
      deployedMs = closed - held * 60000;
    }
    const start = Math.floor(new Date(deployedMs).getUTCHours() / QUIET_HOURS_BLOCK) * QUIET_HOURS_BLOCK;
    const b = blocks.get(start) || { n: 0, pnl: 0 };
    b.n++;
    b.pnl += pnl;
    blocks.set(start, b);
  }

  const quiet = [...blocks.entries()]
    .filter(([, b]) => b.n >= QUIET_HOURS_MIN_PER_BLOCK && b.pnl < 0)
    .sort((a, b) => a[1].pnl - b[1].pnl)
    .slice(0, QUIET_HOURS_MAX_BLOCKS)
    .map(([start]) => start)
    .sort((a, b) => a - b);
  const spec = quiet.map((s) => `${s}-${s + QUIET_HOURS_BLOCK}`).join(",");
  const current = String(config.policy?.quietHoursUtc ?? "");
  if (spec === current) return null;

  // Persist + apply live — same pattern as evolveThresholds above.
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }
  userConfig.policyQuietHoursUtc = spec;
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
  if (config.policy) config.policy.quietHoursUtc = spec;

  const detail = quiet.length
    ? quiet.map((s) => {
        const b = blocks.get(s);
        return `${s}-${s + QUIET_HOURS_BLOCK} UTC net $${b.pnl.toFixed(0)} over ${b.n} closes`;
      }).join(", ")
    : "no UTC block was both well-sampled and net negative — damping cleared";
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED quiet hours] "${current}" → "${spec}" — ${detail}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { from: current, to: spec, detail };
}

// Lazily resolve the threshold schema to avoid a hard import cycle
// (config.js does not depend on lessons.js; lessons.js reads the schema
// at evolution time).
let _schemaCache = null;
function requireSchema() {
  if (_schemaCache) return _schemaCache;
  const mod = requireSchemaModule();
  _schemaCache = {
    THRESHOLD_SCHEMA: mod.THRESHOLD_SCHEMA,
    getThresholdSpec: mod.getThresholdSpec,
  };
  return _schemaCache;
}

function requireSchemaModule() {
  try {
    // The require is plain CommonJS so it works inside the ESM build.
    // We avoid dynamic import to keep this path synchronous.
    return _loadConfigModule();
  } catch {
    // Last-resort empty schema so evolution is a no-op (safe) if config
    // fails to load for any reason.
    return { THRESHOLD_SCHEMA: {}, getThresholdSpec: () => null };
  }
}

import { createRequire } from "module";
const _configRequire = createRequire(import.meta.url);
let _configModule = null;
function _loadConfigModule() {
  if (_configModule) return _configModule;
  const path = _configRequire("path");
  // config.js is ESM, so we can't require() it. We use a cached import shim.
  // In practice lessons.js is loaded as ESM so we can dynamic-import, but
  // we keep the path sync via a top-level cached import in the file below.
  if (!_configModule) {
    // The real import happens at the top of the file; this branch should
    // not be reached. Defensive fallback: return empty schema.
    return { THRESHOLD_SCHEMA: {}, getThresholdSpec: () => null };
  }
  return _configModule;
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;
  const data = load();
  const isConfigChange = tags.includes("self_tune") || tags.includes("config_change");
  const lesson = {
    id: Date.now(),
    rule: safeRule,
    tags,
    outcome: "manual",
    sourceType: isConfigChange ? "config_change" : "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  };
  if (isConfigChange) {
    // Telegram +/- buttons can emit ten updates in seconds. Keep only the
    // latest audit entry per setting instead of flooding the learning feed
    // with intermediate values that are no longer active.
    const changedKey = safeRule.match(/^\[SELF-TUNED\]\s+Changed\s+([^=,\s]+)/i)?.[1]?.toLowerCase();
    const previousIndex = changedKey
      ? data.lessons.findLastIndex((item) => item.sourceType === "config_change"
        && item.rule?.match(/^\[SELF-TUNED\]\s+Changed\s+([^=,\s]+)/i)?.[1]?.toLowerCase() === changedKey)
      : -1;
    if (previousIndex >= 0) data.lessons[previousIndex] = lesson;
    else data.lessons.push(lesson);
  } else {
    data.lessons.push(lesson);
  }
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
  void pushHiveLesson(lesson);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30, includeConfigChanges = false } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (!includeConfigChanges && tag !== "config_change") lessons = lessons.filter((l) => l.sourceType !== "config_change");
  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  const learningLessons = data.lessons.filter((lesson) => lesson.sourceType !== "config_change");
  if (learningLessons.length === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = learningLessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = learningLessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? learningLessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  const shared = getSharedLessonsForPrompt({
    agentType,
    maxLessons: isAutoCycle ? 4 : 6,
  });
  if (selected.length === 0 && !shared) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));
  if (shared)             sections.push(`── HIVEMIND ──\n${shared}`);

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .sort((a, b) => String(b.recorded_at || "").localeCompare(String(a.recorded_at || "")))
    .slice(0, limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const stats = summarizePerformanceRecords(filtered);

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: stats.total_pnl_usd,
    win_rate_pct: stats.win_rate_pct,
    decisive_positions: stats.decisive_positions,
    flat_positions: stats.flat_positions,
    positions: filtered,
  };
}

export function summarizePerformanceRecords(records = []) {
  const normalized = records.filter((record) => Number.isFinite(Number(record?.pnl_usd)));
  const totalPnl = normalized.reduce((sum, record) => sum + Number(record.pnl_usd), 0);
  const totalFees = normalized.reduce((sum, record) => sum + (Number(record.fees_earned_usd) || 0), 0);
  const wins = normalized.filter((record) => Number(record.pnl_usd) > 0).length;
  const losses = normalized.filter((record) => Number(record.pnl_usd) < 0).length;
  const decisive = wins + losses;
  const pnlPctValues = normalized.map((record) => Number(record.pnl_pct)).filter(Number.isFinite);
  const rangeValues = normalized.map((record) => Number(record.range_efficiency)).filter(Number.isFinite);
  return {
    total_positions_closed: normalized.length,
    decisive_positions: decisive,
    flat_positions: normalized.length - decisive,
    wins,
    losses,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    total_fees_usd: Math.round(totalFees * 100) / 100,
    avg_pnl_pct: pnlPctValues.length
      ? Math.round((pnlPctValues.reduce((sum, value) => sum + value, 0) / pnlPctValues.length) * 100) / 100
      : null,
    avg_range_efficiency_pct: rangeValues.length
      ? Math.round((rangeValues.reduce((sum, value) => sum + value, 0) / rangeValues.length) * 10) / 10
      : null,
    win_rate_pct: decisive > 0 ? Math.round((wins / decisive) * 100) : null,
  };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  return {
    ...summarizePerformanceRecords(p),
    total_lessons: data.lessons.length,
  };
}
