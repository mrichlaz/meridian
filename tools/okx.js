/**
 * Token analysis — free sources (RugCheck, Birdeye, DexScreener).
 *
 * Keeps the exact same function signatures and return shapes as the
 * upstream so no caller changes are needed. These are free/public APIs.
 */

const RUGCHECK = "https://api.rugcheck.xyz/v1/tokens";
const BIRDEYE = "https://public-api.birdeye.so/public";
const BIRDEYE_HEADERS = {
  "x-api-key": "b8caa23f3c10cde82b5d119b2cb1e5c9",
  accept: "application/json",
};

const pct = (v) => v != null && v !== "" ? parseFloat(v) : null;
const int = (v) => v != null && v !== "" ? parseInt(v, 10) : null;

async function birdeyeFetch(url) {
  const res = await fetch(url, { headers: BIRDEYE_HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const j = await res.json();
  return j.success ? j.data : null;
}

/**
 * Token risk flags — rugpull/wash detection.
 */
export async function getRiskFlags(tokenAddress) {
  try {
    const res = await fetch(`${RUGCHECK}/${tokenAddress}/report`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return {};
    const data = await res.json();
    const highRisks = new Set(
      (data.risks || []).filter((r) => r.level === "danger" || r.level === "warn").map((r) => r.name)
    );
    return {
      is_rugpull: highRisks.has("Liquidity") || highRisks.has("MintAuthority") || data.token?.mintAuthority !== null,
      is_wash: highRisks.has("WashTrading") || highRisks.has("HighConcentration"),
      risk_level: highRisks.size === 0 ? 0 : highRisks.size <= 2 ? 1 : 2,
      source: "rugcheck",
    };
  } catch {
    return {};
  }
}

/**
 * Advanced token info — bundle/sniper/suspicious %, dev history, tags.
 */
export async function getAdvancedInfo(tokenAddress, _chainIndex) {
  try {
    const res = await fetch(`${RUGCHECK}/${tokenAddress}/report`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const top10 = (data.topHolders || []).slice(0, 10);
    const top10_pct = top10.reduce((s, h) => s + (h.pct || 0), 0);
    const tags = [];
    if (data.token?.mintAuthority) tags.push("mintable");
    if (data.token?.freezeAuthority) tags.push("freezable");
    if (data.lp?.burned || data.lp?.holders?.some((h) => h.status === "burned")) tags.push("lpBurned");

    return {
      risk_level:       null,
      bundle_pct:       top10_pct > 50 ? top10_pct : null,
      sniper_pct:       null,
      suspicious_pct:   null,
      dev_holding_pct:  null,
      top10_pct:        top10_pct,
      lp_burned_pct:    data.lp?.burned ? 100 : 0,
      total_fee_sol:    null,
      dev_rug_count:    null,
      dev_token_count:  null,
      creator:          data.token?.creator || null,
      tags,
      is_honeypot:          tags.includes("honeypot"),
      smart_money_buy:      null,
      dev_sold_all:         null,
      dev_buying_more:      null,
      low_liquidity:        data.lp?.liquidity < 1000,
      dex_boost:            null,
      dex_screener_paid:    null,
    };
  } catch {
    return null;
  }
}

/**
 * Top holder clusters — simplified from RugCheck top holders.
 */
export async function getClusterList(tokenAddress, _chainIndex, limit = 5) {
  try {
    const res = await fetch(`${RUGCHECK}/${tokenAddress}/report`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.topHolders || []).slice(0, limit).map((h) => ({
      holding_pct:   h.pct || 0,
      trend:         null,
      avg_hold_days: null,
      pnl_pct:       null,
      buy_vol_usd:   null,
      sell_vol_usd:  null,
      avg_buy_price: null,
      has_kol:       false,
      address_count: 1,
    }));
  } catch {
    return [];
  }
}

/**
 * Price info — from Birdeye (preferred) or DexScreener (fallback).
 */
export async function getPriceInfo(tokenAddress) {
  const bd = await birdeyeFetch(`${BIRDEYE}/token?address=${tokenAddress}`).catch(() => null);
  if (bd) {
    const price = pct(bd.price);
    const maxPrice = pct(bd.ath);
    return {
      price,
      ath:              maxPrice,
      atl:              pct(bd.atl),
      price_vs_ath_pct: maxPrice > 0 && price > 0 ? parseFloat(((price / maxPrice) * 100).toFixed(1)) : null,
      price_change_5m:  pct(bd.priceChange5m),
      price_change_1h:  pct(bd.priceChange1h),
      volume_5m:        pct(bd.volume5m),
      volume_1h:        pct(bd.volume1h),
      holders:          int(bd.holder),
      market_cap:       pct(bd.marketCap),
      liquidity:        pct(bd.liquidity),
    };
  }

  // DexScreener fallback
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const pair = d.pairs?.find((p) => p.chainId === "solana");
    if (!pair) return null;
    return {
      price:            parseFloat(pair.priceUsd || 0),
      ath:              null,
      atl:              null,
      price_vs_ath_pct: null,
      price_change_5m:  null,
      price_change_1h:  pct(pair.priceChange?.h1),
      volume_5m:        null,
      volume_1h:        pair.volume?.h24 ? pct(pair.volume.h24) / 24 : null,
      holders:          null,
      market_cap:       pair.fdv ? pct(pair.fdv) : null,
      liquidity:        pair.liquidity?.usd ? pct(pair.liquidity.usd) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch all in parallel.
 */
export async function getFullTokenAnalysis(tokenAddress, chainIndex) {
  const [advanced, clusters, price, risk] = await Promise.allSettled([
    getAdvancedInfo(tokenAddress, chainIndex),
    getClusterList(tokenAddress, chainIndex),
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
