/**
 * ML Feature Extraction
 *
 * Extracts standardized numerical feature vectors from Meridian's
 * screening pipeline candidates and performance records.
 *
 * Every candidate pool produces an ~80-dimensional feature vector
 * usable by the Actor-Critic network for deployment scoring.
 *
 * Feature groups:
 *   POOL   — DLMM pool metrics (fee ratio, volatility, TVL, volume, bins)
 *   TOKEN  — Token quality signals (organic, holders, mcap, age, supply)
 *   RISK   — OKX risk data (bundlers, snipers, rug/wash flags)
 *   MOMEN  — Price momentum + technical indicators
 *   SOCIAL — Smart wallets, narrative, discord signals
 *   MEMORY — Pool history (win rate, avg PnL, recent trend)
 *   CONTEXT — Agent state (wallet balance, position count, time)
 */

// ─── Feature dimensions ─────────────────────────────────────────

/**
 * Ordered feature specification. Each entry produces one
 * or more values in the output vector.
 *
 * Index → name, so downstream code can reference
 * features by name rather than magic numbers.
 */
const FEATURE_SPEC = [
  // ─── POOL: DLMM pool structure ─────────────────
  "pool_fee_tvl_ratio",       // 0: fee / active TVL ([0.01, 25+])
  "pool_volatility",           // 1: price volatility ([0.1, 50+])
  "pool_tvl_usd",             // 2: total value locked ($)
  "pool_active_tvl_usd",      // 3: active (in-range) TVL ($)
  "pool_volume_24h",          // 4: 24h volume ($)
  "pool_fee_24h",             // 5: 24h fee revenue ($)
  "pool_bin_step",            // 6: DLMM bin step (1-200)
  "pool_fee_pct",             // 7: pool base fee percent
  "pool_active_pct",          // 8: % of bins occupied
  "pool_active_positions",    // 9: count of active LP positions
  "pool_swap_count",          // 10: swap count in timeframe
  "pool_unique_traders",      // 11: unique trader count

  // ─── TOKEN: base token quality ────────────────
  "token_organic_score",      // 12: organic score (0-100)
  "token_holders",            // 13: holder count
  "token_mcap_usd",           // 14: market cap ($)
  "token_age_hours",          // 15: hours since token creation

  // ─── RISK: OKX enrichment flags ───────────────
  "risk_level",               // 16: 1-5 risk score (higher = riskier)
  "risk_bundle_pct",          // 17: bundle holding %
  "risk_sniper_pct",          // 18: sniper holding %
  "risk_suspicious_pct",      // 19: suspicious wallet holding %
  "risk_is_rugpull",          // 20: boolean
  "risk_is_wash",             // 21: boolean
  "risk_dev_sold_all",        // 22: boolean (BULLISH: dev can't dump)
  "risk_smart_money_buy",     // 23: boolean
  "risk_is_honeypot",         // 24: boolean
  "risk_dex_screener_paid",   // 25: boolean

  // ─── MOMENTUM: price action ───────────────────
  "mom_price_change_pct",     // 26: recent price change %
  "mom_volume_change_pct",    // 27: volume change %
  "mom_fee_change_pct",       // 28: fee change %
  "mom_price_vs_ath_pct",     // 29: price relative to ATH
  "mom_rsi_5m",               // 30: RSI on 5m candles
  "mom_rsi_15m",              // 31: RSI on 15m candles
  "mom_supertrend_bullish",   // 32: boolean

  // ─── SOCIAL: community signals ────────────────
  "social_smart_wallets_count", // 33: tracked smart wallets in pool
  "social_discord_signal",    // 34: boolean
  "social_discord_mentions",  // 35: discord signal count
  "social_bot_traded",        // 36: boolean (bot wallet activity)
  "social_bot_trade_count",   // 37: bot trade event count
  "social_kol_in_clusters",   // 38: boolean (KOLs in holder clusters)
  "social_top_cluster_trend", // 39: -1=sell, 0=neutral, 1=buy

  // ─── MEMORY: pool track record ────────────────
  "mem_total_deploys",        // 40: total deploys to this pool
  "mem_avg_pnl_pct",          // 41: average PnL % across deploys
  "mem_win_rate",             // 42: 0-1 win rate
  "mem_adjusted_win_rate",    // 43: win rate excl. OOR closes
  "mem_last_outcome",         // 44: -1=loss, 0=none, 1=profit
  "mem_is_on_cooldown",       // 45: boolean (pool cooldown active)
  "mem_is_token_cooldown",    // 46: boolean (token cooldown active)
  "mem_recent_snapshot_pnl",  // 47: latest PnL snapshot trend

  // ─── STUDY: top LPer signals ──────────────────
  "study_avg_hold_hours",     // 48: avg hold time of top LPers
  "study_avg_win_rate",       // 49: avg win rate of top LPers
  "study_scalper_ratio",      // 50: ratio of scalpers vs holders

  // ─── NARRATIVE: LLM-generated quality ─────────
  "narrative_quality_score",  // 51: derived from narrative text (0-1)

  // ─── DARWINIAN: learned signal weights ────────
  "darw_organic_score",       // 52: weight
  "darw_fee_tvl_ratio",       // 53: weight
  "darw_volume",              // 54: weight
  "darw_mcap",                // 55: weight
  "darw_holder_count",        // 56: weight
  "darw_smart_wallets",       // 57: weight
  "darw_narrative_quality",   // 58: weight
  "darw_study_win_rate",      // 59: weight
  "darw_hive_consensus",      // 60: weight
  "darw_volatility",          // 61: weight

  // ─── CONTEXT: agent state ─────────────────────
  "ctx_wallet_sol",           // 62: wallet SOL balance
  "ctx_wallet_total_usd",     // 63: wallet total USD
  "ctx_active_positions",     // 64: current position count
  "ctx_max_positions",        // 65: max allowed positions
  "ctx_deploy_amount_sol",    // 66: configured deploy amount
  "ctx_hour_of_day",          // 67: 0-23
  "ctx_day_of_week",          // 68: 0-6

  // ─── ISOLATED: interaction features ───────────
  "isol_feerate_x_volatility", // 69: fee_tvl_ratio * volatility
  "isol_feerate_x_organic",    // 70: fee_tvl_ratio * organic_score
  "isol_volume_per_tvl",       // 71: volume / TVL
  "isol_tvl_per_position",     // 72: TVL / position count
  "isol_holder_density",       // 73: holders / mcap log10
];

const FEATURE_COUNT = FEATURE_SPEC.length;

// ─── Feature name → index lookup ────────────────────────────────

const FEATURE_INDEX = Object.fromEntries(
  FEATURE_SPEC.map((name, idx) => [name, idx]),
);

// ─── Normalisation bounds ───────────────────────────────────────

/**
 * (min, max) pairs for min-max normalisation of each feature.
 * Values outside these bounds are clipped. null = don't normalise (already 0-1).
 */
const NORM_BOUNDS = Object.fromEntries(
  FEATURE_SPEC.map((name) => {
    switch (name) {
      case "pool_fee_tvl_ratio":      return [name, [0, 25]];
      case "pool_volatility":          return [name, [0, 50]];
      case "pool_tvl_usd":             return [name, [0, 500000]];
      case "pool_active_tvl_usd":      return [name, [0, 500000]];
      case "pool_volume_24h":          return [name, [0, 5000000]];
      case "pool_fee_24h":             return [name, [0, 100000]];
      case "pool_bin_step":            return [name, [1, 200]];
      case "pool_fee_pct":             return [name, [0, 10]];
      case "pool_active_pct":          return [name, [0, 1]];
      case "pool_active_positions":    return [name, [0, 200]];
      case "pool_swap_count":          return [name, [0, 100000]];
      case "pool_unique_traders":      return [name, [0, 50000]];
      case "token_organic_score":      return [name, [0, 100]];
      case "token_holders":            return [name, [0, 50000]];
      case "token_mcap_usd":           return [name, [0, 100000000]];
      case "token_age_hours":          return [name, [0, 8760]]; // 1 year
      case "risk_level":               return [name, [1, 5]];
      case "risk_bundle_pct":          return [name, [0, 100]];
      case "risk_sniper_pct":          return [name, [0, 100]];
      case "risk_suspicious_pct":      return [name, [0, 100]];
      case "mom_price_change_pct":     return [name, [-100, 500]];
      case "mom_volume_change_pct":    return [name, [-100, 500]];
      case "mom_fee_change_pct":       return [name, [-100, 500]];
      case "mom_price_vs_ath_pct":     return [name, [0, 200]];
      case "mom_rsi_5m":               return [name, [0, 100]];
      case "mom_rsi_15m":              return [name, [0, 100]];
      case "social_smart_wallets_count": return [name, [0, 20]];
      case "social_discord_mentions":  return [name, [0, 50]];
      case "social_bot_trade_count":   return [name, [0, 100]];
      case "mem_total_deploys":        return [name, [0, 20]];
      case "mem_avg_pnl_pct":          return [name, [-50, 100]];
      case "mem_win_rate":             return [name, null]; // already 0-1
      case "mem_adjusted_win_rate":    return [name, null]; // already 0-1
      case "mem_last_outcome":         return [name, null]; // -1/0/1 already
      case "mem_recent_snapshot_pnl":  return [name, [-50, 100]];
      case "study_avg_hold_hours":     return [name, [0, 720]];
      case "study_avg_win_rate":       return [name, [0, 1]];
      case "study_scalper_ratio":      return [name, [0, 1]];
      case "narrative_quality_score":  return [name, null];
      // darwinian weights already 0.3-2.5
      case "ctx_wallet_sol":           return [name, [0, 200]];
      case "ctx_wallet_total_usd":     return [name, [0, 50000]];
      case "ctx_active_positions":     return [name, [0, 10]];
      case "ctx_max_positions":        return [name, [1, 10]];
      case "ctx_deploy_amount_sol":    return [name, [0, 50]];
      case "ctx_hour_of_day":          return [name, [0, 23]];
      case "ctx_day_of_week":          return [name, [0, 6]];
      case "isol_feerate_x_volatility": return [name, [0, 500]];
      case "isol_feerate_x_organic":   return [name, [0, 2500]];
      case "isol_volume_per_tvl":      return [name, [0, 500]];
      case "isol_tvl_per_position":    return [name, [0, 500000]];
      case "isol_holder_density":      return [name, [-10, 10]];
      default: return [name, null]; // booleans are already 0/1
    }
  }),
);

// ─── Feature extraction ─────────────────────────────────────────

/**
 * Extract a feature vector from a screening candidate + context.
 *
 * @param {Object} opts
 * @param {Object} opts.candidate — condensed pool from screening pipeline
 * @param {Object} [opts.poolMemory] — from pool-memory.js recallForPool()
 * @param {Object} [opts.signalWeights] — from signal-weights.js getWeightsSummary()
 * @param {Object} [opts.studyData] — from tools/study.js
 * @param {Object} [opts.context] — agent-level context
 * @returns {Float64Array} feature vector, length FEATURE_COUNT
 */
export function extractFeatures({
  candidate,
  poolMemory = null,
  signalWeights = null,
  studyData = null,
  context = {},
} = {}) {
  const vec = new Float64Array(FEATURE_COUNT);
  const c = candidate || {};

  // ─── POOL ──────────────────────────────────────
  vec[FEATURE_INDEX.pool_fee_tvl_ratio] = numeric(c.fee_active_tvl_ratio, 0);
  vec[FEATURE_INDEX.pool_volatility] = numeric(c.volatility, 0);
  vec[FEATURE_INDEX.pool_tvl_usd] = numeric(c.tvl, 0);
  vec[FEATURE_INDEX.pool_active_tvl_usd] = numeric(c.active_tvl, 0);
  vec[FEATURE_INDEX.pool_volume_24h] = numeric(c.volume_window, 0);
  vec[FEATURE_INDEX.pool_fee_24h] = numeric(c.fee_window, 0);
  vec[FEATURE_INDEX.pool_bin_step] = numeric(c.bin_step, 100);
  vec[FEATURE_INDEX.pool_fee_pct] = numeric(c.fee_pct, 0);
  vec[FEATURE_INDEX.pool_active_pct] = numeric(c.active_pct, 0);
  vec[FEATURE_INDEX.pool_active_positions] = numeric(c.active_positions, 0);
  vec[FEATURE_INDEX.pool_swap_count] = numeric(c.swap_count, 0);
  vec[FEATURE_INDEX.pool_unique_traders] = numeric(c.unique_traders, 0);

  // ─── TOKEN ─────────────────────────────────────
  vec[FEATURE_INDEX.token_organic_score] = numeric(c.organic_score, 0);
  vec[FEATURE_INDEX.token_holders] = numeric(c.holders, 0);
  vec[FEATURE_INDEX.token_mcap_usd] = numeric(c.mcap, 0);
  vec[FEATURE_INDEX.token_age_hours] = numeric(c.token_age_hours, 0);

  // ─── RISK ──────────────────────────────────────
  vec[FEATURE_INDEX.risk_level] = numeric(c.risk_level, 1);
  vec[FEATURE_INDEX.risk_bundle_pct] = numeric(c.bundle_pct, 0);
  vec[FEATURE_INDEX.risk_sniper_pct] = numeric(c.sniper_pct, 0);
  vec[FEATURE_INDEX.risk_suspicious_pct] = numeric(c.suspicious_pct, 0);
  vec[FEATURE_INDEX.risk_is_rugpull] = c.is_rugpull === true ? 1 : 0;
  vec[FEATURE_INDEX.risk_is_wash] = c.is_wash === true ? 1 : 0;
  vec[FEATURE_INDEX.risk_dev_sold_all] = c.dev_sold_all === true ? 1 : 0;
  vec[FEATURE_INDEX.risk_smart_money_buy] = c.smart_money_buy === true ? 1 : 0;
  vec[FEATURE_INDEX.risk_is_honeypot] = c.is_honeypot === true ? 1 : 0;
  vec[FEATURE_INDEX.risk_dex_screener_paid] = c.dex_screener_paid === true ? 1 : 0;

  // ─── MOMENTUM ──────────────────────────────────
  vec[FEATURE_INDEX.mom_price_change_pct] = numeric(c.price_change_pct, 0);
  vec[FEATURE_INDEX.mom_volume_change_pct] = numeric(c.volume_change_pct, 0);
  vec[FEATURE_INDEX.mom_fee_change_pct] = numeric(c.fee_change_pct, 0);
  vec[FEATURE_INDEX.mom_price_vs_ath_pct] = numeric(c.price_vs_ath_pct, 100);
  vec[FEATURE_INDEX.mom_rsi_5m] = numeric(c.rsi_5m, 50);
  vec[FEATURE_INDEX.mom_rsi_15m] = numeric(c.rsi_15m, 50);
  vec[FEATURE_INDEX.mom_supertrend_bullish] = c.supertrend_bullish === true ? 1 : 0;

  // ─── SOCIAL ────────────────────────────────────
  vec[FEATURE_INDEX.social_smart_wallets_count] =
    (c.sw && Array.isArray(c.sw.in_pool) ? c.sw.in_pool.length : 0) +
    (c.smart_wallets_count || 0);
  vec[FEATURE_INDEX.social_discord_signal] = c.discord_signal === true ? 1 : 0;
  vec[FEATURE_INDEX.social_discord_mentions] = numeric(c.discord_signal_count, 0);
  vec[FEATURE_INDEX.social_bot_traded] = c.bot_traded === true ? 1 : 0;
  vec[FEATURE_INDEX.social_bot_trade_count] = numeric(c.bot_trade_count, 0);
  vec[FEATURE_INDEX.social_kol_in_clusters] = c.kol_in_clusters === true ? 1 : 0;
  vec[FEATURE_INDEX.social_top_cluster_trend] =
    c.top_cluster_trend === "buy" ? 1 :
    c.top_cluster_trend === "sell" ? -1 : 0;

  // ─── MEMORY ────────────────────────────────────
  if (poolMemory) {
    vec[FEATURE_INDEX.mem_total_deploys] = numeric(poolMemory.total_deploys, 0);
    vec[FEATURE_INDEX.mem_avg_pnl_pct] = numeric(poolMemory.avg_pnl_pct, 0);
    vec[FEATURE_INDEX.mem_win_rate] = numeric(poolMemory.win_rate, 0) / 100; // stored as 0-100
    vec[FEATURE_INDEX.mem_adjusted_win_rate] = numeric(poolMemory.adjusted_win_rate, 0) / 100;
    vec[FEATURE_INDEX.mem_last_outcome] =
      poolMemory.last_outcome === "profit" ? 1 :
      poolMemory.last_outcome === "loss" ? -1 : 0;
    vec[FEATURE_INDEX.mem_is_on_cooldown] = poolMemory.cooldown_until ? isActive(poolMemory.cooldown_until) : 0;
    vec[FEATURE_INDEX.mem_is_token_cooldown] = poolMemory.base_mint_cooldown_until ? isActive(poolMemory.base_mint_cooldown_until) : 0;
    vec[FEATURE_INDEX.mem_recent_snapshot_pnl] = computeRecentPnlTrend(poolMemory);
  }

  // ─── STUDY ─────────────────────────────────────
  if (studyData) {
    vec[FEATURE_INDEX.study_avg_hold_hours] = numeric(studyData.avg_hold_hours, 0);
    vec[FEATURE_INDEX.study_avg_win_rate] = numeric(studyData.win_rate, 0) / 100;
    vec[FEATURE_INDEX.study_scalper_ratio] = computeScalperRatio(studyData);
  }

  // ─── NARRATIVE ─────────────────────────────────
  vec[FEATURE_INDEX.narrative_quality_score] = deriveNarrativeScore(c);

  // ─── DARWINIAN WEIGHTS ─────────────────────────
  if (signalWeights && typeof signalWeights === "object") {
    const sw = signalWeights;
    vec[FEATURE_INDEX.darw_organic_score] = numeric(sw.organic_score, 1.0);
    vec[FEATURE_INDEX.darw_fee_tvl_ratio] = numeric(sw.fee_tvl_ratio, 1.0);
    vec[FEATURE_INDEX.darw_volume] = numeric(sw.volume, 1.0);
    vec[FEATURE_INDEX.darw_mcap] = numeric(sw.mcap, 1.0);
    vec[FEATURE_INDEX.darw_holder_count] = numeric(sw.holder_count, 1.0);
    vec[FEATURE_INDEX.darw_smart_wallets] = numeric(sw.smart_wallets_present, 1.0);
    vec[FEATURE_INDEX.darw_narrative_quality] = numeric(sw.narrative_quality, 1.0);
    vec[FEATURE_INDEX.darw_study_win_rate] = numeric(sw.study_win_rate, 1.0);
    vec[FEATURE_INDEX.darw_hive_consensus] = numeric(sw.hive_consensus, 1.0);
    vec[FEATURE_INDEX.darw_volatility] = numeric(sw.volatility, 1.0);
  } else {
    // Default all to 1.0
    for (let i = FEATURE_INDEX.darw_organic_score;
         i <= FEATURE_INDEX.darw_volatility; i++) {
      vec[i] = 1.0;
    }
  }

  // ─── CONTEXT ───────────────────────────────────
  vec[FEATURE_INDEX.ctx_wallet_sol] = numeric(context.walletSol, 0);
  vec[FEATURE_INDEX.ctx_wallet_total_usd] = numeric(context.walletTotalUsd, 0);
  vec[FEATURE_INDEX.ctx_active_positions] = numeric(context.activePositions, 0);
  vec[FEATURE_INDEX.ctx_max_positions] = numeric(context.maxPositions, 3);
  vec[FEATURE_INDEX.ctx_deploy_amount_sol] = numeric(context.deployAmountSol, 0.5);
  vec[FEATURE_INDEX.ctx_hour_of_day] = new Date().getUTCHours();
  vec[FEATURE_INDEX.ctx_day_of_week] = new Date().getUTCDay();

  // ─── ISOLATED ──────────────────────────────────
  vec[FEATURE_INDEX.isol_feerate_x_volatility] =
    vec[FEATURE_INDEX.pool_fee_tvl_ratio] * vec[FEATURE_INDEX.pool_volatility];
  vec[FEATURE_INDEX.isol_feerate_x_organic] =
    vec[FEATURE_INDEX.pool_fee_tvl_ratio] * vec[FEATURE_INDEX.token_organic_score];
  vec[FEATURE_INDEX.isol_volume_per_tvl] =
    vec[FEATURE_INDEX.pool_tvl_usd] > 0
      ? vec[FEATURE_INDEX.pool_volume_24h] / vec[FEATURE_INDEX.pool_tvl_usd]
      : 0;
  vec[FEATURE_INDEX.isol_tvl_per_position] =
    vec[FEATURE_INDEX.pool_active_positions] > 0
      ? vec[FEATURE_INDEX.pool_tvl_usd] / vec[FEATURE_INDEX.pool_active_positions]
      : vec[FEATURE_INDEX.pool_tvl_usd];
  vec[FEATURE_INDEX.isol_holder_density] = computeHolderDensity(
    vec[FEATURE_INDEX.token_holders],
    vec[FEATURE_INDEX.token_mcap_usd],
  );

  return vec;
}

/**
 * Normalize a feature vector to [0, 1] range per-feature.
 */
export function normalizeVector(vec) {
  const out = new Float64Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const name = FEATURE_SPEC[i];
    const bounds = NORM_BOUNDS[name];
    if (!bounds) {
      out[i] = clamp(vec[i], 0, 1);
      continue;
    }
    const [lo, hi] = bounds;
    const clamped = clamp(vec[i], lo, hi);
    out[i] = hi === lo ? 0 : (clamped - lo) / (hi - lo);
  }
  return out;
}

/**
 * Extract a feature vector from a closed position performance record
 * (for training — reconstructs the state at deploy time).
 */
export function extractFromPerformance(perf) {
  // Fix #1: If ml_snapshot was stored at deploy time, restore the full
  // 74-dim normalized vector directly. Otherwise fall back to sparse
  // reconstruction from signal_snapshot (legacy positions).
  if (perf.ml_snapshot?.norm) {
    // Full feature vector stored at deploy time — restore exactly
    return new Float64Array(perf.ml_snapshot.norm);
  }

  // Legacy path: sparse reconstruction from Darwinian signal snapshot
  const snapshot = perf.signal_snapshot || {};
  const candidate = {
    fee_active_tvl_ratio: snapshot.fee_tvl_ratio || perf.fee_tvl_ratio,
    volatility: snapshot.volatility || perf.volatility,
    tvl: snapshot.tvl,
    active_tvl: snapshot.active_tvl,
    organic_score: snapshot.organic_score || perf.organic_score,
    holders: snapshot.holder_count || snapshot.holders,
    mcap: snapshot.mcap,
    bin_step: perf.bin_step,
  };
  const context = {
    walletSol: perf.amount_sol || 0,
    activePositions: 1,
    maxPositions: 3,
    deployAmountSol: perf.amount_sol || 0.5,
  };
  return normalizeVector(extractFeatures({ candidate, context }));
}

// ─── Helpers ────────────────────────────────────────────────────

function numeric(value, fallback = 0) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function isActive(isoString) {
  if (!isoString) return false;
  return new Date(isoString) > new Date();
}

function computeRecentPnlTrend(poolMemory) {
  const snaps = poolMemory?.position_snapshots?.slice?.(-3) || [];
  if (snaps.length === 0) return 0;
  const vals = snaps.map((s) => numeric(s.pnl_pct, 0));
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function computeScalperRatio(studyData) {
  const scalpers = numeric(studyData.scalper_count, 0);
  const holders = numeric(studyData.holder_count, 1);
  return scalpers / (scalpers + holders);
}

function deriveNarrativeScore(candidate) {
  const narrative = candidate?.narrative ||
    candidate?.narrative_text ||
    candidate?.n?.narrative || "";
  if (typeof narrative !== "string" || narrative.length < 20) return 0.3;
  const len = narrative.length;
  // Longer (but not absurdly long) narratives tend to indicate
  // more LLM attention, which correlates with better pools.
  return clamp(len / 800, 0, 1);
}

function computeHolderDensity(holders, mcap) {
  if (holders <= 0 || mcap <= 0) return 0;
  // log10 of holders per $1 of mcap — captures concentration
  return Math.log10(holders / (mcap + 1));
}

// ─── Exports ────────────────────────────────────────────────────

export { FEATURE_SPEC, FEATURE_COUNT, FEATURE_INDEX, NORM_BOUNDS };
