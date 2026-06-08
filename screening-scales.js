/**
 * Timeframe-scaled screening defaults (Meteora discovery API + prompt.js floors).
 * fee_active_tvl_ratio and volume are window-dependent — same numeric threshold
 * means very different things on 30m vs 24h.
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

export function normalizeTimeframe(timeframe) {
  const tf = String(timeframe || DEFAULT_TIMEFRAME).trim().toLowerCase();
  return TIMEFRAME_SCREENING_SCALES[tf] ? tf : DEFAULT_TIMEFRAME;
}

export function getScreeningDefaultsForTimeframe(timeframe) {
  const tf = normalizeTimeframe(timeframe);
  return { timeframe: tf, ...TIMEFRAME_SCREENING_SCALES[tf] };
}

/** Returns minFeeActiveTvlRatio + minVolume scaled to the given timeframe. */
export function scaleScreeningToTimeframe(timeframe) {
  const { minFeeActiveTvlRatio, minVolume } = getScreeningDefaultsForTimeframe(timeframe);
  return { minFeeActiveTvlRatio, minVolume };
}

/**
 * Treat a custom threshold as a 5m baseline and scale it linearly by
 * timeframe length when discovery escalates to longer windows.
 */
export function scaleCustomThresholdFrom5mBaseline(value, timeframe) {
  const baseline = Number(value);
  const tf = normalizeTimeframe(timeframe);
  const baseMinutes = TIMEFRAME_MINUTES["5m"];
  const targetMinutes = TIMEFRAME_MINUTES[tf] ?? TIMEFRAME_MINUTES[DEFAULT_TIMEFRAME];
  if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(targetMinutes) || targetMinutes <= 0) {
    return baseline;
  }
  return baseline * (targetMinutes / baseMinutes);
}

export function getEffectiveWindowThresholds({ minFeeActiveTvlRatio, minVolume }, timeframe) {
  const defaults = scaleScreeningToTimeframe(timeframe);
  return {
    minFeeActiveTvlRatio: Number.isFinite(Number(minFeeActiveTvlRatio))
      ? scaleCustomThresholdFrom5mBaseline(Number(minFeeActiveTvlRatio), timeframe)
      : defaults.minFeeActiveTvlRatio,
    minVolume: Number.isFinite(Number(minVolume))
      ? scaleCustomThresholdFrom5mBaseline(Number(minVolume), timeframe)
      : defaults.minVolume,
  };
}
