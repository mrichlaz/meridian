import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";
import { discoverGmgnPools } from "./gmgn.js";
import { scaleScreeningToTimeframe, getEffectiveWindowThresholds } from "../screening-scales.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  // Bundle / sniper / top10 — accept either the OKX/Jupiter flat fields
  // (bundle_pct, sniper_pct, top10_pct) or the GMGN-prefixed equivalents.
  const bundlePct = Number(
    pool.bundle_pct ?? pool.gmgn_bundler_pct ?? pool.gmgn_token_info_bundler_pct ?? 0
  );
  const top10Pct = Number(
    pool.top10_pct
      ?? pool.holder_top10_pct
      ?? pool.gmgn_top10_holder_rate
      ?? 0
  );
  const sniperPct = Number(
    pool.sniper_pct
      ?? pool.gmgn_sniper_count
      ?? 0
  );
  const volatility = Number(pool.volatility || 0);
  const priceVsAthPct = Number(pool.price_vs_ath_pct || 0);
  const pvpPenalty = pool.is_pvp ? 120 : 0;
  const volatilityPenalty = Number.isFinite(volatility) && volatility > 5 ? (volatility - 5) * 18 : 0;
  const athPenalty = Number.isFinite(priceVsAthPct) && priceVsAthPct > 85 ? (priceVsAthPct - 85) * 2.5 : 0;
  return (feeTvl * 1200) + (organic * 12) + (Math.log10(volume + 1) * 80) + (Math.log10(holders + 1) * 60) - (bundlePct * 8) - (top10Pct * 5) - (sniperPct * 6) - pvpPenalty - volatilityPenalty - athPenalty;
}

function hasMinimumConviction(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  const volatility = Number(pool.volatility || 0);
  const smartMoneyBuy = !!pool.smart_money_buy;
  const top10Pct = Number(pool.top10_pct || pool.holder_top10_pct || 0);
  if (!(feeTvl >= 0.03)) return false;
  if (!(organic >= 70)) return false;
  if (!(volume >= 1000)) return false;
  if (!(holders >= 700)) return false;
  if (top10Pct && top10Pct > 50) return false;
  if (Number.isFinite(volatility) && volatility > 8 && !smartMoneyBuy) return false;
  return true;
}

function hasVolumePersistence(pool) {
  const volume5m = Number(pool.volume_5m ?? pool.volume_window ?? 0);
  const volume15m = Number(pool.volume_15m ?? 0);
  const volume30m = Number(pool.volume_30m ?? pool.volume_window ?? 0);
  const volume1h = Number(pool.volume_1h ?? 0);
  const reference = volume30m > 0 ? volume30m : volume1h;

  // If we have a longer-window reference but no 5m snapshot yet (cold start / upstream gap),
  // allow if the longer-window volume is materially positive.
  if (!(volume5m > 0)) {
    return reference >= 500;
  }
  if (!(reference > 0)) return true;
  return reference >= Math.max(volume5m * 1.5, 100);
}

export function chooseAdaptiveDeployProfile(pool, strategyConfig = {}) {
  const ageHours = Number(pool?.token_age_hours ?? NaN);
  const volatility = Number(pool?.volatility ?? NaN);
  let strategy = strategyConfig.strategy || "bid_ask";
  let binsMultiplier = 1;
  let sizeMultiplier = 1;

  if (Number.isFinite(ageHours) && ageHours < 2) {
    return { deployable: false, reason: `token age ${ageHours.toFixed(1)}h below 2h auto-deploy floor` };
  }
  if (Number.isFinite(ageHours) && ageHours >= 2 && ageHours <= 12 && Number.isFinite(volatility) && volatility >= 5) {
    strategy = "spot";
    binsMultiplier = 1.2;
    sizeMultiplier = 0.75;
  } else if (Number.isFinite(ageHours) && ageHours > 12 && Number.isFinite(volatility) && volatility <= 5) {
    strategy = strategyConfig.strategy || "bid_ask";
  }

  return { deployable: true, strategy, binsMultiplier, sizeMultiplier, ageHours, volatility };
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) {
    const volumeFloor = s._baseMinVolume != null && s._timeframe && s._baseMinVolume !== s.minVolume
      ? `${s.minVolume} at ${s._timeframe} (scaled from base ${s._baseMinVolume})`
      : `${s.minVolume}`;
    return `volume ${fmtThresholdValue(volume, 2)} below minVolume ${fmtThresholdValue(s.minVolume, 2)}${s._baseMinVolume != null && s._timeframe && s._baseMinVolume !== s.minVolume ? ` at ${s._timeframe} (scaled from base ${fmtThresholdValue(s._baseMinVolume, 2)})` : ""}`;
  }
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    const feeFloor = s._baseMinFeeActiveTvlRatio != null && s._timeframe && s._baseMinFeeActiveTvlRatio !== s.minFeeActiveTvlRatio
      ? `${fmtThresholdValue(s.minFeeActiveTvlRatio, 4)} at ${s._timeframe} (scaled from base ${fmtThresholdValue(s._baseMinFeeActiveTvlRatio, 4)})`
      : `${fmtThresholdValue(s.minFeeActiveTvlRatio, 4)}`;
    return `fee/active-TVL ${fmtThresholdValue(feeActiveTvlRatio, 4)} below minFeeActiveTvlRatio ${feeFloor}`;
  }
  if (!isUsableVolatility(volatility)) {
    return `volatility ${volatility ?? "unknown"} is unusable`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (
    pool?.discord_signal &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    launchpad &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  const res = await fetch(`${getAgentMeridianBase()}/signals/discord/candidates`, {
    headers: getAgentMeridianHeaders(),
  });
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  // Tag primary-timeframe values on every pool before any overwrite
  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const longResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({
          poolAddress,
          volatility: numeric(pool?.volatility),
          volume: numeric(pool?.volume),
        }))
    )
  );

  const metricsByPool = new Map();
  for (const result of longResults) {
    if (result.status !== "fulfilled") continue;
    metricsByPool.set(result.value.poolAddress, result.value);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const metrics = metricsByPool.get(pool.pool_address);
    if (!metrics) continue;

    pool[`volume_${volatilityTimeframe}`] = metrics.volume;
    pool[`volatility_${volatilityTimeframe}`] = metrics.volatility;

    // Use longer-timeframe values as the canonical ones for filtering
    if (metrics.volatility != null) pool.volatility = metrics.volatility;
    if (metrics.volume != null) pool.volume = metrics.volume;

    // Opportunistically backfill intermediate timeframes for persistence checks
    if (!pool.volume_30m && volatilityTimeframe === "30m" && metrics.volume != null) pool.volume_30m = metrics.volume;
    if (!pool.volume_1h && volatilityTimeframe === "1h" && metrics.volume != null) pool.volume_1h = metrics.volume;
  }

  return rawPools;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      const assets = await searchAssetsBySymbol(mint);
      const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
      return { mint, asset };
    })
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}



/**
 * Refresh live metrics for discord-only signal pools.
 * Their discovery_pool is a snapshot from when the signal was captured — volume/volatility/fee
 * can be 0 even if the pool is active right now. We overwrite with fresh data from the
 * pool discovery API so filtering uses current numbers, not stale ones.
 */
async function refreshDiscordOnlyPools(pools, timeframe) {
  if (!pools.length) return;
  const FIELDS = ["volume", "fee", "active_tvl", "tvl", "volatility", "fee_active_tvl_ratio"];
  const results = await Promise.allSettled(
    pools.map((pool) =>
      fetchPoolDiscoveryDetail({ poolAddress: pool.pool_address, timeframe })
        .then((fresh) => ({ pool, fresh }))
    )
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.fresh) continue;
    const { pool, fresh } = result.value;
    for (const field of FIELDS) {
      const val = numeric(fresh[field]);
      if (val != null) pool[field] = val;
    }
    log("screening", `Discord signal refreshed live data: ${pool.name || pool.pool_address} — vol=${pool.volume?.toFixed(0)} fee=${pool.fee?.toFixed(2)}`);
  }
}

/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const tf = s.timeframe || "5m";
  const requestedWindowThresholds = getEffectiveWindowThresholds({
    minFeeActiveTvlRatio: numeric(s.minFeeActiveTvlRatio),
    minVolume: numeric(s.minVolume),
  }, tf);
  const effectiveFee = requestedWindowThresholds.minFeeActiveTvlRatio;
  const effectiveVolume = requestedWindowThresholds.minVolume;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${effectiveVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${effectiveFee}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");

  // Meteora Pool Discovery does not support 15m. Skip unsupported windows in
  // the escalation ladder instead of failing the whole discovery cycle.
  const ladder = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"];
  const startIdx = ladder.indexOf(s.timeframe);
  const startFrom = startIdx >= 0 ? startIdx : 0;
  let rawPools = [];
  let usedTimeframe = s.timeframe;

  // Walk the ladder one step at a time starting at the configured timeframe.
  // - The initial fetch is also wrapped, so a broken upstream endpoint
  //   (e.g. 15m returning 400) doesn't abort the whole screening cycle.
  // - Empty windows are logged and we step up to the next timeframe.
  for (let i = startFrom; i < ladder.length; i++) {
    const candidate = ladder[i];
    let data;
    try {
      data = await fetchPoolDiscoveryPage({
        page_size,
        filters,
        timeframe: candidate,
        category: s.category,
      });
    } catch (e) {
      log("screening", `${candidate} fetch failed: ${e.message} — skipping to next timeframe if available`);
      if (i < ladder.length - 1) continue;
      break;
    }
    const candidatePools = Array.isArray(data?.data) ? data.data : [];
    if (candidatePools.length > 0) {
      if (candidate !== s.timeframe) {
        log("screening", `${s.timeframe} window empty — fell back to ${candidate} (${candidatePools.length} pools)`);
      }
      usedTimeframe = candidate;
      for (const pool of candidatePools) {
        pool.discovery_timeframe = candidate;
      }
      rawPools = candidatePools;
      break;
    }
    log("screening", `${candidate} window also empty — escalating`);
  }

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
      // Refresh all signal pools with live data since discovery_pool is a stale snapshot.
      // Use the effective discovery timeframe so refreshed metrics stay aligned
      // with the thresholds used later in the cycle.
      await refreshDiscordOnlyPools(rawPools, usedTimeframe);
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      const discordOnlyPools = [];
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
          discordOnlyPools.push(signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
      // Refresh discord-only pools with live data — their discovery_pool is a stale snapshot
      // so volume/volatility/fee may be 0 even when the pool is active right now.
      // Use the effective discovery timeframe so refreshed metrics stay aligned
      // with the thresholds used later in the cycle.
      if (discordOnlyPools.length > 0) {
        await refreshDiscordOnlyPools(discordOnlyPools, usedTimeframe);
      }
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);
  await enrichDiscordSignalLaunchpads(rawPools);

  const effectiveS = {
    ...s,
    ...getEffectiveWindowThresholds({
      minFeeActiveTvlRatio: numeric(s.minFeeActiveTvlRatio),
      minVolume: numeric(s.minVolume),
    }, usedTimeframe),
    _baseMinFeeActiveTvlRatio: numeric(s.minFeeActiveTvlRatio),
    _baseMinVolume: numeric(s.minVolume),
    _timeframe: usedTimeframe,
  };

  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, effectiveS);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: rawPools.length,
    discovery_timeframe: usedTimeframe,
    pools,
    filtered_examples: filteredExamples,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const source = String(config.screening.source || "meteora").toLowerCase();
  if (!["meteora", "gmgn", "merge"].includes(source)) {
    throw new Error(`Invalid screeningSource: ${config.screening.source}. Use meteora, gmgn, or merge.`);
  }

  let discovery;
  if (source === "merge") {
    const meteoraPromise = discoverPools({ page_size: 50 }).catch((error) => ({ total: 0, pools: [], filtered_examples: [{ name: "meteora", reason: error.message }], discovery_timeframe: config.screening.timeframe }));
    const gmgnPromise = discoverGmgnPools({ limit: Math.max(limit, config.gmgn.enrichLimit || 20) }).catch((error) => ({ total: 0, pools: [], filtered_examples: [{ name: "gmgn", reason: error.message }], stage_counts: {}, discovery_timeframe: config.screening.timeframe }));
    const meteoraDiscovery = await meteoraPromise;
    const botTrackerPromise = buildBotTrackerCandidates({
      existingPools: meteoraDiscovery.pools || [],
      timeframe: meteoraDiscovery.discovery_timeframe || config.screening.timeframe || "30m",
      limit: 20,
    }).catch(() => ({ pools: [], filtered_examples: [] }));
    const [gmgnDiscovery, botTrackerDiscovery] = await Promise.all([gmgnPromise, botTrackerPromise]);
    discovery = {
      total: (meteoraDiscovery.total || 0) + (gmgnDiscovery.total || 0) + (botTrackerDiscovery.pools?.length || 0),
      pools: mergeCandidatePools({
        meteoraPools: meteoraDiscovery.pools || [],
        gmgnPools: gmgnDiscovery.pools || [],
        botTrackerPools: botTrackerDiscovery.pools || [],
      }),
      filtered_examples: [
        ...(Array.isArray(meteoraDiscovery.filtered_examples) ? meteoraDiscovery.filtered_examples : []),
        ...(Array.isArray(gmgnDiscovery.filtered_examples) ? gmgnDiscovery.filtered_examples : []),
        ...(Array.isArray(botTrackerDiscovery.filtered_examples) ? botTrackerDiscovery.filtered_examples : []),
      ],
      stage_counts: gmgnDiscovery.stage_counts || null,
      discovery_timeframe: meteoraDiscovery.discovery_timeframe || config.screening.timeframe,
      source_mode: "merge",
    };
  } else {
    discovery = source === "gmgn"
      ? await discoverGmgnPools({ limit: Math.max(limit, config.gmgn.enrichLimit || 20) })
      : await discoverPools({ page_size: 50 });
  }
  let { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // Token blacklist + dev blocklist (Meteora path runs these inside discoverPools; GMGN path does not)
  if (source === "gmgn" || source === "merge") {
    const before = pools.length;
    pools = pools.filter((p) => {
      if (isBlacklisted(p.base?.mint)) {
        log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "blacklisted token");
        return false;
      }
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    if (pools.length < before) log("blacklist", `GMGN: filtered ${before - pools.length} blacklisted/blocked pool(s)`);
  }

  // ── Bot-tracker candidate injection ───────────────────────────
  // For source=merge, bot-tracker candidates are gathered in the first-pass
  // merge layer above. Keep this path for the single-source modes so behavior
  // remains easy to revert.
  if (source !== "merge") {
    try {
      const botTrackerDiscovery = await buildBotTrackerCandidates({
        existingPools: pools,
        timeframe: discovery.discovery_timeframe || config.screening?.timeframe || "30m",
        limit: 20,
      });
      pools.push(...(botTrackerDiscovery.pools || []));
      filteredOut.push(...(botTrackerDiscovery.filtered_examples || []));
    } catch {} // tracker DB missing or empty — skip silently
  }

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const minTvl = Number(config.screening.minTvl ?? 0);
  const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);
  const tf = config.screening.timeframe || "5m";
  const effectiveWindowThresholds = getEffectiveWindowThresholds({
    minFeeActiveTvlRatio: numeric(config.screening.minFeeActiveTvlRatio),
    minVolume: numeric(config.screening.minVolume),
  }, discovery.discovery_timeframe || tf);
  const minFeeActiveTvlRatio = effectiveWindowThresholds.minFeeActiveTvlRatio;

  const eligible = pools
    .filter((p) => {
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${minTvl}`);
        return false;
      }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${maxTvl}`);
        return false;
      }
      const feeActiveTvlRatio = Number(p.fee_active_tvl_ratio);
      if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
        const feeFloor = Number(config.screening.minFeeActiveTvlRatio) !== minFeeActiveTvlRatio
          ? `${fmtThresholdValue(minFeeActiveTvlRatio, 4)} at ${discovery.discovery_timeframe || tf} (scaled from base ${fmtThresholdValue(config.screening.minFeeActiveTvlRatio, 4)})`
          : `${fmtThresholdValue(minFeeActiveTvlRatio, 4)}`;
        pushFilteredReason(filteredOut, p, `fee/active-TVL ${fmtThresholdValue(feeActiveTvlRatio, 4)} below minFeeActiveTvlRatio ${feeFloor}`);
        return false;
      }
      if (!isUsableVolatility(p.volatility)) {
        pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} is unusable`);
        return false;
      }
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);

        const mintShort = p.base.mint.slice(0, 8);
        if (adv.status !== "fulfilled" && price.status !== "fulfilled" && clusters.status !== "fulfilled" && risk.status !== "fulfilled") {
          log("okx", `All OKX data unavailable for ${p.name} (${mintShort})`);
        }

        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }
    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) {
        log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`);
        pushFilteredReason(filteredOut, p, "wash trading flagged");
        return false;
      }
      return true;
    }));

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);

    // Jupiter free-tier enrichment — fills bundle/sniper/top10/bot/dev/etc.
    // when OKX advanced-info is unavailable (402 paywall). Only stamps fields
    // that OKX did not already provide, so the richer source wins.
    if (eligible.length > 0) {
      const jupResults = await Promise.allSettled(
        eligible.map(async (p) => {
          if (!p.base?.mint) return { pool: p.pool, token: null };
          try {
            const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(p.base.mint)}`, { signal: AbortSignal.timeout(8_000) });
            if (!res.ok) return { pool: p.pool, token: null };
            const data = await res.json();
            const token = Array.isArray(data) ? data[0] : data;
            return { pool: p.pool, token: token || null };
          } catch {
            return { pool: p.pool, token: null };
          }
        })
      );
      let enrichedCount = 0;
      for (const r of jupResults) {
        if (r.status !== "fulfilled") continue;
        const { pool: poolAddr, token } = r.value;
        if (!token) continue;
        const pool = eligible.find((p) => p.pool === poolAddr);
        if (!pool) continue;
        const audit = token.audit || {};
        if (pool.bundle_pct == null && audit.bundlerStats?.holdingPct != null) {
          pool.bundle_pct = Number(audit.bundlerStats.holdingPct);
        }
        if (pool.sniper_pct == null && audit.sniperPct != null) {
          pool.sniper_pct = Number(audit.sniperPct);
        }
        if (pool.top10_pct == null && audit.topHoldersPercentage != null) {
          pool.top10_pct = Number(audit.topHoldersPercentage);
        }
        if (audit.botHoldersPercentage != null) {
          pool.bot_holders_pct = Number(audit.botHoldersPercentage);
        }
        if (audit.devBalancePercentage != null) {
          pool.dev_pct = Number(audit.devBalancePercentage);
        }
        if (audit.devMigrations != null && pool.dev_migrations == null) {
          pool.dev_migrations = Number(audit.devMigrations);
        }
        if (audit.insiderPct != null && pool.insider_pct == null) {
          pool.insider_pct = Number(audit.insiderPct);
        }
        enrichedCount++;
      }
      if (enrichedCount > 0) log("screening", `Jupiter free enrichment: stamped ${enrichedCount} pool(s) with bundle/sniper/top10/bot/dev fields`);
    }

    // ── Risk bucket + volume profile labels (1A, 1B) ─────────────────
    // These are ADVISORY labels only — they don't filter anyone out.
    // The downstream `hasMinimumConviction()` and the score still do all
    // the actual policy work; the labels just make it easier for the
    // LLM to reason about borderline candidates and for the
    // screening-snapshot logs to be self-explanatory.
    for (const pool of eligible) {
      pool.risk_bucket = classifyRiskBucket(pool);
      pool.volume_profile = classifyVolumeProfile(pool);
      pool.rejection_reasons = deriveRejectionReasons(pool, config);
    }
  }

  if (eligible.length > 0) {
    const beforePersistence = eligible.length;
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (hasVolumePersistence(p)) return true;
      pushFilteredReason(filteredOut, p, "volume persistence weak");
      return false;
    }));
    if (eligible.length < beforePersistence) {
      log("screening", `Volume persistence filter removed ${beforePersistence - eligible.length} candidate(s)`);
    }
  }

  if (eligible.length > 0) {
    const beforeConviction = eligible.length;
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (hasMinimumConviction(p)) return true;
      pushFilteredReason(filteredOut, p, "below conviction floor");
      return false;
    }));
    if (eligible.length < beforeConviction) {
      log("screening", `Conviction floor removed ${beforeConviction - eligible.length} candidate(s)`);
    }
  }

  if (config.indicators.enabled && eligible.length > 0) {
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const confirmation = await confirmIndicatorPreset({
            mint: pool.base?.mint,
            side: "entry",
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: `Indicator confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  return {
    candidates: eligible,
    total_eligible: eligible.length,
    total_screened: pools.length,
    filtered_examples: filteredOut.slice(0, 3),
    discovery_timeframe: discovery.discovery_timeframe || config.screening.timeframe,
    bot_tracked_injected: pools.some((p) => p.bot_traded),
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),

    // Per-timeframe breakdown (populated when sourceTimeframe !== volatilityTimeframe)
    ...(p.volatility_timeframe && p.volatility_timeframe !== config.screening.timeframe ? {
      [`volume_${config.screening.timeframe}`]: round(p[`volume_${config.screening.timeframe}`] ?? null),
      [`volume_${p.volatility_timeframe}`]: round(p[`volume_${p.volatility_timeframe}`] ?? null),
      [`volatility_${config.screening.timeframe}`]: fix(p[`volatility_${config.screening.timeframe}`] ?? null, 4),
      [`volatility_${p.volatility_timeframe}`]: fix(p[`volatility_${p.volatility_timeframe}`] ?? null, 4),
    } : {}),

    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,

    // Bot tracker signal (carried through from injection)
    bot_traded: Boolean(p.bot_traded),
    bot_trade_count: p.bot_trade_count || null,
    volume_5m: round(p.volume_5m ?? null),
    volume_15m: round(p.volume_15m ?? null),
    volume_30m: round(p.volume_30m ?? null),
    volume_1h: round(p.volume_1h ?? null),
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = Number(n);
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

function fmtThresholdValue(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "unknown");
  return Number(n.toFixed(decimals)).toString();
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}

function mergePoolCandidate(existing, incoming, sourceName) {
  if (!existing) {
    return {
      ...incoming,
      sources: {
        meteora: sourceName === "meteora",
        gmgn: sourceName === "gmgn",
        bot_tracker: sourceName === "bot_tracker" || !!incoming.bot_traded,
      },
      source_tags: Array.from(new Set([sourceName, ...(incoming.bot_traded ? ["bot_tracker"] : [])])),
    };
  }

  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value == null) continue;
    if (merged[key] == null || merged[key] === false || merged[key] === 0 || merged[key] === "") {
      merged[key] = value;
    }
  }

  // Prefer richer fee/TVL + activity fields when the incoming candidate has them.
  for (const field of ["fee_active_tvl_ratio", "volume_window", "volume", "tvl", "active_tvl", "volatility", "holders", "mcap", "launchpad"]) {
    if (incoming?.[field] != null) merged[field] = incoming[field];
  }

  merged.sources = {
    meteora: !!(existing.sources?.meteora || sourceName === "meteora"),
    gmgn: !!(existing.sources?.gmgn || sourceName === "gmgn"),
    bot_tracker: !!(existing.sources?.bot_tracker || sourceName === "bot_tracker" || incoming.bot_traded),
  };
  merged.source_tags = Array.from(new Set([...(existing.source_tags || []), sourceName, ...(incoming.bot_traded ? ["bot_tracker"] : [])]));
  return merged;
}

function mergeCandidatePools({ meteoraPools = [], gmgnPools = [], botTrackerPools = [] } = {}) {
  const byKey = new Map();
  const add = (pool, sourceName) => {
    if (!pool) return;
    const poolKey = pool.pool ? `pool:${pool.pool}` : null;
    const mintKey = pool.base?.mint ? `mint:${pool.base.mint}` : null;
    const existingKey = poolKey && byKey.has(poolKey)
      ? poolKey
      : mintKey && byKey.has(mintKey)
        ? mintKey
        : poolKey || mintKey;
    if (!existingKey) return;
    const existing = byKey.get(existingKey) || null;
    const merged = mergePoolCandidate(existing, pool, sourceName);
    byKey.set(existingKey, merged);
    if (poolKey && existingKey !== poolKey) byKey.set(poolKey, merged);
    if (mintKey && existingKey !== mintKey) byKey.set(mintKey, merged);
  };

  for (const pool of meteoraPools) add(pool, "meteora");
  for (const pool of gmgnPools) add(pool, "gmgn");
  for (const pool of botTrackerPools) add(pool, "bot_tracker");

  // Prefer the pool-address keyed entries for the final merged list so we
  // don't double-return pool+mint aliases that point to the same object.

  return Array.from(new Set(
    Array.from(byKey.entries())
      .filter(([key]) => key.startsWith("pool:"))
      .map(([, value]) => value)
  ));
}

async function buildBotTrackerCandidates({ existingPools = [], timeframe, limit = 20 } = {}) {
  const injectedPools = [];
  const filteredExamples = [];
  try {
    const { getCryptoBotTokens } = await import("./crypto-signals.js");
    const botData = getCryptoBotTokens({ limit });
    if (!botData.success || botData.tokens.length === 0) {
      return { pools: injectedPools, filtered_examples: filteredExamples };
    }

    const botMintSet = new Set(botData.tokens.map((t) => t.mint));
    const botTradeCount = new Map(botData.tokens.map((t) => [t.mint, t.trade_count]));

    // Stamp any already-discovered pools that match tracked bot tokens.
    for (const p of existingPools) {
      if (p.base?.mint && botMintSet.has(p.base.mint)) {
        p.bot_traded = true;
        p.bot_trade_count = botTradeCount.get(p.base.mint);
        p.sources = { ...(p.sources || {}), bot_tracker: true };
        p.source_tags = Array.from(new Set([...(p.source_tags || []), "bot_tracker"]));
      }
    }

    const results = await Promise.allSettled(botData.tokens.map(async (t) => {
      const res = await fetch(`https://dlmm.datapi.meteora.ag/pools?query=${t.mint}&limit=1`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const d = await res.json();
      const raw = d?.data?.[0];
      if (!raw) return null;

      let vol = null, volVolume = null, vTime = null;
      let detailTvl = null, detailActiveTvl = null, detailRatio = null, detailMcap = null, detailHolders = null;
      try {
        const detail = await fetchPoolDiscoveryDetail({ poolAddress: raw.address, timeframe });
        if (detail) {
          vol = detail.volatility != null ? Number(detail.volatility) : null;
          volVolume = detail.volume != null ? Number(detail.volume) : null;
          vTime = detail.volatility_timeframe || getVolatilityTimeframe(timeframe);
          detailTvl = detail.tvl != null ? Number(detail.tvl) : null;
          detailActiveTvl = detail.active_tvl != null ? Number(detail.active_tvl) : null;
          detailRatio = detail.fee_active_tvl_ratio != null ? Number(detail.fee_active_tvl_ratio) : null;
          detailMcap = detail.token_x?.market_cap != null ? Number(detail.token_x.market_cap) : null;
          detailHolders = detail.token_x?.holders != null ? Number(detail.token_x.holders) : null;
        }
      } catch {}

      return condensePool({
        pool_address: raw.address,
        name: raw.name,
        token_x: { ...raw.token_x, symbol: raw.token_x?.symbol || t.symbol, address: raw.token_x?.address || t.mint, market_cap: detailMcap ?? raw.token_x?.market_cap },
        token_y: raw.token_y,
        pool_type: null,
        dlmm_params: raw.pool_config,
        fee_pct: raw.dynamic_fee_pct || raw.pool_config?.base_fee_pct || null,
        tvl: detailTvl ?? raw.tvl ?? null,
        active_tvl: detailActiveTvl ?? null,
        fee: raw.fees?.[timeframe] ?? null,
        volume: volVolume ?? raw.volume?.[timeframe] ?? null,
        fee_active_tvl_ratio: detailRatio ?? (raw.fee_tvl_ratio?.[timeframe] != null ? Number(raw.fee_tvl_ratio[timeframe]) : null),
        volatility: vol,
        volatility_timeframe: vTime,
        base_token_holders: detailHolders ?? raw.token_x?.holders ?? 0,
        pool_price: raw.current_price ?? null,
        pool_price_change_pct: null,
        price_trend: null,
        min_price: null,
        max_price: null,
        discord_signal: false,
        discord_signal_count: 0,
        active_positions: null,
        active_positions_pct: null,
        open_positions: null,
        bot_traded: true,
        bot_trade_count: t.trade_count,
      });
    }));

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) injectedPools.push(r.value);
    }
  } catch {}
  return { pools: injectedPools, filtered_examples: filteredExamples };
}

// ─── Risk bucket + volume profile labels (1A, 1B) ───────────────────
// These are ADVISORY labels only — they do not filter anyone out.
// The downstream `hasMinimumConviction()` and the score still do all
// the actual policy work; the labels just make it easier for the LLM
// to reason about borderline candidates and for the
// screening-snapshot logs to be self-explanatory.

const HIGH_RISK_BUNDLE_PCT = 25;
const HIGH_RISK_SNIPER_PCT = 20;
const HIGH_RISK_TOP10_PCT = 50;
const NEAR_ATH_PCT = 85;
const PVP_PENALTY_BAR = 1;
const YOUNG_TOKEN_HOURS = 6;
const PERSISTENCE_DEAD_HOURS = 24;

export function classifyRiskBucket(pool) {
  // Hard risk — these pools still go through but the LLM should know
  // they're exposed. If multiple high-risk markers are present, escalate.
  const markers = [];
  if (pool.is_wash) markers.push("wash");
  if (pool.is_rugpull) markers.push("rugpull");
  if (pool.bundle_pct != null && Number(pool.bundle_pct) > HIGH_RISK_BUNDLE_PCT) markers.push(`bundle>${HIGH_RISK_BUNDLE_PCT}`);
  if (pool.sniper_pct != null && Number(pool.sniper_pct) > HIGH_RISK_SNIPER_PCT) markers.push(`sniper>${HIGH_RISK_SNIPER_PCT}`);
  if (pool.top10_pct != null && Number(pool.top10_pct) > HIGH_RISK_TOP10_PCT) markers.push(`top10>${HIGH_RISK_TOP10_PCT}`);
  if (pool.price_vs_ath_pct != null && Number(pool.price_vs_ath_pct) > NEAR_ATH_PCT) markers.push(`near_ath>${NEAR_ATH_PCT}`);
  if (pool.is_pvp) markers.push("pvp");
  if (pool.dev_migrations != null && Number(pool.dev_migrations) > 50) markers.push("dev_migrations>50");
  if (Number(pool.token_age_hours) < YOUNG_TOKEN_HOURS) markers.push(`age<${YOUNG_TOKEN_HOURS}h`);
  if (markers.length >= 2) return { bucket: "high_risk", markers };
  if (markers.length === 1) return { bucket: "elevated_risk", markers };

  // Preferred — clean signal, persistent volume, smart-money or KOL present
  const preferred = [];
  if (Number(pool.organic_score ?? 0) >= 80) preferred.push("high_organic");
  if (pool.smart_money_buy) preferred.push("smart_money_buy");
  if (Number(pool.token_age_hours) >= 24) preferred.push("age>=24h");
  if (preferred.length >= 1) return { bucket: "preferred", markers: preferred };

  return { bucket: "neutral", markers: [] };
}

export function classifyVolumeProfile(pool) {
  const vol5m = Number(pool.volume_5m ?? pool.volume_window ?? 0);
  const vol15m = Number(pool.volume_15m ?? 0);
  const vol30m = Number(pool.volume_30m ?? 0);
  const vol1h = Number(pool.volume_1h ?? 0);
  const tokenAgeHours = Number(pool.token_age_hours ?? 0);

  // No volume at all — likely brand new or illiquid
  if (vol5m <= 0 && vol30m <= 0) {
    if (tokenAgeHours > 0 && tokenAgeHours < PERSISTENCE_DEAD_HOURS) return "bootstrapping";
    return "dead";
  }

  // 5m present but 30m is 0 or much lower — likely a single recent burst
  if (vol5m > 0 && (vol30m === 0 || vol5m > vol30m * 2)) {
    return "burst";
  }

  // 5m significantly lower than 30m — momentum fading
  if (vol30m > 0 && vol5m < vol30m * 0.5) {
    return "cooling";
  }

  // Sustained across multiple windows
  if (vol5m > 0 && (vol30m > 0 || vol1h > 0) && (vol15m > 0 || vol30m > 0)) {
    return "persistent";
  }

  return "neutral";
}

export function deriveRejectionReasons(pool, config) {
  const reasons = [];
  if (!pool) return reasons;
  const s = (config && config.screening) || {};
  if (Number(pool.tvl ?? 0) < Number(s.minTvl ?? 0)) reasons.push("low_tvl");
  if (Number(pool.fee_active_tvl_ratio ?? 0) < Number(s.minFeeActiveTvlRatio ?? 0)) reasons.push("low_fee_tvl");
  if (Number(pool.volume_window ?? 0) < Number(s.minVolume ?? 0)) reasons.push("low_volume");
  if (Number(pool.organic_score ?? 0) < Number(s.minOrganic ?? 0)) reasons.push("low_organic");
  if (Number(pool.holders ?? 0) < Number(s.minHolders ?? 0)) reasons.push("low_holders");
  if (Number(pool.mcap ?? 0) < Number(s.minMcap ?? 0)) reasons.push("low_mcap");
  if (Number(pool.mcap ?? 0) > Number(s.maxMcap ?? Infinity)) reasons.push("high_mcap");
  if (pool.bundle_pct != null && Number(pool.bundle_pct) > Number(s.maxBundlePct ?? 100)) reasons.push("high_bundle");
  if (pool.sniper_pct != null && Number(pool.sniper_pct) > Number(s.maxBotHoldersPct ?? 100)) reasons.push("high_sniper");
  if (pool.bot_holders_pct != null && Number(pool.bot_holders_pct) > Number(s.maxBotHoldersPct ?? 100)) reasons.push("high_bot");
  if (pool.top10_pct != null && Number(pool.top10_pct) > Number(s.maxTop10Pct ?? 100)) reasons.push("high_top10");
  if (Number(pool.token_age_hours) < Number(s.minTokenAgeHours ?? Infinity)) reasons.push("too_young");
  if (s.athFilterPct != null && Number(pool.price_vs_ath_pct ?? 0) > 100 + Number(s.athFilterPct)) reasons.push("near_ath");
  if (Number(pool.volatility ?? 0) <= 0) reasons.push("unusable_volatility");
  return reasons;
}
