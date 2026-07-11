import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";
import { log } from "../logger.js";

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const LPAGENT_DIRECT_TIMEOUT_MS = 6_000;

export async function studyTopLPers({ pool_address, limit = 4 }) {
  // Direct LPAgent path when the operator has their own key. The Agent
  // Meridian proxy (/top-lp) aggregates the same LPAgent data but takes >8s
  // on uncached pools and regularly trips the screening study timeout; one
  // authenticated call to LPAgent's own /pools/{id}/top-lpers is a single
  // indexed lookup. Network/HTTP errors fall back to the proxy; an empty
  // result is returned as-is (the proxy has no data source we don't).
  if (process.env.LPAGENT_API_KEY) {
    try {
      return await studyViaLpAgentDirect(pool_address, limit);
    } catch (e) {
      log("study", `LPAgent direct top-lpers failed (${e.message}) — falling back to Agent Meridian proxy`);
    }
  }

  const [poolRes, signalRes] = await Promise.all([
    fetchTopLp(pool_address),
    fetchStudyTopLp(pool_address),
  ]);

  const poolData = poolRes;
  const signalData = signalRes;
  const topLpers = Array.isArray(poolData.topLpers) ? poolData.topLpers : [];
  const historicalOwners = Array.isArray(poolData.historicalOwners) ? poolData.historicalOwners : [];
  const ranked = topLpers.slice(0, Math.max(1, limit));

  if (!ranked.length) {
    return {
      pool: pool_address,
      message: "No LPAgent top LPer data found for this pool yet.",
      patterns: {},
      lpers: [],
    };
  }

  const historicalMap = new Map(historicalOwners.map((owner) => [owner.owner, owner]));

  const lpers = ranked.map((owner) => {
    const history = historicalMap.get(owner.owner);
    return {
      owner: owner.owner,
      owner_short: owner.ownerShort || `${owner.owner.slice(0, 8)}...`,
      signal_tags: [
        history?.preferredStrategy ? `strategy:${history.preferredStrategy}` : null,
        history?.preferredRangeStyle ? `range:${history.preferredRangeStyle}` : null,
      ].filter(Boolean),
      summary: {
        total_positions: owner.totalLp || history?.topPositions?.length || 0,
        avg_hold_hours: round(owner.avgAgeHours ?? history?.avgHoldHours ?? 0, 2),
        avg_open_pnl_pct: round(owner.pnlPerInflowPct ?? history?.avgPnlPct ?? 0, 2),
        avg_fee_per_tvl_24h_pct: round(owner.feePercent ?? history?.avgFeePercent ?? 0, 2),
        total_pnl_usd: round(owner.totalPnlUsd ?? 0, 2),
        total_balance_usd: round(owner.totalInflowUsd ?? 0, 2),
        avg_range_width_pct: null,
        avg_distance_to_active_pct: null,
        win_rate: round((owner.winRatePct ?? 0) / 100, 2),
        roi: round((owner.roiPct ?? 0) / 100, 4),
        fee_pct_of_capital: round(owner.feePercent ?? 0, 2),
        preferred_strategy: history?.preferredStrategy || "unknown",
        preferred_range_style: history?.preferredRangeStyle || "unknown",
      },
      positions: Array.isArray(history?.topPositions)
        ? history.topPositions.map((position) => ({
            pool: pool_address,
            pair: poolData.overview?.name || "Unknown pool",
            hold_hours: round(position.ageHours ?? 0, 2),
            pnl_usd: round(position.pnlUsd ?? 0, 2),
            pnl_pct: fmtPct(position.pnlPct),
            fee_usd: round(position.feeUsd ?? 0, 2),
            in_range_pct: position.inRange == null ? null : position.inRange ? 100 : 0,
            strategy: position.strategy || null,
            closed_reason: position.rangeStyle || null,
            balance_usd: round(position.inputValue ?? 0, 2),
            fee_per_tvl_24h_pct: round(position.feePercent ?? 0, 2),
            range_width_pct: position.widthBins ?? null,
            distance_to_active_pct: null,
            lower_bin_id: position.lowerBinId ?? null,
            upper_bin_id: position.upperBinId ?? null,
          }))
        : [],
    };
  });

  const patterns = buildPatterns(ranked, historicalOwners, signalData, poolData.overview || {});

  return {
    pool: pool_address,
    pool_name:
      poolData.overview?.name ||
      `${poolData.overview?.tokenXSymbol || "TOKEN"}-${poolData.overview?.tokenYSymbol || "SOL"}`,
    message:
      "LPAgent-backed top LP study from Agent Meridian 30m cached owner aggregates plus owner historical positions.",
    patterns,
    lpers,
  };
}

// Direct LPAgent open-api study. Returns the same outer shape as the proxy
// path ({ pool, pool_name, message, patterns, lpers }) — the screener only
// consumes `patterns`, the /learn flow reads `lpers` summaries.
async function studyViaLpAgentDirect(poolAddress, limit) {
  const url = `${LPAGENT_API}/pools/${poolAddress}/top-lpers?order_by=total_pnl&sort_order=desc&page=1&limit=${Math.max(1, Math.min(20, limit))}`;
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.LPAGENT_API_KEY },
    signal: AbortSignal.timeout(LPAGENT_DIRECT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  if (!rows.length) {
    return {
      pool: poolAddress,
      message: "No LPAgent top LPer data found for this pool yet.",
      patterns: {},
      lpers: [],
    };
  }

  // win_rate scale is undocumented (fraction vs percent) — normalize to 0-100.
  const asPct = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.abs(n) <= 1 ? n * 100 : n;
  };
  const pnlPerInflowPct = (row) =>
    Number(row.total_inflow) > 0 ? (Number(row.total_pnl) / Number(row.total_inflow)) * 100 : 0;

  const lpers = rows.map((row) => ({
    owner: row.owner,
    owner_short: `${String(row.owner || "").slice(0, 8)}...`,
    signal_tags: [],
    summary: {
      total_positions: Number(row.total_lp) || 0,
      avg_hold_hours: round(row.avg_age_hour, 2),
      avg_open_pnl_pct: round(pnlPerInflowPct(row), 2),
      avg_fee_per_tvl_24h_pct: round(row.fee_percent, 2),
      total_pnl_usd: round(row.total_pnl, 2),
      total_balance_usd: round(row.total_inflow, 2),
      avg_range_width_pct: null,
      avg_distance_to_active_pct: null,
      win_rate: round(asPct(row.win_rate) / 100, 2),
      roi: round(Number(row.roi) || 0, 4),
      fee_pct_of_capital: round(row.fee_percent, 2),
      preferred_strategy: "unknown",
      preferred_range_style: "unknown",
    },
    positions: [],
  }));

  const holds = rows.map((r) => Number(r.avg_age_hour)).filter(isNum);
  const patterns = {
    top_lper_count: rows.length,
    study_mode: "lpagent_direct",
    pool_name: null,
    active_position_count: rows.reduce((sum, r) => sum + (Number(r.total_lp) || 0), 0),
    owner_count: body?.pagination?.totalCount ?? rows.length,
    avg_hold_hours: round(avg(holds), 2),
    avg_open_pnl_pct: round(avg(rows.map(pnlPerInflowPct).filter(isNum)), 2),
    avg_fee_percent: round(avg(rows.map((r) => Number(r.fee_percent)).filter(isNum)), 2),
    avg_roi_pct: round(avg(rows.map((r) => asPct(r.roi)).filter(isNum)), 2),
    best_open_pnl_pct: `${round(pnlPerInflowPct(rows[0]), 2)}%`,
    scalper_count: holds.filter((h) => h < 1).length,
    holder_count: holds.filter((h) => h >= 4).length,
    preferred_strategies: {},
    preferred_range_styles: {},
    top_historical_owners: [],
    suggested_style: null,
  };

  return {
    pool: poolAddress,
    pool_name: null,
    message: "Top LP study fetched directly from LPAgent open-api (per-owner aggregates; no strategy/range-style history on this path).",
    patterns,
    lpers,
  };
}

// Single attempt with a hard client-side timeout. No retry on purpose: the
// dominant failure mode is Agent Meridian relaying an upstream LPAgent 429
// (shared community key rate-limited) — retrying amplifies the rate-limit.
// maxAttempts: 1 uses the retry wrapper solely for its per-attempt timeout.
const PROXY_RETRY = { maxAttempts: 1, perAttemptTimeoutMs: 7_000, maxElapsedMs: 7_500 };

function fetchTopLp(poolAddress) {
  return agentMeridianJson(`/top-lp/${poolAddress}`, {
    headers: getAgentMeridianHeaders(),
    retry: PROXY_RETRY,
  });
}

function fetchStudyTopLp(poolAddress) {
  return agentMeridianJson(`/study-top-lp/${poolAddress}`, {
    headers: getAgentMeridianHeaders(),
    retry: PROXY_RETRY,
  });
}

function buildPatterns(ranked, historicalOwners, signalData, overview) {
  const avgHold = avg(ranked.map((o) => o.avgAgeHours).filter(isNum));
  const avgOpenPnlPct = avg(ranked.map((o) => o.pnlPerInflowPct).filter(isNum));
  const avgFeePct = avg(ranked.map((o) => o.feePercent).filter(isNum));
  const avgRoiPct = avg(ranked.map((o) => o.roiPct).filter(isNum));
  const preferredStrategies = countValues(historicalOwners.map((o) => o.preferredStrategy).filter(Boolean));
  const preferredRanges = countValues(historicalOwners.map((o) => o.preferredRangeStyle).filter(Boolean));

  return {
    top_lper_count: ranked.length,
    study_mode: "lpagent_top_lpers",
    pool_name:
      overview.name || `${overview.tokenXSymbol || "TOKEN"}-${overview.tokenYSymbol || "SOL"}`,
    active_position_count: signalData.activePositionCount ?? ranked.length,
    owner_count: signalData.ownerCount ?? ranked.length,
    avg_hold_hours: round(avgHold, 2),
    avg_open_pnl_pct: round(avgOpenPnlPct, 2),
    avg_fee_percent: round(avgFeePct, 2),
    avg_roi_pct: round(avgRoiPct, 2),
    best_open_pnl_pct: ranked[0] ? `${round(ranked[0].pnlPerInflowPct || 0, 2)}%` : null,
    scalper_count: ranked.filter((o) => (o.avgAgeHours || 0) < 1).length,
    holder_count: ranked.filter((o) => (o.avgAgeHours || 0) >= 4).length,
    preferred_strategies: preferredStrategies,
    preferred_range_styles: preferredRanges,
    top_historical_owners: (signalData.topHistoricalOwners || []).slice(0, 3),
    suggested_style: signalData.suggestedStyle || null,
  };
}

function countValues(values) {
  const map = new Map();
  for (const value of values) {
    map.set(value, (map.get(value) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function isNum(value) {
  return Number.isFinite(Number(value));
}

function fmtPct(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${round(n, 2)}%`;
}
