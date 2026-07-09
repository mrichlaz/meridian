/**
 * Scoring engine — turns raw tracking data into ranked "pre-pump" signals,
 * and detects "fading" tokens (distribution / exit).
 *
 * The tracked wallets are ARBITRAGE bots: they react to cross-DEX price
 * dislocation, so a rising rate of arb touches is a leading indicator of real
 * two-sided flow — earlier and cleaner than DexScreener's laggy aggregates.
 *
 * ENTRY (confirmed / balanced) — a token qualifies when it is:
 *   - active & fresh     (bot activity in-window, age within bounds)
 *   - not yet pumped     (market cap < PUMP_CEILING_USD)
 *   - liquid / traded    (>= MIN_LIQUIDITY_USD, >= MIN_VOLUME_24H)
 *   - accelerating       (arb-hit velocity rising AND mcap growth accelerating)
 *   - accumulating       (OBV rising)
 *   - in demand          (net buy pressure, >= MIN_DISTINCT_BOTS bots)
 *   - NOT extended       (window mcap growth < EXTENDED_PCT_MAX = don't chase)
 *
 * FADE (avoid dumping) — a flagged token is fading when any of:
 *   - OBV divergence     (price up but OBV rolling over = distribution)
 *   - net selling        (h1 buys < sells)
 *   - liquidity drop     (>= FADE_LIQ_DROP_PCT vs window start = LPs pulling)
 *   - velocity collapse  (arb hits decelerating hard while elevated)
 */
import { getDB } from "./db.js";
import { CONFIG } from "./config.js";
import { holderTrend } from "./holders.js";

const clampPct = (v) => Math.max(-100, Math.min(500, v));
const norm = (v, cap) => Math.max(0, Math.min(1, v / cap));
const growthPct = (a, b) => (a > 0 ? clampPct(((b - a) / a) * 100) : 0);

// ─── Arb activity from the events table (real-time, leading) ───
function arbActivity(db, mint, windowStart, now) {
  const rows = db
    .prepare(
      `SELECT wallet, timestamp FROM events
       WHERE token_mint = ? AND timestamp >= ?`
    )
    .all(mint, windowStart);
  const hits = rows.length;
  const distinctBots = new Set(rows.map((r) => r.wallet).filter(Boolean)).size;
  const mid = (windowStart + now) / 2;
  let older = 0,
    recent = 0;
  for (const r of rows) (r.timestamp >= mid ? recent++ : older++);
  const minutes = (now - windowStart) / 60_000 || 1;
  return {
    hits,
    distinctBots,
    older,
    recent,
    accelerating: recent > older,
    hitsPerMin: hits / minutes,
  };
}

// ─── Price/mcap/volume/OBV momentum from snapshots ───
function momentum(db, mint, windowStart) {
  const snaps = db
    .prepare(
      `SELECT timestamp, price_usd, market_cap, volume_h24, liquidity_usd, obv
       FROM snapshots WHERE mint = ? AND timestamp >= ?
       ORDER BY timestamp ASC`
    )
    .all(mint, windowStart);
  if (snaps.length < 2) return null;

  const first = snaps[0];
  const last = snaps[snaps.length - 1];

  const mcapDeltaPct = growthPct(first.market_cap, last.market_cap);
  const volDeltaPct = growthPct(first.volume_h24, last.volume_h24);
  const obvSlope = last.obv - first.obv;
  const liqDropPct =
    first.liquidity_usd > 0
      ? ((first.liquidity_usd - last.liquidity_usd) / first.liquidity_usd) * 100
      : 0;

  // Acceleration: recent-half mcap growth vs older-half.
  let mcapAccel = 0;
  let obvDivergence = false;
  if (snaps.length >= 3) {
    const midTs = (first.timestamp + last.timestamp) / 2;
    let splitIdx = snaps.findIndex((s) => s.timestamp >= midTs);
    if (splitIdx <= 0) splitIdx = Math.floor(snaps.length / 2);
    if (splitIdx >= snaps.length) splitIdx = snaps.length - 1;
    const mid = snaps[splitIdx];
    mcapAccel =
      growthPct(mid.market_cap, last.market_cap) -
      growthPct(first.market_cap, mid.market_cap);
    // Divergence: price still climbing but OBV rolled over in the recent half.
    const priceUp = last.price_usd > mid.price_usd;
    const obvRolling = last.obv < mid.obv;
    obvDivergence = priceUp && obvRolling;
  }

  return {
    samples: snaps.length,
    mcapDeltaPct,
    mcapAccel,
    volDeltaPct,
    obvSlope,
    obvRising: obvSlope > 0,
    liqDropPct,
    obvDivergence,
  };
}

function ageMin(pairCreatedAt) {
  if (!pairCreatedAt) return null;
  return (Date.now() - pairCreatedAt) / 60_000;
}

/**
 * Rank qualifying pre-pump signals, best first.
 */
export function rankSignals({ limit = 25 } = {}) {
  const db = getDB();
  const now = Date.now();
  const activeCutoff = now - CONFIG.inactiveWindowMin * 60_000;
  const windowStart = now - CONFIG.momentumWindowMin * 60_000;
  const mode = CONFIG.entryMode;

  const candidates = db
    .prepare(
      `SELECT mint, symbol, name, dex, price_usd, liquidity_usd, market_cap,
              fdv, volume_h24, obv, occurrence_count, last_event, last_notified,
              buys_h1, sells_h1, price_change_h1, pair_created_at, safe,
              pump_count, peak_mcap
       FROM tokens
       WHERE pumped = 0 AND faded = 0
         AND symbol IS NOT NULL
         AND last_event >= ?
         AND (market_cap IS NULL OR market_cap < ?)
         AND (liquidity_usd IS NULL OR liquidity_usd >= ?)
         AND (volume_h24 IS NULL OR volume_h24 >= ?)`
    )
    .all(activeCutoff, CONFIG.pumpCeilingUsd, CONFIG.minLiquidityUsd, CONFIG.minVolume24h);

  const signals = [];
  for (const t of candidates) {
    const m = momentum(db, t.mint, windowStart);
    if (!m) continue;
    const arb = arbActivity(db, t.mint, windowStart, now);
    const ht = holderTrend(db, t.mint); // null until >=3 holder samples

    // Base requirement (all modes): genuine upward accumulation.
    if (m.mcapDeltaPct <= 0 || !m.obvRising) continue;

    const netBuys = (t.buys_h1 ?? 0) - (t.sells_h1 ?? 0);
    const age = ageMin(t.pair_created_at);
    const extended = m.mcapDeltaPct >= CONFIG.extendedPctMax;
    const turnover = t.market_cap > 0 ? (t.volume_h24 || 0) / t.market_cap : null;
    const estImpactPct =
      t.liquidity_usd > 0 ? (CONFIG.positionSizeUsd / t.liquidity_usd) * 100 : null;

    // Known-unsafe tokens are vetoed in every mode (cached from safety gate).
    if (CONFIG.safetyChecks && t.safe === 0) continue;

    if (mode !== "early") {
      // Confirmed / balanced gate.
      if (!m.mcapAccel || m.mcapAccel <= 0) continue; // must be accelerating
      if (arb.distinctBots < CONFIG.minDistinctBots) continue; // breadth
      if (CONFIG.requireBuyPressure && netBuys <= 0) continue; // demand
      if (extended) continue; // don't chase what already ran
      if (CONFIG.minTokenAgeMin && age != null && age < CONFIG.minTokenAgeMin) continue;
      if (CONFIG.maxTokenAgeMin && age != null && age > CONFIG.maxTokenAgeMin) continue;
      // Holder trendline: only gate once we actually have a trend to judge.
      if (CONFIG.requireHoldersRising && ht && !ht.rising) continue;
      // Quality: enough turnover to be real, and thin enough that YOUR buy
      // doesn't move the price too much.
      if (turnover != null && turnover < CONFIG.minTurnover) continue;
      if (estImpactPct != null && estImpactPct > CONFIG.maxPriceImpactPct) continue;
      // Require a positive safety verdict when configured.
      if (CONFIG.requireSafe && t.safe !== 1) continue;
    }

    if (mode === "conservative") {
      const liqRatio =
        t.market_cap > 0 ? (t.liquidity_usd || 0) / t.market_cap : 0;
      if (liqRatio < CONFIG.minLiqToMcapRatio) continue; // thin = easy dump
      if (m.obvDivergence || m.liqDropPct >= CONFIG.fadeLiqDropPct) continue;
      if (ht && !ht.rising) continue; // require organic holder growth
    }

    const buyRatio =
      t.sells_h1 > 0 ? t.buys_h1 / t.sells_h1 : t.buys_h1 > 0 ? 2 : 1;

    // Cascading activity factor: the more frequently the arb bots touch a token
    // (hits/min + total window hits + distinct bots + acceleration), the more
    // "active" it is. It multiplies the quality score, so a genuinely busy
    // token cascades above a quiet one with similar momentum.
    const activity =
      0.5 * norm(arb.hitsPerMin, 5) +
      0.3 * norm(arb.hits, 30) +
      0.2 * norm(arb.distinctBots, CONFIG.minDistinctBots + 2);
    const activityMult = 1 + 0.5 * activity + (arb.accelerating ? 0.15 : 0);

    const score =
      (0.20 * norm(m.mcapDeltaPct, 100) +
        0.15 * norm(m.mcapAccel, 50) +
        0.16 * norm(arb.hitsPerMin, 5) +
        0.10 * norm(arb.distinctBots, CONFIG.minDistinctBots + 2) +
        0.12 * norm(m.obvSlope, Math.max(1, t.volume_h24 || 1)) +
        0.09 * norm(buyRatio - 1, 2) +
        0.08 * norm(m.volDeltaPct, 150) +
        0.10 * norm(ht ? ht.deltaPct : 0, 30)) *
      activityMult;

    // Eligibility floor: only strong, genuinely-active tokens are notify-worthy.
    if (score < CONFIG.minSignalScore) continue;
    if (arb.hits < CONFIG.minArbHits) continue;

    signals.push({
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      dex: t.dex,
      price_usd: t.price_usd,
      liquidity_usd: t.liquidity_usd,
      market_cap: t.market_cap,
      fdv: t.fdv,
      volume_h24: t.volume_h24,
      trade_count: t.occurrence_count,
      arb_hits_window: arb.hits,
      arb_per_min: Math.round(arb.hitsPerMin * 10) / 10,
      distinct_bots: arb.distinctBots,
      arb_accelerating: arb.accelerating,
      activity: Math.round(activity * 1000) / 1000,
      activity_mult: Math.round(activityMult * 100) / 100,
      mcap_delta_pct: Math.round(m.mcapDeltaPct * 10) / 10,
      mcap_accel: Math.round(m.mcapAccel * 10) / 10,
      vol_delta_pct: Math.round(m.volDeltaPct * 10) / 10,
      obv: Math.round(t.obv),
      obv_slope: Math.round(m.obvSlope),
      buy_sell_ratio: Math.round(buyRatio * 100) / 100,
      holders: ht ? ht.holders : null,
      holders_delta_pct: ht ? Math.round(ht.deltaPct * 10) / 10 : null,
      holders_per_hr: ht ? Math.round(ht.slopePerHour * 10) / 10 : null,
      holders_rising: ht ? ht.rising : null,
      turnover: turnover != null ? Math.round(turnover * 100) / 100 : null,
      est_impact_pct: estImpactPct != null ? Math.round(estImpactPct * 100) / 100 : null,
      safe: t.safe,
      pump_count: t.pump_count || 0,
      peak_mcap: t.peak_mcap || null,
      age_min: age != null ? Math.round(age) : null,
      samples: m.samples,
      last_event_ago_min: Math.round((now - t.last_event) / 60_000),
      last_notified: t.last_notified,
      score: Math.round(score * 1000) / 1000,
    });
  }

  signals.sort((a, b) => b.score - a.score);
  return signals.slice(0, limit);
}

/**
 * Detect fading (distribution / exit) among tokens we previously flagged.
 * Returns tokens whose momentum has rolled over, with the reason(s) why.
 */
export function detectFades() {
  const db = getDB();
  const now = Date.now();
  const windowStart = now - CONFIG.momentumWindowMin * 60_000;
  const cooldownMs = CONFIG.fadeCooldownMin * 60_000;

  const flagged = db
    .prepare(
      `SELECT mint, symbol, name, market_cap, liquidity_usd, price_usd,
              buys_h1, sells_h1, last_notified, last_fade_notified
       FROM tokens
       WHERE last_notified IS NOT NULL AND pumped = 0 AND faded = 0`
    )
    .all();

  const graceMs = CONFIG.fadeGraceMin * 60_000;
  const fades = [];
  for (const t of flagged) {
    // Only warn about exits on tokens that have been signals for a while — not
    // one we just flagged as a buy this cycle.
    if (!t.last_notified || now - t.last_notified < graceMs) continue;
    if (t.last_fade_notified && now - t.last_fade_notified < cooldownMs) continue;
    const m = momentum(db, t.mint, windowStart);
    if (!m) continue;
    const arb = arbActivity(db, t.mint, windowStart, now);

    const reasons = [];
    if (m.obvDivergence) reasons.push("OBV divergence");
    if ((t.buys_h1 ?? 0) < (t.sells_h1 ?? 0)) reasons.push("net selling");
    if (m.liqDropPct >= CONFIG.fadeLiqDropPct)
      reasons.push(`liquidity -${Math.round(m.liqDropPct)}%`);
    if (arb.hits >= 4 && arb.recent * 2 < arb.older) reasons.push("arb velocity collapse");
    if (!m.obvRising && m.mcapDeltaPct < 0) reasons.push("momentum rollover");
    const ht = holderTrend(db, t.mint);
    if (ht && ht.deltaPct < 0 && ht.slopePerHour < 0) reasons.push("holders declining");

    if (reasons.length) {
      fades.push({
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        market_cap: t.market_cap,
        liquidity_usd: t.liquidity_usd,
        price_usd: t.price_usd,
        reasons,
      });
    }
  }
  return fades;
}

/**
 * Detect SURGE / market-mover events — a sudden buy impulse, distinct from the
 * slow-coil entry signal. Fires when a token shows a fresh spike in traded
 * flow (or an arb burst) with dominant buying, a positive price kick, and
 * rising OBV. Time-sensitive: run on a fast timer.
 */
export function detectSurges() {
  const db = getDB();
  const now = Date.now();
  const windowStart = now - CONFIG.surgeWindowMin * 60_000;
  const activeCutoff = now - CONFIG.inactiveWindowMin * 60_000;
  const cooldownMs = CONFIG.surgeCooldownMin * 60_000;

  const rows = db
    .prepare(
      `SELECT mint, symbol, name, dex, price_usd, market_cap, liquidity_usd,
              volume_h24, buys_h1, sells_h1, last_surge_notified, last_event
       FROM tokens
       WHERE pumped = 0 AND faded = 0 AND symbol IS NOT NULL
         AND last_event >= ?
         AND (market_cap IS NULL OR market_cap < ?)`
    )
    .all(activeCutoff, CONFIG.pumpCeilingUsd);

  const snapStmt = db.prepare(
    `SELECT timestamp, price_usd, obv, flow FROM snapshots
     WHERE mint = ? AND timestamp >= ? ORDER BY timestamp ASC`
  );

  const surges = [];
  for (const t of rows) {
    if (t.last_surge_notified && now - t.last_surge_notified < cooldownMs) continue;
    const snaps = snapStmt.all(t.mint, windowStart);
    if (snaps.length < 3) continue;

    const last = snaps[snaps.length - 1];
    const prev = snaps[snaps.length - 2];
    const recentFlow = last.flow || 0;
    const baseArr = snaps
      .slice(0, -1)
      .map((s) => s.flow || 0)
      .filter((f) => f > 0)
      .sort((a, b) => a - b);
    const baseline = baseArr.length ? baseArr[Math.floor(baseArr.length / 2)] : 0;
    const surgeMult = baseline > 0 ? recentFlow / baseline : recentFlow > 0 ? 99 : 0;

    const priceKickPct =
      prev.price_usd > 0
        ? ((last.price_usd - prev.price_usd) / prev.price_usd) * 100
        : 0;
    const obvJump = last.obv - prev.obv;
    const buyRatio =
      t.sells_h1 > 0 ? t.buys_h1 / t.sells_h1 : t.buys_h1 > 0 ? 3 : 1;
    const arb = arbActivity(db, t.mint, windowStart, now);

    const flowSurge = surgeMult >= CONFIG.surgeFlowMult;
    const arbBurst = arb.hits >= 4 && arb.recent > arb.older * 2;
    const buyDominant = buyRatio >= CONFIG.surgeBuyRatio;
    const priceKick = priceKickPct >= CONFIG.surgeMinPriceKickPct;

    if ((flowSurge || arbBurst) && buyDominant && priceKick && obvJump > 0) {
      const reasons = [];
      if (flowSurge) reasons.push(`flow x${Math.round(surgeMult)}`);
      if (arbBurst) reasons.push(`arb burst ${arb.recent}v${arb.older}`);
      reasons.push(`+${Math.round(priceKickPct)}% kick`);
      reasons.push(`B/S ${Math.round(buyRatio * 10) / 10}`);
      surges.push({
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        dex: t.dex,
        price_usd: t.price_usd,
        market_cap: t.market_cap,
        liquidity_usd: t.liquidity_usd,
        volume_h24: t.volume_h24,
        surge_mult: Math.round(surgeMult * 10) / 10,
        price_kick_pct: Math.round(priceKickPct * 10) / 10,
        buy_sell_ratio: Math.round(buyRatio * 100) / 100,
        distinct_bots: arb.distinctBots,
        arb_per_min: Math.round(arb.hitsPerMin * 10) / 10,
        obv_jump: Math.round(obvJump),
        reasons,
      });
    }
  }
  surges.sort((a, b) => b.surge_mult - a.surge_mult);
  return surges;
}
