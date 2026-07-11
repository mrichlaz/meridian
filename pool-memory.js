/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";
import { PATHS } from "./utils/paths.js";

const POOL_MEMORY_FILE = PATHS.poolMemory;
const MAX_NOTE_LENGTH = 280;

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
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
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    const db = JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
    // Self-heal aggregates on every read. win_rate was briefly persisted as a
    // 0-1 fraction while every consumer treats it as a 0-100 percentage —
    // recallForPool printed "win rate 0.77%" for a 77%-win pool and
    // ml/features' /100 normalization turned it into ~0, so the screener
    // LLM and the ML gate both punished exactly the pools with the best
    // proven history. Recomputing from the raw deploys array is cheap and
    // always right, so stale/legacy values can never poison a decision again.
    for (const entry of Object.values(db)) recomputeAggregates(entry);
    return db;
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

// Recompute a pool entry's aggregate stats from its raw deploys array.
// win_rate / adjusted_win_rate are 0-100 percentages.
function recomputeAggregates(entry) {
  if (!Array.isArray(entry?.deploys) || entry.deploys.length === 0) return;
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 10000
    ) / 100;
  }
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
  entry.adjusted_win_rate_sample_count = adjusted.length;
  entry.adjusted_win_rate = adjusted.length > 0
    ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
    : 0;
}

function isFeeGeneratingDeploy(deploy) {
  const minFeeEarnedPct = Number(config.management.repeatDeployCooldownMinFeeEarnedPct ?? 0);
  const feeEarnedPct = Number(deploy.fee_earned_pct ?? 0);
  const feesUsd = Number(deploy.fees_earned_usd ?? 0);
  const feesSol = Number(deploy.fees_earned_sol ?? 0);
  const hasFees = (Number.isFinite(feesUsd) && feesUsd > 0) || (Number.isFinite(feesSol) && feesSol > 0);
  if (!hasFees) return false;
  return Number.isFinite(feeEarnedPct) && feeEarnedPct >= minFeeEarnedPct;
}

function setPoolCooldown(entry, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  return cooldownUntil;
}

function setBaseMintCooldown(db, baseMint, hours, reason) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
    }
  }
  return cooldownUntil;
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
/**
 * Post-deploy markout — the market maker's adverse-selection meter.
 * Reads the position's own snapshot path and returns its net PnL% at
 * deploy+15m and deploy+60m (nearest snapshot within tolerance). A pool
 * whose deploys are consistently deep negative shortly after entry has
 * informed sellers hitting the ladder — fee income won't cover that flow.
 */
function computeDeployMarkouts(entry, positionAddress, deployedAt) {
  const t0 = Date.parse(deployedAt || "");
  if (!Number.isFinite(t0) || !positionAddress) return { markout_15m: null, markout_60m: null };
  const snaps = (entry.snapshots || []).filter((s) => s.position === positionAddress && s.pnl_pct != null);
  const at = (mins, tolMins) => {
    const target = t0 + mins * 60_000;
    let best = null;
    let bestDiff = tolMins * 60_000;
    for (const s of snaps) {
      const diff = Math.abs(Date.parse(s.ts) - target);
      if (diff <= bestDiff) { best = s; bestDiff = diff; }
    }
    return best ? best.pnl_pct : null;
  };
  return { markout_15m: at(15, 10), markout_60m: at(60, 20) };
}

export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    fees_earned_usd: deployData.fees_earned_usd ?? null,
    fees_earned_sol: deployData.fees_earned_sol ?? null,
    fee_earned_pct: deployData.fee_earned_pct ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
  };

  const markouts = computeDeployMarkouts(entry, deployData.position, deploy.deployed_at);
  deploy.markout_15m = markouts.markout_15m;
  deploy.markout_60m = markouts.markout_60m;

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  recomputeAggregates(entry);

  // Aggregate markouts (adverse-selection meter) across deploys that have one
  for (const [key, aggKey] of [["markout_15m", "avg_markout_15m"], ["markout_60m", "avg_markout_60m"]]) {
    const vals = entry.deploys.map((d) => d[key]).filter((v) => v != null);
    entry[aggKey] = vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100 : null;
    entry[`${aggKey}_n`] = vals.length;
  }

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  // Set cooldown for low yield closes — pool wasn't profitable enough, don't redeploy soon
  if (deploy.close_reason === "low yield") {
    const cooldownHours = 4;
    const cooldownUntil = setPoolCooldown(entry, cooldownHours, "low yield");
    log("pool-memory", `Cooldown set for ${entry.name} until ${cooldownUntil} (low yield close)`);
  }

  const oorTriggerCount = config.management.oorCooldownTriggerCount ?? 3;
  const oorCooldownHours = config.management.oorCooldownHours ?? 12;
  const recentDeploys = entry.deploys.slice(-oorTriggerCount);
  const repeatedOorCloses =
    recentDeploys.length >= oorTriggerCount &&
    recentDeploys.every((d) => isOorCloseReason(d.close_reason));

  if (repeatedOorCloses) {
    const reason = `repeated OOR closes (${oorTriggerCount}x)`;
    const poolCooldownUntil = setPoolCooldown(entry, oorCooldownHours, reason);
    const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, oorCooldownHours, reason);
    log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
    if (entry.base_mint && mintCooldownUntil) {
      log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
    }
  }

  if (config.management.repeatDeployCooldownEnabled) {
    const triggerCount = Math.max(1, Number(config.management.repeatDeployCooldownTriggerCount ?? 3));
    const cooldownHours = Math.max(0, Number(config.management.repeatDeployCooldownHours ?? 12));
    const rawScope = String(config.management.repeatDeployCooldownScope || "token").toLowerCase();
    const scope = ["pool", "token", "both"].includes(rawScope) ? rawScope : "token";
    const recentRepeatDeploys = entry.deploys.slice(-triggerCount);
    const repeatedFeeGeneratingDeploys =
      cooldownHours > 0 &&
      recentRepeatDeploys.length >= triggerCount &&
      recentRepeatDeploys.every((d) => d.pnl_pct != null && isFeeGeneratingDeploy(d));

    if (repeatedFeeGeneratingDeploys) {
      const reason = `repeat fee-generating deploys (${triggerCount}x)`;
      if (scope === "pool" || scope === "both" || !entry.base_mint) {
        const poolCooldownUntil = setPoolCooldown(entry, cooldownHours, reason);
        log("pool-memory", `Cooldown set for ${entry.name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((scope === "token" || scope === "both") && entry.base_mint) {
        const mintCooldownUntil = setBaseMintCooldown(db, entry.base_mint, cooldownHours, reason);
        if (mintCooldownUntil) {
          log("pool-memory", `Base mint cooldown set for ${entry.base_mint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
        }
      }
    }
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  return new Date(entry.cooldown_until) > new Date();
}

export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.values(db).some((entry) =>
    entry?.base_mint === baseMint &&
    entry?.base_mint_cooldown_until &&
    new Date(entry.base_mint_cooldown_until) > now
  );
}

/**
 * Rolling per-token deploy cap. Deploy #6+ into the same token averaged
 * -$0.14 across 107 closes (Jul 1-7 export) vs +$1.13..+$3.49 for #1-4;
 * the repeat-deploy cooldown misses these because a single zero-fee churn
 * close resets its consecutive-fee-earning streak.
 * Counts CLOSED deploys (recordPoolDeploy fires on close) across every pool
 * sharing the base mint, keyed on deployed_at (falls back to closed_at).
 * config.management.maxDeploysPerToken24h, 0 = disabled.
 */
export function getBaseMintDeployCap(baseMint) {
  const cap = Math.max(0, Math.round(Number(config.management.maxDeploysPerToken24h ?? 0)));
  if (!baseMint || cap === 0) return { capped: false, count: 0, cap };
  const db = load();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let count = 0;
  for (const entry of Object.values(db)) {
    if (entry?.base_mint !== baseMint) continue;
    for (const d of entry.deploys || []) {
      const at = Date.parse(d.deployed_at || d.closed_at || "");
      if (Number.isFinite(at) && at >= cutoff) count++;
    }
  }
  return { capped: count >= cap, count, cap };
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    adjusted_win_rate: entry.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: entry.adjusted_win_rate_sample_count ?? 0,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
    base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary. Spell out the win/loss counts so a model can't
  // misread the percentage scale (win rate 77% (27/35 wins) is unambiguous).
  if (entry.total_deploys > 0) {
    const withPnl = (entry.deploys || []).filter((d) => d.pnl_pct != null);
    const winCount = withPnl.filter((d) => d.pnl_pct >= 0).length;
    const counts = withPnl.length > 0 ? ` (${winCount}/${withPnl.length} wins)` : "";
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%${counts}, last outcome: ${entry.last_outcome}`);
  }

  // Adverse-selection meter: consistently negative post-deploy markout means
  // informed sellers hit this pool's ladders faster than fees accrue.
  if (entry.avg_markout_15m != null || entry.avg_markout_60m != null) {
    const fmt = (v) => (v == null ? "?" : `${v >= 0 ? "+" : ""}${v}%`);
    const n = Math.max(entry.avg_markout_15m_n || 0, entry.avg_markout_60m_n || 0);
    lines.push(`MARKOUT (avg net PnL after deploy, ${n} deploy(s)): 15m ${fmt(entry.avg_markout_15m)}, 60m ${fmt(entry.avg_markout_60m)}${(entry.avg_markout_60m ?? 0) < -2 ? " — TOXIC FLOW: entries bleed immediately here" : ""}`);
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note: safeNote,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}

// ─── Enrichment ──────────────────────────────────────────────

// Whitelist of fields an enrichment update is allowed to write. Keeps LLM
// output from polluting the record and gives ML features a stable schema
// to read against.
const ENRICHMENT_FIELDS = [
  "holders_top10_pct",
  "holders_count",
  "organic_score",
  "top10_holder_lp_pct",
  "narrative_tags",
  "socials",
  "dev_wallet_holds_pct",
  "bundle_pct",
  "sniper_pct",
  "user_flags",
  "user_tags",
];

/**
 * Merge-update the enrichment block for a pool. Lazy-initializes the entry
 * and the enrichment object if missing. Only whitelisted fields are persisted;
 * everything else is dropped. Bumps `enriched_at` and `enrichments_count`.
 *
 * @param {string} poolAddress
 * @param {Object} partial  any subset of ENRICHMENT_FIELDS
 * @returns {{ saved: boolean, pool_address: string, enrichment: Object }}
 */
export function setPoolEnrichment(poolAddress, partial = {}) {
  if (!poolAddress) return { saved: false, error: "pool_address required" };
  if (!partial || typeof partial !== "object") return { saved: false, error: "partial required" };

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];
  if (!entry.enrichment || typeof entry.enrichment !== "object") {
    entry.enrichment = {};
  }

  const cleaned = {};
  for (const field of ENRICHMENT_FIELDS) {
    if (partial[field] === undefined) continue;
    cleaned[field] = partial[field];
  }

  // user_flags / user_tags / narrative_tags are append-or-replace arrays.
  // If the caller passes an array, replace. If they pass strings like
  // ["avoid", "watchlist"], treat as replace.
  const arrayFields = ["narrative_tags", "user_flags", "user_tags"];
  for (const f of arrayFields) {
    if (cleaned[f] !== undefined && !Array.isArray(cleaned[f])) {
      cleaned[f] = [String(cleaned[f])];
    }
  }

  Object.assign(entry.enrichment, cleaned);
  entry.enrichment.enriched_at = new Date().toISOString();
  entry.enrichment.enrichments_count = (entry.enrichment.enrichments_count || 0) + 1;

  save(db);
  log("pool-memory", `Enrichment updated for ${poolAddress.slice(0, 8)} (count=${entry.enrichment.enrichments_count})`);
  return { saved: true, pool_address: poolAddress, enrichment: entry.enrichment };
}

export function getPoolEnrichment(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  return entry?.enrichment || null;
}
