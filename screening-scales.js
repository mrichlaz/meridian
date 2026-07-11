/**
 * Timeframe-aware screening thresholds.
 *
 * Not every threshold should scale the same way across windows:
 * - linear: cumulative activity / counts
 * - none: structural / ratio / concentration thresholds that should stay fixed
 * - power: sublinear scaling for rate-like market-quality metrics
 */

export const TIMEFRAME_MINUTES = {
  "5m": 5,
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
  minTxCount: "linear",
  minUniqueWallets: "linear",
  minNewWallets: "linear",

  // Power-law scale: sublinear scaling for rate-like metrics.
  // minVolume is deliberately POWER, not linear: trending pools are bursty,
  // so a pool's 30m volume is nowhere near 6x its current 5m volume.
  // Measured on live pool-discovery data (43 pools present in both windows,
  // Jul 2026): median volume(30m)/volume(5m) = 3.46x — almost exactly the
  // 6^0.72 = 3.63x the power law predicts, while linear (6x) rejected the
  // majority of pools that genuinely qualified at 5m. Linear scaling was why
  // running `timeframe: 30m` produced near-zero deploys.
  minVolume: "power",
  minFeeVolume: "power",
  minFeeActiveTvlRatio: "power",
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
  minVolatility: "none",
  minPriceChange: "none",
};

// Built-in fallback floors (used only when the user's config carries no
// finite minFeeActiveTvlRatio / minVolume). Expressed once as a 5m baseline
// and derived per window via the scaling rules above — the old hand-written
// table had drifted inconsistent (4h volume floor below 1h's, 24h below 12h).
const BASE_5M_DEFAULTS = { minFeeActiveTvlRatio: 0.02, minVolume: 500 };

const scaleByRatio = (value, ratio, mode) =>
  mode === "linear" ? value * ratio
  : mode === "power" ? value * Math.pow(ratio, POWER_LAW_EXPONENT)
  : value;

// Pool discovery API accepts: 5m, 30m, 1h, 2h, 4h, 12h, 24h (no 15m).
export const TIMEFRAME_SCREENING_SCALES = Object.fromEntries(
  Object.entries(TIMEFRAME_MINUTES).map(([tf, minutes]) => {
    const ratio = minutes / TIMEFRAME_MINUTES["5m"];
    const round = (v) => Number(v.toPrecision(3));
    return [tf, {
      minFeeActiveTvlRatio: round(scaleByRatio(BASE_5M_DEFAULTS.minFeeActiveTvlRatio, ratio, THRESHOLD_SCALING_RULES.minFeeActiveTvlRatio)),
      minVolume: round(scaleByRatio(BASE_5M_DEFAULTS.minVolume, ratio, THRESHOLD_SCALING_RULES.minVolume)),
    }];
  })
);

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
