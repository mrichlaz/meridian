const LONG_WINDOW = 500;
const RECENT_WINDOW = 200;
const MIN_TOTAL_SAMPLES = 100;
const MIN_BUCKET_SAMPLES = 30;
const MIN_RECENT_BUCKET_SAMPLES = 12;
const MAX_DIMENSION_SCORE = 4;
const MAX_TOTAL_SCORE = 6;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boundedReturn(record) {
  let value = finite(record?.pnl_pct);
  if (value == null) {
    const pnl = finite(record?.pnl_usd);
    const capital = finite(record?.initial_value_usd);
    if (pnl != null && capital > 0) value = (pnl / capital) * 100;
  }
  return value == null ? null : clamp(value, -12, 12);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function binStepBucket(value) {
  const step = finite(value);
  if (step == null || step <= 0) return null;
  if (step <= 80) return "le80";
  if (step <= 100) return "81to100";
  return "gt100";
}

function marketCapBucket(value) {
  const mcap = finite(value);
  if (mcap == null || mcap <= 0) return null;
  if (mcap < 1_000_000) return "lt1m";
  if (mcap <= 3_000_000) return "1to3m";
  return "gt3m";
}

function downsideCoverage(record) {
  const explicit = finite(record?.downside_coverage_pct ?? record?.range_coverage?.downside_pct);
  if (explicit != null) return explicit;
  const bins = finite(record?.bin_range?.bins_below ?? record?.bins_below ?? record?.bin_range);
  const step = finite(record?.bin_step);
  if (bins == null || bins <= 0 || step == null || step <= 0) return null;
  return (1 - (1 + step / 10_000) ** -bins) * 100;
}

function coverageBucket(value) {
  const coverage = finite(value);
  if (coverage == null || coverage <= 0 || coverage > 45.01) return null;
  if (coverage < 25) return "lt25";
  if (coverage <= 35) return "25to35";
  return "35to45";
}

function recordMcap(record) {
  return record?.entry_mcap ?? record?.mcap ?? record?.signal_snapshot?.entry_mcap ?? record?.signal_snapshot?.mcap;
}

function recordBaseMint(record) {
  return record?.base_mint ?? record?.signal_snapshot?.base_mint ?? null;
}

function recordTime(record) {
  return Date.parse(record?.deployed_at || record?.recorded_at || record?.closed_at || "") || 0;
}

function annotateRepeatBuckets(records) {
  const priorByMint = new Map();
  return [...records]
    .sort((a, b) => recordTime(a) - recordTime(b))
    .map((record) => {
      const mint = recordBaseMint(record);
      const time = recordTime(record);
      if (!mint || !time) return { record, repeatBucket: null };
      const recent = (priorByMint.get(mint) || []).filter((timestamp) => time - timestamp <= 24 * 60 * 60 * 1000);
      recent.push(time);
      priorByMint.set(mint, recent);
      const count = recent.length;
      return { record, repeatBucket: count === 1 ? "first" : count <= 4 ? "2to4" : "5plus" };
    });
}

function evaluateBucket(longRows, recentRows, key, bucket) {
  const split = (rows) => {
    const selected = [];
    const other = [];
    for (const row of rows) {
      const outcome = boundedReturn(row.record);
      if (outcome == null || row[key] == null) continue;
      (row[key] === bucket ? selected : other).push(outcome);
    }
    return { selected, other };
  };
  const long = split(longRows);
  const recent = split(recentRows);
  if (long.selected.length < MIN_BUCKET_SAMPLES || long.other.length < MIN_BUCKET_SAMPLES
      || recent.selected.length < MIN_RECENT_BUCKET_SAMPLES || recent.other.length < MIN_RECENT_BUCKET_SAMPLES) {
    return null;
  }
  const longLift = mean(long.selected) - mean(long.other);
  const recentLift = mean(recent.selected) - mean(recent.other);
  if (Math.abs(longLift) < 0.25 || Math.abs(recentLift) < 0.25 || Math.sign(longLift) !== Math.sign(recentLift)) {
    return null;
  }
  const shrinkage = long.selected.length / (long.selected.length + 60);
  const adjustment = clamp(((longLift + recentLift) / 2) * 2 * shrinkage, -MAX_DIMENSION_SCORE, MAX_DIMENSION_SCORE);
  return {
    adjustment: Math.round(adjustment * 10) / 10,
    longLift: Math.round(longLift * 100) / 100,
    recentLift: Math.round(recentLift * 100) / 100,
    samples: long.selected.length,
    recentSamples: recent.selected.length,
  };
}

function dimension(rows, recentRows, key, buckets) {
  return Object.fromEntries(buckets.map((bucket) => [bucket, evaluateBucket(rows, recentRows, key, bucket)]));
}

export function buildAdaptivePreferenceProfile(performance = [], { now = Date.now() } = {}) {
  const valid = performance.filter((record) => boundedReturn(record) != null).slice(-LONG_WINDOW);
  if (valid.length < MIN_TOTAL_SAMPLES) {
    return { ready: false, samples: valid.length, dimensions: {}, rangeTargetPct: null, recentTokenCounts: {} };
  }
  const repeatRows = annotateRepeatBuckets(valid);
  const rows = repeatRows.map(({ record, repeatBucket }) => ({
    record,
    binStep: binStepBucket(record.bin_step),
    mcap: marketCapBucket(recordMcap(record)),
    coverage: coverageBucket(downsideCoverage(record)),
    repeat: repeatBucket,
  }));
  const recentRows = rows.slice(-RECENT_WINDOW);
  const dimensions = {
    binStep: dimension(rows, recentRows, "binStep", ["le80", "81to100", "gt100"]),
    mcap: dimension(rows, recentRows, "mcap", ["lt1m", "1to3m", "gt3m"]),
    coverage: dimension(rows, recentRows, "coverage", ["lt25", "25to35", "35to45"]),
    repeat: dimension(rows, recentRows, "repeat", ["first", "2to4", "5plus"]),
  };
  const coverageCenters = { lt25: 22.5, "25to35": 30, "35to45": 40 };
  const bestCoverage = Object.entries(dimensions.coverage)
    .filter(([, result]) => result?.adjustment > 0)
    .sort((a, b) => b[1].adjustment - a[1].adjustment)[0];
  const recentTokenCounts = {};
  for (const record of valid) {
    const mint = recordBaseMint(record);
    const time = recordTime(record);
    if (mint && time && now - time >= 0 && now - time <= 24 * 60 * 60 * 1000) {
      recentTokenCounts[mint] = (recentTokenCounts[mint] || 0) + 1;
    }
  }
  return {
    ready: true,
    samples: valid.length,
    dimensions,
    rangeTargetPct: bestCoverage ? coverageCenters[bestCoverage[0]] : null,
    recentTokenCounts,
  };
}

export function candidatePreferenceAdjustment(candidate = {}, profile = {}) {
  const dimensions = profile.dimensions || {};
  const mint = candidate.base?.mint || candidate.base_mint || candidate.token_x?.mint || null;
  const repeatCount = mint ? (profile.recentTokenCounts?.[mint] || 0) + 1 : 1;
  const matches = [
    ["bin step", dimensions.binStep, binStepBucket(candidate.bin_step ?? candidate.dlmm_params?.bin_step)],
    ["market cap", dimensions.mcap, marketCapBucket(candidate.mcap ?? candidate.token_x?.market_cap)],
    ["repeat deploy", dimensions.repeat, repeatCount === 1 ? "first" : repeatCount <= 4 ? "2to4" : "5plus"],
  ].flatMap(([name, dimensionResults, bucket]) => {
    const result = dimensionResults?.[bucket];
    if (!result) return [];
    const strongest = Math.max(0, ...Object.values(dimensionResults).filter(Boolean).map((item) => item.adjustment));
    const penalty = clamp(result.adjustment - strongest, -MAX_DIMENSION_SCORE, 0);
    return [{ name, ...result, rawAdjustment: result.adjustment, adjustment: Math.round(penalty * 10) / 10 }];
  });
  // Preferences may demote weak groups but never promote a candidate across
  // the normal policy threshold. Hard gates and trade frequency stay intact.
  const total = clamp(matches.reduce((sum, result) => sum + result.adjustment, 0), -MAX_TOTAL_SCORE, 0);
  return {
    scoreAdjustment: Math.round(total),
    rangeTargetPct: profile.rangeTargetPct ?? null,
    repeatCount,
    evidence: matches,
  };
}

export function applyLearnedRangePreference(binsBelow, binStep, rangeTargetPct) {
  const bins = Math.max(1, Math.round(Number(binsBelow) || 1));
  const step = finite(binStep);
  const target = finite(rangeTargetPct);
  if (step == null || step <= 0 || target == null || target <= 0 || target > 45) return bins;
  const currentCoverage = (1 - (1 + step / 10_000) ** -bins) * 100;
  if (currentCoverage <= 0) return bins;
  const multiplier = clamp(target / currentCoverage, 0.9, 1.1);
  return Math.max(1, Math.round(bins * multiplier));
}

export const ADAPTIVE_PREFERENCE_LIMITS = {
  longWindow: LONG_WINDOW,
  recentWindow: RECENT_WINDOW,
  minTotalSamples: MIN_TOTAL_SAMPLES,
  minBucketSamples: MIN_BUCKET_SAMPLES,
  maxDimensionScore: MAX_DIMENSION_SCORE,
  maxTotalScore: MAX_TOTAL_SCORE,
};
