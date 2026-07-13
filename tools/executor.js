import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { getTrackedPosition, setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote, setPoolEnrichment } from "../pool-memory.js";
import { getCryptoBotTokens } from "./crypto-signals.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

import { normalizeTimeframe, getEffectiveWindowThresholds } from "../screening-scales.js";

import { PATHS } from "../utils/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RISK_SIZED_DEPLOY_TTL_MS = 15 * 60 * 1000;
const riskSizedDeployAuthorizations = new Map();

/**
 * Authorize one exact automated pool/amount pair to deploy below the user's
 * normal manual floor. This is staged by the deterministic screener, not by
 * the LLM, and expires automatically.
 */
export function authorizeRiskSizedDeploy(poolAddress, amountSol, { now = Date.now(), ttlMs = RISK_SIZED_DEPLOY_TTL_MS } = {}) {
  const pool = String(poolAddress || "").trim();
  const amount = Number(amountSol);
  if (!pool || !Number.isFinite(amount) || amount < 0.1) return false;
  riskSizedDeployAuthorizations.set(pool, { amount, expiresAt: now + ttlMs });
  return true;
}

export function isRiskSizedDeployAuthorized(poolAddress, amountSol, { now = Date.now() } = {}) {
  const pool = String(poolAddress || "").trim();
  const amount = Number(amountSol);
  const authorization = riskSizedDeployAuthorizations.get(pool);
  if (!authorization) return false;
  if (authorization.expiresAt < now) {
    riskSizedDeployAuthorizations.delete(pool);
    return false;
  }
  return Number.isFinite(amount) && Math.abs(authorization.amount - amount) < 1e-6;
}

export function clearRiskSizedDeployAuthorizations() {
  riskSizedDeployAuthorizations.clear();
}

export function checkDeployAmountFloor(poolAddress, amountSol, configuredFloor, { now = Date.now() } = {}) {
  const amount = Number(amountSol);
  const floor = Math.max(0.1, Number(configuredFloor) || 0);
  const riskSized = isRiskSizedDeployAuthorized(poolAddress, amount, { now });
  return { allowed: amount >= floor || riskSized, floor, riskSized };
}
const USER_CONFIG_PATH = PATHS.userConfig;
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Swap a base token back to SOL with retry. Jupiter can transiently fail (no route,
 * quote error) and a single attempt silently leaves the token unsold — this retries
 * with a delay, re-fetching the balance each attempt (amounts can shift on partial
 * fills). Treats both a throw AND result.success===false / missing tx as failure.
 * Returns { swapped, result, token } — swapped=false if nothing to do or all attempts failed.
 */
export async function swapBaseToSolWithRetry(baseMint, label) {
  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  const minUsdFloor = Math.max(0, Number(config.management.autoSwapMinUsdFloor ?? 0.10));
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const balances = await getWalletBalances({});
      const token = balances.tokens?.find((t) => t.mint === baseMint);
      if (!token || token.usd < minUsdFloor) {
        return { swapped: attempt > 1, result: null, token: null };
      }
      log("executor", `Auto-swapping ${label} ${token.symbol || baseMint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL (attempt ${attempt}/${attempts})`);
      const swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
      const ok = swapResult && swapResult.success !== false && !swapResult.error && (swapResult.tx || swapResult.amount_out);
      if (ok) return { swapped: true, result: swapResult, token };
      lastErr = swapResult?.error || swapResult?.reason || "swap returned no tx";
    } catch (e) {
      lastErr = e.message;
    }
    log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastErr}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  log("executor_warn", `Auto-swap ${label} failed after ${attempts} attempts — base token left unsold (${baseMint.slice(0, 8)})`);
  return { swapped: false, result: null, token: null };
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

/**
 * Fallback: fetch pool detail from the DLMM API when Pool Discovery
 * returns null for fee_active_tvl_ratio (known caching gap).
 * The DLMM endpoint returns fee_tvl_ratio as a time-bucketed object
 * {"30m": 0.04, "24h": 0.62} — we extract the matching timeframe bucket.
 */
async function fetchDlmmFallback(poolAddress) {
  const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddress}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  return res.json();
}

function extractDlmmTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl);
}

function extractDlmmFeeTvlRatio(pool, timeframe = config.screening.timeframe || "5m") {
  // DLMM returns fee_tvl_ratio as {"30m": 0.04, "1h": ..., "24h": ...}
  const buckets = pool?.fee_tvl_ratio;
  if (!buckets || typeof buckets !== "object") return null;
  return numberOrNull(buckets[timeframe])
    ?? numberOrNull(buckets["30m"])  // fallback to 30m
    ?? numberOrNull(Object.values(buckets)[0]); // last resort
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  let feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const candidateFeeActiveTvlRatio = numberOrNull(args.fee_tvl_ratio);
  const rawMinFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  // Use the candidate's discovery timeframe when available. Custom values are
  // scaled by per-metric rules (linear / power / none) via screening-scales.js.
  const timeframe = args.discovery_timeframe || config.screening.timeframe || "5m";
  const { minFeeActiveTvlRatio: minFeeActiveTvlRatio } = getEffectiveWindowThresholds({
    minFeeActiveTvlRatio: rawMinFeeActiveTvlRatio,
    minVolume: null,
  }, timeframe);

  // Pool Discovery single-pool endpoint can lag behind the list endpoint and
  // return null, 0, OR a near-zero-but-non-zero "stale" value (e.g. 0.000024%
  // when the screening snapshot said 0.1771% — a 7400x discrepancy, both
  // verified in the same screening cycle). Treat any value more than 10x
  // below the candidate's screened snapshot as stale and fall back to the
  // snapshot, which is the same source the screener trusted seconds ago.
  const looksStale = (value) => {
    if (value == null || value <= 0) return true;
    if (candidateFeeActiveTvlRatio != null && candidateFeeActiveTvlRatio > 0
        && value < candidateFeeActiveTvlRatio / 10) {
      return true;  // fresh API is > 10x lower than the screener's snapshot
    }
    return false;
  };

  if (looksStale(feeActiveTvlRatio)) {
    try {
      const dlmmPool = await fetchDlmmFallback(args.pool_address);
      if (dlmmPool) {
        const dlmmFeeActiveTvlRatio = extractDlmmFeeTvlRatio(dlmmPool);
        if (dlmmFeeActiveTvlRatio != null && dlmmFeeActiveTvlRatio > 0
            && !looksStale(dlmmFeeActiveTvlRatio)) {
          feeActiveTvlRatio = dlmmFeeActiveTvlRatio;
        }
      }
    } catch { /* non-critical — screening already validated this */ }
  }
  if (looksStale(feeActiveTvlRatio) && candidateFeeActiveTvlRatio != null && candidateFeeActiveTvlRatio > 0) {
    log("executor_warn", `Deploy validation using screened candidate fee/active-TVL snapshot ${candidateFeeActiveTvlRatio}% for ${args.pool_address} because fresh detail returned stale value ${feeActiveTvlRatio ?? "null"}%`);
    feeActiveTvlRatio = candidateFeeActiveTvlRatio;
  }

  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    feeActiveTvlRatio != null &&
    feeActiveTvlRatio < minFeeActiveTvlRatio
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  return { pass: true, detail };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "mlEnabled",
    "evolveEnabled",
    "thresholdEvolveEnabled",
    "chartIndicatorsEnabled",
    "requireAllIntervals",
    "lpAgentRelayEnabled",
    "policyEnabled",
    "policyQuietHoursAuto",
    "disableAdaptiveOverride",
    "gmgnRequireKol",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads", "indicatorIntervals"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "screeningSource",
    "source",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "mlPersonality",
    "indicatorEntryPreset",
    "indicatorExitPreset",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
    "pnlSource",
    "pnlRpcUrl",
    "gmgnFeeSource",
    "gmgnApiKey",
    "gmgnInterval",
    "botTrackerStreamMode",
    "botTrackerEntryMode",
    "policyQuietHoursUtc",
  ]);
  const numberKeys = new Set([
    "mlTrainEvery", "mlMinSamples", "mlTrainWindow", "mlBatchSize", "mlEpochs", "mlLearningRate",
    "policyMinFeeVolatilityRatio", "policyMinVolumePersistence", "policyToxicFlowPenalty",
    "policyNeutralMinScore", "policyRiskOffMinScore", "policyRiskOnMinScore", "policyShrinkRetryPct",
    "policyQuietHoursSizeMult", "maxDeploysPerToken24h",
    "darwinWindowDays", "darwinRecalcEvery", "darwinBoost", "darwinDecay",
    "darwinFloor", "darwinCeiling", "darwinMinSamples",
    "rsiLength", "indicatorCandles", "rsiOversold", "rsiOverbought",
    "adaptiveMinAgeHours", "adaptiveMaxAgeHours", "adaptiveMinVolatility",
    "autoSwapRetryAttempts", "autoSwapRetryDelayMs", "autoSwapMinUsdFloor",
    "walletSweepIntervalSec", "minSafeBinsBelow",
  ]);
  // Keys where null is a legal "feature off" value. Accept the string forms
  // Telegram /setcfg sends ("null" / "none" / "off") since its values always
  // arrive as text.
  const nullableKeys = new Set([
    "maxTvl", "minTokenAgeHours", "maxTokenAgeHours", "athFilterPct",
    "gmgnMaxMcap", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours", "gmgnAthFilterPct",
    "botTrackerPumpCeilingUsd",
  ]);
  if (value === null) return null;
  if (nullableKeys.has(key) && typeof value === "string" && /^(null|none|off)$/i.test(value.trim())) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (key === "indicatorIntervals") {
    // Filter to valid interval values (must be "5_MINUTE" or "15_MINUTE")
    if (!Array.isArray(value)) {
      throw new Error(`${key} must be an array of strings like ["5_MINUTE", "15_MINUTE"]`);
    }
    return value
      .map((v) => String(v || "").trim().toUpperCase())
      .filter((v) => v === "5_MINUTE" || v === "15_MINUTE");
  }
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  if (numberKeys.has(key)) return coerceFiniteNumber(value, key);
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: process.cwd(),
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  enrich_pool_record: async ({ pool_address, base_mint, persist = true, user_flags = [], user_tags = [] } = {}) => {
    let poolAddr = pool_address;
    let mint = base_mint;

    // Resolve pool → mint when only one is given.
    if (!mint && poolAddr) {
      try {
        const detail = await getPoolDetail({ pool_address: poolAddr });
        mint = detail?.base_mint || null;
      } catch (e) {
        return { error: `Could not resolve mint from pool_address ${poolAddr}: ${e.message}` };
      }
    }
    if (!mint) return { error: "Either pool_address or base_mint is required." };
    if (!poolAddr) poolAddr = `mint:${mint}`; // synthetic key for mint-only enrichment

    // Fetch all four sources in parallel. Each is independently fault-tolerant —
    // a missing narrative or holder fetch should not block the rest.
    const [info, holders, narrative] = await Promise.all([
      getTokenInfo({ query: mint }).catch((e) => ({ error: e.message })),
      getTokenHolders({ mint }).catch((e) => ({ error: e.message })),
      getTokenNarrative({ mint }).catch((e) => ({ error: e.message })),
    ]);

    const primary = info?.results?.[0] || null;
    const audit = primary?.audit || null;

    const partial = {
      holders_count:        primary?.holders ?? null,
      holders_top10_pct:    holders?.top_10_real_holders_pct != null ? Number(holders.top_10_real_holders_pct) : null,
      organic_score:        primary?.organic_score ?? null,
      dev_wallet_holds_pct: audit?.top_holders_pct != null ? Number(audit.top_holders_pct) : null,
      bundle_pct:           primary?.bundle_pct ?? null,
      sniper_pct:           primary?.sniper_pct ?? null,
      narrative_tags:       narrative?.tags || primary?.tags || [],
      socials:              {
        twitter:  primary?.twitter  ?? null,
        telegram: primary?.telegram ?? null,
        website:  primary?.website  ?? null,
      },
      user_flags: Array.isArray(user_flags) ? user_flags.filter(Boolean) : [],
      user_tags:  Array.isArray(user_tags)  ? user_tags.filter(Boolean)  : [],
    };

    if (!persist) {
      return {
        persisted: false,
        pool_address: poolAddr,
        mint,
        summary: partial,
        sources: {
          info_ok: !info?.error,
          holders_ok: !holders?.error,
          narrative_ok: !narrative?.error,
        },
      };
    }

    const result = setPoolEnrichment(poolAddr, partial);
    return {
      persisted: result.saved !== false,
      pool_address: poolAddr,
      mint,
      enrichment: result.enrichment,
      sources: {
        info_ok: !info?.error,
        holders_ok: !holders?.error,
        narrative_ok: !narrative?.error,
      },
    };
  },
  get_crypto_bot_tokens: getCryptoBotTokens,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      screeningSource: ["screening", "source", ["screeningSource"]],
      source: ["screening", "source", ["screeningSource"]],  // alias — LLM often sends "source" not "screeningSource"
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      autoSwapRetryAttempts: ["management", "autoSwapRetryAttempts"],
      autoSwapRetryDelayMs: ["management", "autoSwapRetryDelayMs"],
      autoSwapMinUsdFloor: ["management", "autoSwapMinUsdFloor"],
      walletSweepIntervalSec: ["management", "walletSweepIntervalSec"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      maxDeploysPerToken24h: ["management", "maxDeploysPerToken24h"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      trailingRetracePct: ["management", "trailingRetracePct"],
      belowRangeExitMinutes: ["management", "belowRangeExitMinutes"],
      maxHoldMinutes: ["management", "maxHoldMinutes"],
      conversionExitPct: ["management", "conversionExitPct"],
      conversionExitPnlPct: ["management", "conversionExitPnlPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      solMode: ["management", "solMode"],
      evolveEnabled: ["management", "evolveEnabled"],
      thresholdEvolveEnabled: ["management", "thresholdEvolveEnabled"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      toolChoice: ["llm", "toolChoice"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      disableAdaptiveOverride: ["strategy", "disableAdaptiveOverride"],
      adaptiveMinAgeHours: ["strategy", "adaptiveMinAgeHours"],
      adaptiveMaxAgeHours: ["strategy", "adaptiveMaxAgeHours"],
      adaptiveMinVolatility: ["strategy", "adaptiveMinVolatility"],
      // bin floor override (default 35) — allows testing tighter ranges (e.g. 25).
      // Lives at config.minSafeBinsBelow (mutable, refreshed by reloadScreeningThresholds).
      // Deploy code reads config.minSafeBinsBelow dynamically so the change takes
      // effect immediately, no restart needed.
      minSafeBinsBelow: ["minSafeBinsBelow", "value"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // policy / flow quality
      policyEnabled: ["policy", "enabled", ["policyEnabled"]],
      policyMinFeeVolatilityRatio: ["policy", "minFeeVolatilityRatio", ["policyMinFeeVolatilityRatio"]],
      policyMinVolumePersistence: ["policy", "minVolumePersistence", ["policyMinVolumePersistence"]],
      policyToxicFlowPenalty: ["policy", "toxicFlowPenalty", ["policyToxicFlowPenalty"]],
      policyNeutralMinScore: ["policy", "neutralMinScore", ["policyNeutralMinScore"]],
      policyRiskOffMinScore: ["policy", "riskOffMinScore", ["policyRiskOffMinScore"]],
      policyRiskOnMinScore: ["policy", "riskOnMinScore", ["policyRiskOnMinScore"]],
      policyShrinkRetryPct: ["policy", "shrinkRetryPct", ["policyShrinkRetryPct"]],
      policyQuietHoursUtc: ["policy", "quietHoursUtc", ["policyQuietHoursUtc"]],
      policyQuietHoursSizeMult: ["policy", "quietHoursSizeMult", ["policyQuietHoursSizeMult"]],
      policyQuietHoursAuto: ["policy", "quietHoursAuto", ["policyQuietHoursAuto"]],
      // ml / darwin
      mlEnabled: ["ml", "enabled", ["mlEnabled"]],
      mlTrainEvery: ["ml", "trainEvery", ["mlTrainEvery"]],
      mlMinSamples: ["ml", "minSamples", ["mlMinSamples"]],
      mlTrainWindow: ["ml", "trainWindowRecords", ["mlTrainWindow"]],
      mlBatchSize: ["ml", "batchSize", ["mlBatchSize"]],
      mlEpochs: ["ml", "epochs", ["mlEpochs"]],
      mlLearningRate: ["ml", "learningRate", ["mlLearningRate"]],
      mlPersonality: ["ml", "personality", ["mlPersonality"]],
      darwinEnabled: ["darwin", "enabled", ["darwinEnabled"]],
      darwinWindowDays: ["darwin", "windowDays", ["darwinWindowDays"]],
      darwinRecalcEvery: ["darwin", "recalcEvery", ["darwinRecalcEvery"]],
      darwinBoost: ["darwin", "boostFactor", ["darwinBoost"]],
      darwinDecay: ["darwin", "decayFactor", ["darwinDecay"]],
      darwinFloor: ["darwin", "weightFloor", ["darwinFloor"]],
      darwinCeiling: ["darwin", "weightCeiling", ["darwinCeiling"]],
      darwinMinSamples: ["darwin", "minSamples", ["darwinMinSamples"]],
      // pnl fetcher / poller
      pnlSource: ["pnl", "source", ["pnlSource"]],
      pnlRpcUrl: ["pnl", "rpcUrl", ["pnlRpcUrl"]],
      pnlPollIntervalSec: ["pnl", "pollIntervalSec", ["pnlPollIntervalSec"]],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec", ["pnlDepositCacheTtlSec"]],
      // gmgn discovery pipeline (persisted as flat gmgn* keys in
      // user-config.json, which now wins over data/gmgn-config.json)
      gmgnFeeSource: ["gmgn", "feeSource", ["gmgnFeeSource"]],
      gmgnApiKey: ["gmgn", "apiKey", ["gmgnApiKey"]],
      gmgnMinMcap: ["gmgn", "minMcap", ["gmgnMinMcap"]],
      gmgnMaxMcap: ["gmgn", "maxMcap", ["gmgnMaxMcap"]],
      gmgnMinTvl: ["gmgn", "minTvl", ["gmgnMinTvl"]],
      gmgnMinVolume: ["gmgn", "minVolume", ["gmgnMinVolume"]],
      gmgnMinHolders: ["gmgn", "minHolders", ["gmgnMinHolders"]],
      gmgnMinTokenAgeHours: ["gmgn", "minTokenAgeHours", ["gmgnMinTokenAgeHours"]],
      gmgnMaxTokenAgeHours: ["gmgn", "maxTokenAgeHours", ["gmgnMaxTokenAgeHours"]],
      gmgnMaxBundlerRate: ["gmgn", "maxBundlerRate", ["gmgnMaxBundlerRate"]],
      gmgnMaxRugRatio: ["gmgn", "maxRugRatio", ["gmgnMaxRugRatio"]],
      gmgnMaxTop10HolderRate: ["gmgn", "maxTop10HolderRate", ["gmgnMaxTop10HolderRate"]],
      gmgnMinTotalFeeSol: ["gmgn", "minTotalFeeSol", ["gmgnMinTotalFeeSol"]],
      gmgnLimit: ["gmgn", "limit", ["gmgnLimit"]],
      gmgnEnrichLimit: ["gmgn", "enrichLimit", ["gmgnEnrichLimit"]],
      gmgnRequireKol: ["gmgn", "requireKol", ["gmgnRequireKol"]],
      gmgnMinKolCount: ["gmgn", "minKolCount", ["gmgnMinKolCount"]],
      gmgnMinSmartDegenCount: ["gmgn", "minSmartDegenCount", ["gmgnMinSmartDegenCount"]],
      gmgnAthFilterPct: ["gmgn", "athFilterPct", ["gmgnAthFilterPct"]],
      gmgnInterval: ["gmgn", "interval", ["gmgnInterval"]],
      // bot-tracker candidate injection (flat keys usable from /setcfg;
      // persisted nested so config.js's botTracker reader survives restarts)
      botTrackerLimit: ["botTracker", "limit", ["botTracker", "limit"]],
      botTrackerMaxAgeMinutes: ["botTracker", "maxAgeMinutes", ["botTracker", "maxAgeMinutes"]],
      botTrackerMinLiquidityUsd: ["botTracker", "minLiquidityUsd", ["botTracker", "minLiquidityUsd"]],
      botTrackerMinVolume24h: ["botTracker", "minVolume24h", ["botTracker", "minVolume24h"]],
      botTrackerPumpCeilingUsd: ["botTracker", "pumpCeilingUsd", ["botTracker", "pumpCeilingUsd"]],
      botTrackerStreamMode: ["botTracker", "streamMode", ["botTracker", "streamMode"]],
      botTrackerEntryMode: ["botTracker", "entryMode", ["botTracker", "entryMode"]],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      // Reasoning models sometimes serialise `changes` as a JSON string — auto-repair
      if (typeof changes === "string") {
        try {
          changes = JSON.parse(changes);
          if (typeof changes !== "object" || Array.isArray(changes)) throw 0;
          log("config", "Repaired stringified changes object");
        } catch {
          return {
            success: false,
            error: `changes must be a JSON object like {"minFeeActiveTvlRatio": 0.02}, got string: "${changes.slice(0, 60)}"`,
            hint: "Do not wrap the value in quotes. Send {\"changes\": {\"minFeeActiveTvlRatio\": 0.02}}",
            reason,
          };
        }
      } else {
        const got = Array.isArray(changes) ? "array" : typeof changes;
        return {
          success: false,
          error: `changes must be a JSON object like {"minFeeActiveTvlRatio": 0.02}, got ${got}`,
          hint: "Example: {\"changes\": {\"minFeeActiveTvlRatio\": 0.02, \"maxTvl\": 200000}}",
          reason,
        };
      }
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);

    // userConfig is read once and mutated in-place by the persist loop
    // below. The bot-tracker shortcut needs it BEFORE that loop (we want to
    // persist the merged section even if the file doesn't exist on disk).
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Nested-object shortcut: { botTracker: { entryMode: "balanced" } } is
    // a valid update — merge the partial into the live botTracker config and
    // persist the whole section. Lets the Telegram /settings menu update
    // individual bot-tracker knobs without round-tripping the full block.
    if (changes && typeof changes === "object" && changes.botTracker && typeof changes.botTracker === "object") {
      const before = config.botTracker || {};
      const merged = { ...before, ...changes.botTracker };
      // null is a legal "feature off" value for pumpCeilingUsd; do not strip it.
      if (merged.pumpCeilingUsd === undefined) merged.pumpCeilingUsd = before.pumpCeilingUsd ?? null;
      config.botTracker = merged;
      userConfig.botTracker = merged;
      log("config", `update_config: config.botTracker ${JSON.stringify(before)} → ${JSON.stringify(merged)} (reason: ${reason})`);
      applied.botTracker = merged;
    }

    for (const [key, val] of Object.entries(changes)) {
      if (key === "botTracker") continue;  // handled above
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(config.minSafeBinsBelow, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    // (userConfig is declared at the top of this function — used by the
    // bot-tracker shortcut above, the persist loop below, and the config-map
    // rewrites that need the file's current state.)
    void userConfig;

    // Timeframe changes do NOT rewrite minFeeActiveTvlRatio / minVolume:
    // config stores 5m-BASELINE values and getEffectiveWindowThresholds
    // scales them to the active window at runtime (per-metric rules in
    // screening-scales.js). The old auto-scale here wrote window-scaled
    // defaults into config, which the runtime then scaled AGAIN — e.g.
    // `timeframe 30m` persisted minFeeActiveTvlRatio 0.15 and the screener
    // applied 0.15 x 6^0.72 = 0.54, a floor almost nothing passes — and it
    // clobbered the user's own tuned values on every timeframe switch.
    if (applied.timeframe != null) {
      applied.timeframe = normalizeTimeframe(applied.timeframe);
      log("config", `timeframe ${applied.timeframe} — minFeeActiveTvlRatio/minVolume stay as 5m baselines, scaled per-window at runtime`);
    }

    // Apply to live config immediately after the persisted config is known-good.
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      if (key === "botTracker") continue;  // handled by the nested shortcut above
      const [section, field] = CONFIG_MAP[key];
      // minSafeBinsBelow is a top-level number, not a nested object.
      // Special-case it so we write directly to config.minSafeBinsBelow.
      if (key === "minSafeBinsBelow") {
        const before = config.minSafeBinsBelow;
        config.minSafeBinsBelow = val;
        log("config", `update_config: config.minSafeBinsBelow ${before} → ${val} (verify: ${config.minSafeBinsBelow})`);
        continue;
      }
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(config.minSafeBinsBelow, Math.round(Number(config.strategy.minBinsBelow ?? config.minSafeBinsBelow)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      if (key === "botTracker") {
        // Persist the whole section in one go (the in-place update above
        // already applied to live config; here we just write user-config.json).
        userConfig.botTracker = val;
        continue;
      }
      const persistPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlPollIntervalSec != null || applied.walletSweepIntervalSec != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m, pnlPoll: ${config.pnl.pollIntervalSec}s, walletSweep: ${config.management.walletSweepIntervalSec}s`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  // Manual operator overrides (set by /deploy N in index.js) skip pool-level
  // pre-checks — the operator typed the command knowing the candidate. The
  // _skipSafety flag is not propagated to deployPosition() (which still
  // enforces single-side SOL, amount_x=0, quote token = SOL, etc.); the flag
  // only relaxes the SCREENER-side guard rails (minTvl/minFee/volatility/
  // duplicate-pool/duplicate-mint/max-positions).
  if (PROTECTED_TOOLS.has(name) && !args._skipSafety) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  } else if (args._skipSafety && name === "deploy_position") {
    log("executor", `Manual override: deploy_position safety checks bypassed for pool ${args.pool_address?.slice(0, 12)} (operator /deploy)`);
  }

  // ─── Execute ──────────────────────────────
  try {
    // For deploy_position, strip the LLM's strategy field if the user has
    // explicitly disabled the adaptive override. The LLM tool description
    // tells the model to omit the strategy field, but models like deepseek
    // can still pass 'spot' on their own. When the user has configured
    // disableAdaptiveOverride: true (default), honor that — always use
    // the configured strategy. The CLI sets _fromCli to bypass this
    // guard so manual `meridian deploy --strategy spot` still works.
    let deployArgs = args;
    if (name === "deploy_position" && !args._fromCli && config.strategy?.disableAdaptiveOverride === true) {
      if (args.strategy && args.strategy !== config.strategy?.strategy) {
        log("executor_warn", `LLM passed strategy=${args.strategy} for deploy of ${args.pool_address?.slice(0, 12)} — overriding to config default ${config.strategy.strategy} (disableAdaptiveOverride=true)`);
      }
      deployArgs = { ...args };
      delete deployArgs.strategy;
    }

    let result = await fn(deployArgs);
    if (
      name === "deploy_position" &&
      (result?.success === false || result?.error) &&
      /insufficient funds|custom program error: 0x1/i.test(String(result.error || ""))
    ) {
      const originalAmount = Number(args.amount_y ?? args.amount_sol ?? 0);
      const retryAmount = Number((originalAmount * Number(config.policy?.shrinkRetryPct ?? 0.8)).toFixed(4));
      const exactRiskSizeAuthorized = isRiskSizedDeployAuthorized(args.pool_address, originalAmount);
      const minDeploy = exactRiskSizeAuthorized ? 0.1 : Math.max(0.1, config.management.deployAmountSol);
      if (Number.isFinite(retryAmount) && retryAmount >= minDeploy && retryAmount < originalAmount) {
        log("deploy_retry", `Retrying deploy at 80% size after insufficient-funds simulation: ${originalAmount} → ${retryAmount} SOL`);
        result = await fn({ ...args, amount_y: retryAmount, amount_sol: undefined, retry_of_amount_y: originalAmount });
        if (result && typeof result === "object") {
          result.retry_of_amount_y = originalAmount;
          result.retry_amount_y = retryAmount;
        }
      }
    }
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch((e) => log("executor_warn", `notifySwap failed for ${args.input_mint?.slice(0, 8)}: ${e?.message || e}`));
      } else if (name === "deploy_position") {
        if (result.dry_run) {
          // Dry-run must not announce "Deployed" — the position does not exist.
          log("executor", `Dry-run deploy — skipping Telegram notification for ${result.pool_name || args.pool_name || args.pool_address?.slice(0, 8)}`);
        } else {
          notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
        }
        const v = Number(args.volatility);
        const nextInterval = Number.isFinite(v) && v >= 5 ? 3 : Number.isFinite(v) && v >= 2 ? 5 : 10;
        if (config.schedule.managementIntervalMin !== nextInterval) {
          config.schedule.managementIntervalMin = nextInterval;
          if (_cronRestarter) _cronRestarter();
          log("config", `Auto-set management interval to ${nextInterval}m after deploy volatility=${args.volatility ?? "unknown"}`);
        }
      } else if (name === "close_position") {
        if (result.already_closed) {
          // Already-closed path: the tool short-circuited because the on-chain
          // account is gone or state was already closed. The management cycle
          // or /close command owns the user-facing message, so no notifyClose.
          // But the ORIGINAL close may have failed after the on-chain close
          // (or bypassed the executor entirely), leaving the base token unsold
          // — so still attempt the auto-swap. swapBaseToSolWithRetry is
          // balance-gated: if the tokens were already swapped it's a no-op.
          log("executor", `Already-closed position ${args.position_address?.slice(0, 8)} — skipping notifyClose, checking for unsold base token`);
          if (!args.skip_swap && result.base_mint) {
            const { swapped, result: swapResult } = await swapBaseToSolWithRetry(result.base_mint, "after already-closed close");
            if (swapped) {
              result.auto_swapped = true;
              result.auto_swap_note = `Leftover base token auto-swapped back to SOL (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
            }
          }
        } else {
          log("executor", `close_position succeeded for ${args.position_address?.slice(0, 8)} — base_mint=${result.base_mint?.slice(0, 12) || "MISSING"} skip_swap=${!!args.skip_swap}`);
          notifyClose({
            pair: result.pool_name || args.position_address?.slice(0, 8),
            pnlUsd: result.pnl_usd ?? 0,
            pnlPct: result.pnl_pct ?? 0,
            reason: result.reason || args.reason,
            feesUsd: result.fees_earned_usd ?? null,
            minutesHeld: result.minutes_held ?? null,
            minutesOOR: result.minutes_out_of_range ?? null,
            peakPnlPct: result.peak_pnl_pct ?? null,
            amountSol: result.amount_sol ?? null,
            initialUsd: result.initial_value_usd ?? null,
            finalUsd: result.final_value_usd ?? null,
          }).catch((e) => log("executor_warn", `notifyClose failed for ${args.position_address?.slice(0, 8)}: ${e?.message || e}`));
          // Note low-yield closes in pool memory so screener avoids redeploying
          if (args.reason && args.reason.toLowerCase().includes("yield")) {
            const poolAddr = result.pool || args.pool_address;
            if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
          }
          // Auto-swap base token back to SOL unless user said to hold (retried).
          if (args.skip_swap) {
            log("executor", `Auto-swap SKIPPED for ${args.position_address?.slice(0, 8)} — args.skip_swap=true (user wanted to hold the base token)`);
          } else if (!result.base_mint) {
            log("executor_warn", `Auto-swap SKIPPED for ${args.position_address?.slice(0, 8)} — result.base_mint is missing! The close tool returned no base_mint, so we don't know what to swap. Report this to the developer.`);
          } else {
            log("executor", `Auto-swap FIRING for ${args.position_address?.slice(0, 8)} base_mint=${result.base_mint.slice(0, 12)}`);
            const { swapped, result: swapResult } = await swapBaseToSolWithRetry(result.base_mint, "after close");
            if (swapped) {
              result.auto_swapped = true;
              result.auto_swap_note = `Base token already auto-swapped back to SOL (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
            }
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        log("executor", `Auto-swap FIRING for claim ${args.position_address?.slice(0, 8)} base_mint=${result.base_mint.slice(0, 12)}`);
        const { swapped, result: swapResult } = await swapBaseToSolWithRetry(result.base_mint, "after claim");
        if (swapped) {
          result.auto_swapped = true;
          result.auto_swap_note = `Claimed base token auto-swapped to SOL (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
          if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && !result.base_mint) {
        log("executor_warn", `Auto-swap after claim SKIPPED for ${args.position_address?.slice(0, 8)} — claim returned no base_mint`);
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;

      // Inject entry market data from pool detail (captured at deploy time)
      const deployDetail = poolThresholds.detail;
      if (deployDetail) {
        args.entry_mcap = numberOrNull(deployDetail?.token_x?.market_cap);
        args.entry_tvl = poolDetailTvl(deployDetail);
        args.entry_volume = numberOrNull(deployDetail?.volume);
        args.entry_holders = numberOrNull(deployDetail?.token_x?.holder_count);
      }

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      // Defense-in-depth: reject deploy if the pool's quote token is not SOL
      if (deployDetail) {
        const quoteMint = deployDetail?.token_y?.address;
        if (quoteMint && quoteMint !== config.tokens.SOL) {
          return {
            pass: false,
            reason: `Pool quote token ${deployDetail.token_y?.symbol || quoteMint.slice(0, 8)} is not SOL — this agent only supports SOL-quoted pools.`,
          };
        }
      }
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(config.minSafeBinsBelow, Number(config.strategy.minBinsBelow ?? config.minSafeBinsBelow));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const floorDecision = checkDeployAmountFloor(args.pool_address, amountY, config.management.deployAmountSol);
      const minDeploy = floorDecision.floor;
      if (!floorDecision.allowed) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (floorDecision.riskSized) {
        log("safety", `Authorized deterministic risk size ${amountY} SOL below configured manual floor ${minDeploy} SOL for ${String(args.pool_address).slice(0, 12)}`);
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
        // Never trust the caller's USD estimate for the tracked cost basis —
        // the SCREENER LLM fills initial_value_usd from its own idea of the
        // SOL price (Jul 13: ~2.3× the live price), and every later PnL that
        // falls back to this basis (external-close backfill, close paths with
        // no live mark) inherits the error as a phantom -57% loss.
        const solPrice = Number(balance.sol_price);
        if (solPrice > 0) {
          const trusted = Math.round(amountY * solPrice * 100) / 100;
          const provided = Number(args.initial_value_usd);
          if (Number.isFinite(provided) && Math.abs(provided - trusted) > trusted * 0.2) {
            log("safety", `Corrected initial_value_usd $${provided} → $${trusted} (${amountY} SOL × $${solPrice})`);
          }
          args.initial_value_usd = trusted;
        }
      }

      return { pass: true };
    }

    case "claim_fees":
    case "close_position": {
      const positionAddress = String(args?.position_address || "").trim();
      if (!positionAddress) {
        return { pass: false, reason: `${name} requires position_address.` };
      }
      const tracked = getTrackedPosition(positionAddress);
      if (!tracked || tracked.closed) {
        // Instead of failing, return success for already-closed positions to handle race conditions gracefully
        log("cron", `Management: ${name} called for already closed position ${positionAddress} — ignoring.`);
        return { pass: true, already_closed: true };
      }
      return { pass: true };
    }

    case "swap_token": {
      const inputMint = String(args?.input_mint || "").trim();
      const outputMint = String(args?.output_mint || "").trim();
      const amount = Number(args?.amount);
      if (!inputMint || !outputMint) {
        return { pass: false, reason: "swap_token requires input_mint and output_mint." };
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return { pass: false, reason: `swap_token amount must be positive and finite, got ${args?.amount}.` };
      }
      if (process.env.DRY_RUN !== "true") {
        const balances = await getWalletBalances();
        if (balances.error) return { pass: false, reason: `Could not verify wallet balance before swap: ${balances.error}` };
        const isSolInput = inputMint === "SOL" || inputMint === config.tokens.SOL;
        const available = isSolInput
          ? Number(balances.sol || 0)
          : Number(balances.tokens?.find((t) => t.mint === inputMint)?.balance || 0);
        if (!Number.isFinite(available) || available <= 0) {
          return { pass: false, reason: `No available balance for input mint ${inputMint}.` };
        }
        if (amount > available) {
          return { pass: false, reason: `Swap amount ${amount} exceeds available balance ${available} for ${inputMint}.` };
        }
      }
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
