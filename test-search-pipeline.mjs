// Search-pipeline funnel diagnostic.
// Walks the same path the screening cron uses, but stops before the LLM /
// deploy step so it never broadcasts a transaction. Returns the count at
// every stage so you can see exactly where the funnel narrows.

// index.js imports envcrypt.js but never calls loadEnv() — load .env here so
// the live keys (LLM, GMGN, RPC) are visible to the rest of the imports.
import "dotenv/config";

import {
  discoverPools,
  buildBotTrackerCandidates,
} from "./tools/screening.js";
import { discoverGmgnPools } from "./tools/gmgn.js";
import { getEffectiveWindowThresholds } from "./screening-scales.js";

// mergeCandidatePools is not exported; we duplicate the dedupe key used inside
// the merge so we can show per-source counts at Stage 4. The function in
// screening.js uses the same key shape so the numbers are consistent.
function mergeByMint(meteoraPools, gmgnPools, botTrackerPools) {
  const map = new Map();
  for (const [pool, source] of [
    ...meteoraPools.map(p => [p, "meteora"]),
    ...gmgnPools.map(p => [p, "gmgn"]),
    ...botTrackerPools.map(p => [p, "bot_tracker"]),
  ]) {
    if (!pool) continue;
    const mint = pool.base?.mint || pool.mint || pool.pool;
    if (!mint) continue;
    const existing = map.get(mint) || { ...pool, sources: {} };
    existing.sources = { ...(existing.sources || {}), [source]: true };
    // Prefer the bot-tracker entry for symbol/name (often richest meta)
    if (source === "bot_tracker") Object.assign(existing, pool, { sources: existing.sources });
    else Object.assign(existing, pool, { sources: existing.sources });
    map.set(mint, existing);
  }
  return Array.from(map.values());
}
import { config } from "./config.js";
import { getCryptoBotTokens } from "./tools/crypto-signals.js";
import { getMyPositions } from "./tools/dlmm.js";

const pad = (s, n) => String(s).padEnd(n);
const cnt = (v) => (v == null ? "-" : String(v).padStart(6));

console.log("═══════════════════════════════════════════════════════════════════════════════");
console.log("  SEARCH PIPELINE · LIVE FUNNEL · each stage count");
console.log("═══════════════════════════════════════════════════════════════════════════════");
console.log();
console.log("Config snapshot:");
console.log("  timeframe:               " + config.screening.timeframe);
console.log("  source:                  " + config.screening.source);
console.log("  minMcap / maxMcap:       $" + config.screening.minMcap.toLocaleString() + " / $" + config.screening.maxMcap.toLocaleString());
console.log("  minFeeActiveTvlRatio:    " + config.screening.minFeeActiveTvlRatio);
console.log("  minTvl / maxTvl:         $" + config.screening.minTvl.toLocaleString() + " / $" + (config.screening.maxTvl?.toLocaleString() ?? "n/a"));
console.log("  minVolume:               $" + config.screening.minVolume.toLocaleString());
console.log("  minOrganic:              " + config.screening.minOrganic + "%");
console.log("  minHolders:              " + config.screening.minHolders.toLocaleString());
console.log("  binStep:                 " + config.screening.minBinStep + "–" + config.screening.maxBinStep);
console.log("  botTracker.limit:        " + config.botTracker.limit);
console.log("  botTracker.minLiq / Vol: $" + config.botTracker.minLiquidityUsd.toLocaleString() + " / $" + config.botTracker.minVolume24h.toLocaleString());
console.log();

const positions = await getMyPositions({ force: true });
console.log("Open positions: " + positions.total_positions + " / " + config.risk.maxPositions);
console.log();

// ── Stage 1: Meteora pool discovery (per-ladder step) ─────────────────────
console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
console.log("│ Stage 1 · METEORA pool discovery (per-ladder step)                          │");
console.log("└─────────────────────────────────────────────────────────────────────────────┘");
const meteora = await discoverPools({ page_size: 50 }).catch((e) => ({ error: e.message, pools: [], discovery_timeframe: config.screening.timeframe }));
if (meteora.error) {
  console.log("  error: " + meteora.error);
} else {
  console.log("  usedTimeframe:  " + meteora.discovery_timeframe);
  console.log("  pools returned: " + cnt(meteora.pools?.length));
  const ladder = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"];
  console.log("  threshold-scaling across the ladder (base 5m):");
  console.log("  ┌────────┬────────────────────┬────────────────────┐");
  console.log("  │ tf     │ fee_active_tvl≥    │ volume≥             │");
  console.log("  ├────────┼────────────────────┼────────────────────┤");
  for (const tf of ladder) {
    const t = getEffectiveWindowThresholds({
      minFeeActiveTvlRatio: Number(config.screening.minFeeActiveTvlRatio),
      minVolume: Number(config.screening.minVolume),
    }, tf);
    console.log(`  │ ${tf.padEnd(7)}│ ${t.minFeeActiveTvlRatio.toFixed(4).padEnd(19)}│ $${String(Math.round(t.minVolume)).padEnd(18)}│`);
  }
  console.log("  └────────┴────────────────────┴────────────────────┘");
}
console.log();

// ── Stage 2: GMGN pool discovery ───────────────────────────────────────────
console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
console.log("│ Stage 2 · GMGN pool discovery (per-stage funnel)                            │");
console.log("└─────────────────────────────────────────────────────────────────────────────┘");
const gmgn = await discoverGmgnPools({ limit: 20 }).catch((e) => ({ error: e.message, pools: [], stage_counts: {} }));
if (gmgn.error) {
  console.log("  error: " + gmgn.error);
} else {
  const sc = gmgn.stage_counts || {};
  console.log("  Stage 1 rank:    " + cnt(sc.s1));
  console.log("  Stage 2 info:    " + cnt(sc.s2));
  console.log("  Stage 3 pools:   " + cnt(sc.s3));
  console.log("  Stage 4 indic:   " + cnt(sc.s4));
  console.log("  Stage 5 final:   " + cnt(gmgn.pools?.length));
  if (gmgn.filtered_examples?.length) {
    console.log("  Filtered examples (top 3):");
    for (const fe of gmgn.filtered_examples.slice(0, 3)) {
      console.log("    - " + pad(fe.name, 18) + ": " + (fe.reason || "?").slice(0, 80));
    }
  }
}
console.log();

// ── Stage 3: Bot-tracker candidates ────────────────────────────────────────
console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
console.log("│ Stage 3 · BOT-TRACKER candidates (DB → DLMM pool resolution)                  │");
console.log("└─────────────────────────────────────────────────────────────────────────────┘");
const botConfig = config.botTracker || {};
const botRaw = getCryptoBotTokens({
  limit: botConfig.limit,
  maxAgeMinutes: botConfig.maxAgeMinutes,
  minLiquidityUsd: botConfig.minLiquidityUsd,
  minVolume24h: botConfig.minVolume24h,
});
console.log("  SQL filter returned:  " + cnt(botRaw.tokens?.length));
if (botRaw.tokens?.length) {
  console.log("  Top 5 by trade_count:");
  for (const t of botRaw.tokens.slice(0, 5)) {
    console.log("    " + pad(t.symbol || "?", 12) + " trades=" + String(t.trade_count).padStart(4) + "  liq=$" + (t.liquidity_usd || 0).toFixed(0).padStart(8));
  }
}
const botResolved = await buildBotTrackerCandidates({
  existingPools: meteora.pools || [],
  timeframe: meteora.discovery_timeframe || config.screening.timeframe,
  limit: botConfig.limit,
}).catch((e) => ({ error: e.message, pools: [] }));
if (botResolved.error) {
  console.log("  DLMM pool resolve error: " + botResolved.error);
} else {
  console.log("  DLMM pool resolved:      " + cnt(botResolved.pools?.length));
}
console.log();

// ── Stage 4: Merge across sources ─────────────────────────────────────────
console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
console.log("│ Stage 4 · MERGE (dedupe across meteora + gmgn + bot_tracker)                │");
console.log("└─────────────────────────────────────────────────────────────────────────────┘");
const merged = mergeByMint(
  meteora.pools || [],
  gmgn.pools || [],
  botResolved.pools || [],
);
console.log("  meteora:        " + cnt((meteora.pools || []).length));
console.log("  gmgn:           " + cnt((gmgn.pools || []).length));
console.log("  bot_tracker:    " + cnt((botResolved.pools || []).length));
console.log("  ──────────────────────────");
console.log("  merged unique:  " + cnt(merged.length));
const sources = (merged || []).reduce((acc, p) => {
  const k = Object.entries(p.sources || {}).filter(([_, v]) => v).map(([k]) => k).sort().join("+") || "?";
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});
console.log("  by source tag:");
for (const [k, v] of Object.entries(sources).sort((a, b) => b[1] - a[1])) {
  console.log("    " + k.padEnd(28) + " " + cnt(v));
}
console.log();

// ── Stage 5: post-merge conviction + persistence + indicator filter ──────
console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
console.log("│ Stage 5 · POST-MERGE FILTER (conviction + persistence + indicator)         │");
console.log("└─────────────────────────────────────────────────────────────────────────────┘");

// Apply the same conviction floor that enrichAndFilterCandidates uses, so we
// can show how many merged pools survive into the LLM context. The checks
// mirror getConvictionRejectReason in tools/screening.js.
const MIN_FEE_TVL  = Number(config.screening.minFeeActiveTvlRatio) || 0;
const MIN_ORGANIC  = Number(config.screening.minOrganic) || 0;
const MIN_VOLUME   = Number(config.screening.minVolume) || 0;
const MIN_HOLDERS  = Number(config.screening.minHolders) || 0;
const MAX_TOP10    = Number(config.screening.maxTop10Pct) || 50;

let stage5Pass = 0;
const stage5Rejects = {};
for (const pool of merged) {
  const feeTvl  = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || pool.base?.organic_score || 0);
  const volume  = Number(pool.volume_window || pool.volume || 0);
  const holders = Number(pool.holders || pool.base_token_holders || 0);
  const top10   = Number(pool.top10_pct || pool.holder_top10_pct || 0);
  let reason = null;
  if (!(feeTvl  >= MIN_FEE_TVL))  reason = `fee/active-TVL ${feeTvl} below conviction floor ${MIN_FEE_TVL}`;
  else if (!(organic >= MIN_ORGANIC)) reason = `organic ${organic} below conviction floor ${MIN_ORGANIC}`;
  else if (!(volume  >= MIN_VOLUME))  reason = `volume ${volume} below conviction floor ${MIN_VOLUME}`;
  else if (!(holders >= MIN_HOLDERS)) reason = `holders ${holders} below conviction floor ${MIN_HOLDERS}`;
  else if (top10 && top10 > MAX_TOP10) reason = `top10 ${top10}% above conviction ceiling ${MAX_TOP10}%`;
  if (reason) {
    stage5Rejects[reason] = (stage5Rejects[reason] || 0) + 1;
  } else {
    stage5Pass++;
  }
}
console.log("  starting:    " + cnt(merged.length) + " (after Stage 4 merge)");
console.log("  rejected:    " + cnt(merged.length - stage5Pass));
console.log("  ──────────────────────────");
console.log("  PASS to LLM: " + cnt(stage5Pass));
if (Object.keys(stage5Rejects).length) {
  console.log("  Top reject reasons (count × category):");
  for (const [reason, count] of Object.entries(stage5Rejects).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log("    " + String(count).padStart(4) + "×  " + reason);
  }
}
console.log();

// ── Final funnel summary ──────────────────────────────────────────────────
console.log("┌─────────────────────────────────────────────────────────────────────────────┐");
console.log("│ FUNNEL SUMMARY                                                              │");
console.log("└─────────────────────────────────────────────────────────────────────────────┘");
const all = {
  "Meteora raw pools":          meteora.pools?.length,
  "GMGN raw pools":             gmgn.pools?.length,
  "Bot-tracker raw tokens":     botRaw.tokens?.length,
  "Bot-tracker DLMM resolved":  botResolved.pools?.length,
  "Merged unique (Stage 4)":    merged.length,
  "Post-merge PASS to LLM":     stage5Pass,
  "Would go to LLM":            stage5Pass,
};
for (const [k, v] of Object.entries(all)) {
  console.log("  " + pad(k, 50) + " " + cnt(v));
}
console.log();
console.log("Pipeline stops here. The " + cnt(stage5Pass) + " pool(s) would be sent to the");
console.log("LLM (model=" + (config.screeningModel || config.llm?.model || "cc/claude-sonnet-5") + ") for the");
console.log("deploy/no-deploy decision.");
if (positions.total_positions >= config.risk.maxPositions) {
  console.log();
  console.log("NOTE: " + positions.total_positions + "/" + config.risk.maxPositions + " positions open — screening will short-circuit the deploy");
  console.log("      step regardless of the LLM verdict. Free up a slot (close a position) to enable deploys.");
}
console.log();
console.log("Re-run anytime with:  node test-search-pipeline.mjs");
