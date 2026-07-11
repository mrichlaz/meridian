import { config } from "./config.js";
import { getPerformanceSummary, getPerformanceHistory } from "./lessons.js";

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function getFlowQuality(pool = {}, context = {}) {
  const fee = n(pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio);
  const volatility = n(pool.volatility);
  const feeVolatilityRatio = volatility > 0 ? fee / volatility : 0;
  const volume5m = n(pool.volume_5m ?? pool.volume_window);
  const volume15m = n(pool.volume_15m);
  const volume30m = n(pool.volume_30m ?? pool.volume_window);
  const volume1h = n(pool.volume_1h);
  const reference = volume30m > 0 ? volume30m : volume1h;
  const volumePersistenceRatio = volume5m > 0 && reference > 0 ? reference / volume5m : reference > 500 ? 3 : 0;
  const priceChange1h = n(pool.price_change_1h ?? pool.price_change_1h_pct ?? pool.gmgn_price_action?.priceChangePct ?? context.stats1h?.price_change);
  const netBuyers = n(pool.net_buyers_1h ?? context.stats1h?.net_buyers, null);
  const priceVsAth = n(pool.price_vs_ath_pct ?? pool.gmgn_price_action?.priceVsAthPct, null);
  const top10 = n(pool.top10_pct ?? pool.holder_top10_pct ?? context.audit?.top_holders_pct);
  const bots = n(pool.bot_holders_pct ?? context.audit?.bot_holders_pct);
  const highVolume = n(pool.volume_window ?? volume30m ?? volume1h) >= 5000;
  const toxicReasons = [];
  if (highVolume && priceChange1h < -15) toxicReasons.push("high volume with sharp negative 1h price change");
  if (netBuyers != null && netBuyers < 0 && priceChange1h < 0) toxicReasons.push("negative net buyers with falling price");
  if (top10 > 50 && priceChange1h < 0) toxicReasons.push("concentrated holders while price is falling");
  if (bots > 35 && priceChange1h < 5) toxicReasons.push("bot-heavy holders without strong price confirmation");
  if (priceVsAth != null && priceVsAth > 88 && priceChange1h > 20) toxicReasons.push("overextended near ATH after vertical move");
  // A 30m window CONTAINS the 5m window, so reference must exceed volume5m
  // for the ratio to be meaningful. ratio < 1 means the two fields came from
  // incomparable sources (e.g. both fell back to volume_window, or the 30m
  // backfill used a different measure) — flagging on that is noise, observed
  // as false "weak volume persistence" toxic flags at ratio ~0.9.
  if (volume5m > 0 && reference > volume5m && volumePersistenceRatio < (config.policy?.minVolumePersistence ?? 1.5)) toxicReasons.push("weak volume persistence");
  return {
    feeVolatilityRatio,
    volumePersistenceRatio,
    toxic: toxicReasons.length > 0,
    toxicReasons,
    priceChange1h,
    netBuyers,
    priceVsAth,
  };
}

export function scoreCandidate(pool = {}, context = {}) {
  const fee = n(pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio);
  const organic = n(pool.organic_score);
  const volume = n(pool.volume_window ?? pool.volume_30m ?? pool.volume_1h ?? pool.volume_24h);
  const holders = n(pool.holders ?? pool.base?.holder_count);
  const volatility = n(pool.volatility);
  const age = n(pool.token_age_hours, 24);
  const top10 = n(pool.top10_pct ?? pool.holder_top10_pct ?? context.audit?.top_holders_pct);
  const bots = n(pool.bot_holders_pct ?? context.audit?.bot_holders_pct);
  const bundle = n(pool.bundle_pct ?? pool.gmgn_bundler_pct);
  const smart = pool.smart_money_buy || context.smartWallets?.smart_money_buy ? 8 : 0;
  const flow = getFlowQuality(pool, context);

  let score = 0;
  score += clamp(fee / 0.08, 0, 2) * 20;
  score += clamp(flow.feeVolatilityRatio / Math.max((config.policy?.minFeeVolatilityRatio ?? 0.01) * 2, 0.001), 0, 1.5) * 16;
  score += clamp(flow.volumePersistenceRatio / 3, 0, 1.5) * 10;
  score += clamp(organic / 85, 0, 1.3) * 16;
  score += clamp(Math.log10(volume + 1) / 5, 0, 1.4) * 14;
  score += clamp(Math.log10(holders + 1) / 4, 0, 1.2) * 10;
  score += smart;
  score += age >= 6 && age <= 72 ? 8 : age >= 2 && age < 6 ? -4 : age > 72 && age <= 168 ? 4 : -12;
  score += volatility > 0 && volatility <= 6 ? 6 : volatility > 6 && volatility <= 10 ? -6 : -12;
  score -= clamp((top10 - 35) / 25, 0, 2) * 10;
  score -= clamp((bots - 20) / 20, 0, 2) * 8;
  score -= clamp((bundle - 15) / 20, 0, 2) * 8;
  if (flow.toxic) score -= n(config.policy?.toxicFlowPenalty, 22);
  if (pool.is_pvp) score -= 15;

  const reasons = [...flow.toxicReasons];
  if (fee < 0.03) reasons.push("weak fee/active-TVL");
  if (flow.feeVolatilityRatio < (config.policy?.minFeeVolatilityRatio ?? 0.01)) reasons.push("weak fee/volatility quality");
  if (organic < 70) reasons.push("weak organic score");
  if (volume < 1000) reasons.push("weak volume");
  if (holders < 500) reasons.push("thin holder base");
  if (volatility <= 0) reasons.push("unusable volatility");
  if (top10 > 55) reasons.push("high top-10 concentration");
  if (bots > 35) reasons.push("high bot-holder concentration");

  return { score: Math.round(clamp(score, 0, 100)), reasons, flow };
}

export function getMarketRegime({ performanceSummary = getPerformanceSummary(), recentPerformance = null } = {}) {
  const recent = recentPerformance || getPerformanceHistory({ limit: 12 })?.records || [];
  const last = recent.slice(-6);
  const losses = last.filter((p) => n(p.pnl_usd) < 0).length;
  const pnl = last.reduce((s, p) => s + n(p.pnl_usd), 0);
  const winRate = n(performanceSummary?.win_rate_pct, 50);
  if (last.length >= 3 && (losses >= 3 || pnl < -15 || winRate < 35)) return { regime: "RISK_OFF", minScore: n(config.policy?.riskOffMinScore, 76), sizeMultiplier: 0.5, reason: "recent closed-position performance is weak" };
  if (last.length >= 4 && losses <= 1 && pnl > 10 && winRate >= 55) return { regime: "RISK_ON", minScore: n(config.policy?.riskOnMinScore, 60), sizeMultiplier: 1.1, reason: "recent closed-position performance is healthy" };
  return { regime: "NEUTRAL", minScore: n(config.policy?.neutralMinScore, 66), sizeMultiplier: 1, reason: "normal operating regime" };
}

export function checkCircuitBreaker({ positions = null, balance = null, performanceSummary = getPerformanceSummary() } = {}) {
  // A failed balance lookup (Helius/RPC down, rate-limited right after a
  // restart) returns { sol: 0, error: "..." } — that is NOT a real zero
  // balance, so it must not trip the emergency floor.
  if (balance && !balance.error && n(balance.sol) < 0.25) return { blocked: true, reason: `SOL balance ${balance.sol} below 0.25 emergency floor` };
  if (positions && positions.total_positions >= positions.maxPositions) return { blocked: true, reason: "max positions reached" };
  const recent = getPerformanceHistory({ limit: 6 })?.records || [];
  const last3 = recent.slice(-3);
  if (last3.length === 3 && last3.every((p) => n(p.pnl_usd) < 0)) {
    return { blocked: true, reason: "3 consecutive losing closes — pause deploys until reviewed" };
  }
  if (performanceSummary?.total_positions_closed >= 5 && n(performanceSummary.win_rate_pct) < 25) {
    return { blocked: true, reason: `win rate ${performanceSummary.win_rate_pct}% below 25% circuit breaker` };
  }
  return { blocked: false };
}

export function rankCandidates(entries = [], { regime = getMarketRegime() } = {}) {
  if (config.policy?.enabled === false) {
    return entries.map((entry) => ({ ...entry, policy: { score: 100, reasons: [], flow: getFlowQuality(entry.pool, { audit: entry.ti?.audit, smartWallets: entry.sw }), regime: regime.regime, minScore: 0, disabled: true } }));
  }
  const minFeeVol = n(config.policy?.minFeeVolatilityRatio, 0.01);
  return entries
    .map((entry) => {
      const scored = scoreCandidate(entry.pool, { audit: entry.ti?.audit, smartWallets: entry.sw });
      // Hard EV gate: fee revenue must compensate volatility (adverse-selection
      // proxy). A soft score penalty let high-volume-but-toxic pools through —
      // exactly the trades that produced the left tail. Zero the score so the
      // standard minScore filter (and its reject reporting) handles it.
      if (scored.flow && scored.flow.feeVolatilityRatio < minFeeVol) {
        scored.score = 0;
        scored.reasons.unshift(`fee/volatility ${scored.flow.feeVolatilityRatio.toFixed(4)} below EV floor ${minFeeVol}`);
      }
      return { ...entry, policy: { ...scored, regime: regime.regime, minScore: regime.minScore } };
    })
    .filter((entry) => entry.policy.score >= entry.policy.minScore)
    .sort((a, b) => b.policy.score - a.policy.score);
}

// Quiet hours: UTC hour blocks where deploys size down. "8-12,20-24" =
// half-open ranges [8,12) and [20,24); "22-2" wraps midnight. Both the 30d
// and the Jul 1-7 export windows were net negative only in 08-12 and 20-24
// UTC, and positive everywhere else — a stable out-of-sample pattern.
export function getQuietHourAdjustment(date = new Date()) {
  const spec = String(config.policy?.quietHoursUtc ?? "").trim();
  // Multiplier clamped to [0.1, 1]: 0 would drop the deploy amount to zero and
  // fail deployPosition's positive-amount validation instead of skipping.
  const mult = clamp(n(config.policy?.quietHoursSizeMult, 0.5), 0.1, 1);
  if (!spec || mult >= 1) return { quiet: false, multiplier: 1 };
  const hour = date.getUTCHours();
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) continue;
    const start = Number(m[1]) % 24;
    const end = Number(m[2]) % 24; // "24" ≡ 0 — half-open, so 20-24 covers 20..23
    const inRange = start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
    if (inRange) return { quiet: true, multiplier: mult };
  }
  return { quiet: false, multiplier: 1 };
}

export function sizeMultiplierForScore(score, regime = getMarketRegime()) {
  const confidence = score >= 85 ? 1.25 : score >= 72 ? 1 : 0.65;
  return clamp(confidence * regime.sizeMultiplier, 0.4, 1.25) * getQuietHourAdjustment().multiplier;
}
