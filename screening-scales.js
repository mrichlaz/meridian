/**
 * Timeframe-aware screening thresholds.
 *
 * Not every threshold should scale the same way across windows:
 * - linear: cumulative activity / counts
 * - none: structural / ratio / concentration thresholds that should stay fixed
 * - power: sublinear scaling for rate-like market-quality metrics
 */

export const TIMEFRAME_SCREENING_SCALES = {
  "5m":  { minFeeActiveTvlRatio: 0.02, minVolume: 500 },
  "15m": { minFeeActiveTvlRatio: 0.05, minVolume: 2_000 },
  "30m": { minFeeActiveTvlRatio: 0.15, minVolume: 1_000 },
  "1h":  { minFeeActiveTvlRatio: 0.2,  minVolume: 10_000 },
  "2h":  { minFeeActiveTvlRatio: 0.4,  minVolume: 20_000 },
  "4h":  { minFeeActiveTvlRatio: 0.4,  minVolume: 2_000 },
  "12h": { minFeeActiveTvlRatio: 1.5,  minVolume: 60_000 },
  "24h": { minFeeActiveTvlRatio: 2.0,  minVolume: 10_000 },
};

export const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};

const DEFAULT_TIMEFRAME = "4h";
const POWER_LAW_EXPONENT = 0.72;

export const THRESHOLD_SCALING_RULES = {
  // Linear scale: cumulative activity / counts
  minVolume: "linear",
  minFeeVolume: "linear",
  minTxCount: "linear",
  minUniqueWallets: "linear",
  minNewWallets: "linear",

  // Power-law scale: sublinear scaling for rate-like metrics
  minFeeActiveTvlRatio: "power",
  minVolatility: "power",
  minPriceChange: "power",
  maxSpread: "power",
  maxPriceImpact: "power",
  minBuyPressure: "power",
  maxSellPressure: "power",

  // No scale: structural / concentration constraints
  maxTop10Pct: "none",
  maxBotHoldersPct: "none",
  maxBundlePct: "none",
  minOrganicScore: "none",
  maxConcentration: "none",
  minAuditScore: "none",
  minLiquidity: "none",
  minHolderCount: "none",
  minMarketCap: "none",
};

export function normalizeTimeframe(timeframe) {
  const tf = String(timeframe || DEFAULT_TIMEFRAME).trim().toLowerCase();
  return TIMEFRAME_SCREENING_SCALES[tf] ? tf : DEFAULT_TIMEFRAME;
}

export function getScreeningDefaultsForTimeframe(timeframe) {
  const tf = normalizeTimeframe(timeframe);
  return { timeframe: tf, ...TIMEFRAME_SCREENING_SCALES[tf] };
}

/** Returns default minFeeActiveTvlRatio + minVolume for a timeframe. */
export function scaleScreeningToTimeframe(timeframe) {
  const { minFeeActiveTvlRatio, minVolume } = getScreeningDefaultsForTimeframe(timeframe);
  return { minFeeActiveTvlRatio, minVolume };
}

function timeframeRatio(timeframe) {
  const tf = normalizeTimeframe(timeframe);
  const baseMinutes = TIMEFRAME_MINUTES["5m"];
  const targetMinutes = TIMEFRAME_MINUTES[tf] ?? TIMEFRAME_MINUTES[DEFAULT_TIMEFRAME];
  if (!Number.isFinite(targetMinutes) || targetMinutes <= 0) return 1;
  return targetMinutes / baseMinutes;
}

export function scaleThresholdByMode(value, timeframe, mode = "none") {
  const baseline = Number(value);
  if (!Number.isFinite(baseline) || baseline <= 0) return baseline;
  const ratio = timeframeRatio(timeframe);
  if (!Number.isFinite(ratio) || ratio <= 0) return baseline;

  switch (mode) {
    case "linear":
      return baseline * ratio;
    case "power":
      return baseline * Math.pow(ratio, POWER_LAW_EXPONENT);
    case "none":
    default:
      return baseline;
  }
}

/**
 * Backward-compatible helper. Formerly linear-only; now uses the configured
 * scaling rule for the threshold key when provided, otherwise defaults to none.
 */
export function scaleCustomThresholdFrom5mBaseline(value, timeframe, key = null) {
  const mode = key ? (THRESHOLD_SCALING_RULES[key] || "none") : "none";
  return scaleThresholdByMode(value, timeframe, mode);
}

export function getEffectiveWindowThresholds({ minFeeActiveTvlRatio, minVolume }, timeframe) {
  const defaults = scaleScreeningToTimeframe(timeframe);
  return {
    minFeeActiveTvlRatio: Number.isFinite(Number(minFeeActiveTvlRatio))
      ? scaleThresholdByMode(Number(minFeeActiveTvlRatio), timeframe, THRESHOLD_SCALING_RULES.minFeeActiveTvlRatio)
      : defaults.minFeeActiveTvlRatio,
    minVolume: Number.isFinite(Number(minVolume))
      ? scaleThresholdByMode(Number(minVolume), timeframe, THRESHOLD_SCALING_RULES.minVolume)
      : defaults.minVolume,
  };
}
