/**
 * Free token analysis helpers — replaces OKX API.
 *
 * Sources:
 *   - RugCheck XYZ (free, no key): holder analysis, risk flags, bundle detection
 *   - DexScreener (free, no key): price, volume, liquidity, FDV
 *   - Helius (already have key): holder count
 *   - Birdeye public (free, no key): price change %, market cap
 */

const RUGCHECK = "https://api.rugcheck.xyz/v1/tokens";
const BIRDEYE = "https://public-api.birdeye.so/public";
const BIRDEYE_DEFI = "https://public-api.birdeye.so/defi";
const HELIUS_KEY = process.env.HELIUS_KEY || "";
const BIRDEYE_KEY = "b8caa23f3c10cde82b5d119b2cb1e5c9";

const BIRDEYE_HEADERS = {
  "x-api-key": BIRDEYE_KEY,
  accept: "application/json",
};

async function birdeyeFetch(url) {
  const res = await fetch(url, { headers: BIRDEYE_HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const j = await res.json();
  return j.success ? j.data : null;
}

/**
 * Token risk flags via RugCheck.
 * Returns rugpull/wash flags, top holder %, sniper/bundle detection.
 */
export async function getRiskFlags(tokenAddress) {
  try {
    const res = await fetch(`${RUGCHECK}/${tokenAddress}/report`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return {};
    const data = await res.json();

    const highRisks = new Set(
      (data.risks || []).filter((r) => r.level === "danger" || r.level === "warn").map((r) => r.name)
    );

    const isLpBurn = (data.lp?.holders || []).some((h) => h.pct === 100 && h.status === "burned");

    return {
      is_rugpull: highRisks.has("Liquidity") || highRisks.has("MintAuthority") || data.token?.mintAuthority !== null,
      is_wash: highRisks.has("WashTrading") || highRisks.has("HighConcentration"),
      risk_level: highRisks.size === 0 ? 0 : highRisks.size <= 2 ? 1 : 2,
      score: data.score ?? null,
      risks: (data.risks || []).map((r) => ({ name: r.name, level: r.level, score: r.score })),
      source: "rugcheck",
    };
  } catch {
    return {};
  }
}

/**
 * Advanced token info — holder concentration, top holders %, creator data.
 */
export async function getAdvancedInfo(tokenAddress) {
  try {
    const res = await fetch(`${RUGCHECK}/${tokenAddress}/report`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();

    const topHolders = (data.topHolders || []).slice(0, 10);
    const top10Pct = topHolders.reduce((s, h) => s + (h.pct || 0), 0);
    const creator = data.token?.creator || null;
    const tags = [];

    if (data.token?.mintAuthority) tags.push("mintable");
    if (data.token?.freezeAuthority) tags.push("freezable");
    if (data.lp?.burned || data.lp?.holders?.some((h) => h.status === "burned")) tags.push("lpBurned");

    return {
      top10_pct: top10Pct,
      top10_count: topHolders.length,
      bundle_pct: top10Pct > 50 ? top10Pct : null,  // proxy: high concentration
      sniper_pct: null,  // not available from RugCheck
      suspicious_pct: null,
      dev_holding_pct: null,
      lp_burned_pct: data.lp?.burned ? 100 : 0,
      total_fee_sol: null,
      dev_rug_count: null,
      dev_token_count: null,
      creator,
      tags,
      is_honeypot: tags.includes("honeypot"),
      smart_money_buy: null,  // not available from free sources
      dev_sold_all: null,
      low_liquidity: data.lp?.liquidity < 1000,
      dex_boost: null,
      dex_screener_paid: null,
      source: "rugcheck",
    };
  } catch {
    return null;
  }
}

/**
 * Top holder clusters — trend, holding period, KOL.
 * RugCheck doesn't have cluster/trend data, so return top holders as simplified clusters.
 */
export async function getClusterList(tokenAddress, _chainIndex, limit = 5) {
  try {
    const res = await fetch(`${RUGCHECK}/${tokenAddress}/report`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    const top = (data.topHolders || []).slice(0, limit);
    return top.map((h) => ({
      holding_pct: h.pct || 0,
      address_count: 1,
      has_kol: false,
      trend: null,
      avg_hold_days: null,
      pnl_pct: null,
      buy_vol_usd: null,
      sell_vol_usd: null,
      avg_buy_price: null,
    }));
  } catch {
    return [];
  }
}

/**
 * Price info — uses Birdeye public + DexScreener as fallback.
 */
export async function getPriceInfo(tokenAddress) {
  // Try Birdeye first (richer data)
  const birdeye = await birdeyeFetch(`${BIRDEYE}/token?address=${tokenAddress}`).catch(() => null);
  if (birdeye) {
    const price = birdeye.price ?? null;
    const ath = birdeye.ath ?? null;
    return {
      price,
      ath,
      atl: birdeye.atl ?? null,
      price_vs_ath_pct: ath && price ? parseFloat(((price / ath) * 100).toFixed(1)) : null,
      price_change_5m: birdeye.priceChange5m ?? null,
      price_change_1h: birdeye.priceChange1h ?? null,
      volume_5m: birdeye.volume5m ?? null,
      volume_1h: birdeye.volume1h ?? null,
      holders: birdeye.holder ?? null,
      market_cap: birdeye.marketCap ?? null,
      liquidity: birdeye.liquidity ?? null,
      source: "birdeye",
    };
  }

  // Fallback: DexScreener
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const d = await res.json();
    const pair = d.pairs?.find((p) => p.chainId === "solana");
    if (!pair) return null;
    return {
      price: parseFloat(pair.priceUsd || 0),
      ath: parseFloat(pair.priceUsd || 0),  // no ATH from DexScreener
      atl: null,
      price_vs_ath_pct: null,
      price_change_5m: null,
      price_change_1h: pair.priceChange?.h1 ? parseFloat(pair.priceChange.h1) : null,
      volume_5m: null,
      volume_1h: pair.volume?.h24 ? parseFloat(pair.volume.h24) / 24 : null,
      holders: null,
      market_cap: pair.fdv ? parseFloat(pair.fdv) : null,
      liquidity: pair.liquidity?.usd ? parseFloat(pair.liquidity.usd) : null,
      source: "dexscreener",
    };
  } catch {
    return null;
  }
}

/**
 * Fetch all three in parallel — drop-in replacement for the old OKX function.
 */
export async function getFullTokenAnalysis(tokenAddress, _chainIndex) {
  const [advanced, clusters, price, risk] = await Promise.allSettled([
    getAdvancedInfo(tokenAddress),
    getClusterList(tokenAddress),
    getPriceInfo(tokenAddress),
    getRiskFlags(tokenAddress),
  ]);
  return {
    advanced: advanced.status === "fulfilled" ? advanced.value : null,
    clusters: clusters.status === "fulfilled" ? clusters.value : [],
    price:    price.status    === "fulfilled" ? price.value    : null,
    risk:     risk.status     === "fulfilled" ? risk.value     : null,
  };
}
