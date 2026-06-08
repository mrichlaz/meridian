/**
 * Position trend helpers (2A).
 *
 * These are *advisory* helpers — they do not change the close rules.
 * They are intended to be queried by the deterministic close path
 * (and by the LLM via tool calls) to decide whether to delay a close
 * or escalate it.
 *
 * Each helper takes the position object plus a pool-memory record
 * containing recent snapshots. Snapshots are an array of:
 *   { ts, position, pnl_pct, unclaimed_fees_usd, in_range, minutes_out_of_range, age_minutes }
 *
 * The helpers return either `true` (signal present) or `false`.
 * None of them throw on missing data.
 */

function recentForPosition(memory, positionAddress) {
  if (!memory?.snapshots?.length) return [];
  return memory.snapshots.filter((s) => s?.position === positionAddress);
}

/**
 * True if unclaimed fees are flat or decreasing over the last 2 snapshots.
 * Used to delay the "low yield" close so we don't exit right before a
 * quiet pool wakes up.
 */
export function isFeeGrowthDecelerating(memory, positionAddress, options = {}) {
  const epsilon = options.epsilon ?? 0.02;
  const recent = recentForPosition(memory, positionAddress).slice(-2);
  if (recent.length < 2) return false;
  const prev = Number(recent[0].unclaimed_fees_usd || 0);
  const curr = Number(recent[1].unclaimed_fees_usd || 0);
  return Math.abs(curr - prev) < epsilon || curr < prev;
}

/**
 * True if PnL has been improving over the last 2-3 snapshots.
 * Used to give OOR positions a chance to recover.
 */
export function isRecoveryImproving(memory, positionAddress) {
  const recent = recentForPosition(memory, positionAddress).slice(-3);
  if (recent.length < 2) return false;
  const pnlValues = recent.map((s) => Number(s.pnl_pct || 0));
  let improvements = 0;
  for (let i = 1; i < pnlValues.length; i++) {
    if (pnlValues[i] > pnlValues[i - 1]) improvements++;
  }
  // Strictly improving on most comparisons
  return improvements >= Math.floor(pnlValues.length / 2);
}

/**
 * True if PnL has been steadily decreasing over the last 2-3 snapshots.
 * Used to *escalate* an OOR close (don't wait the full wait time).
 */
export function isRangeDriftAccelerating(memory, positionAddress) {
  const recent = recentForPosition(memory, positionAddress).slice(-3);
  if (recent.length < 2) return false;
  const pnlValues = recent.map((s) => Number(s.pnl_pct || 0));
  let declines = 0;
  for (let i = 1; i < pnlValues.length; i++) {
    if (pnlValues[i] < pnlValues[i - 1]) declines++;
  }
  return declines >= Math.floor(pnlValues.length / 2);
}

/**
 * True if fees accrued since the last snapshot are accelerating.
 * Used as a positive signal — position is healthy, don't close.
 */
export function isFeeGrowthAccelerating(memory, positionAddress) {
  const recent = recentForPosition(memory, positionAddress).slice(-2);
  if (recent.length < 2) return false;
  const prev = Number(recent[0].unclaimed_fees_usd || 0);
  const curr = Number(recent[1].unclaimed_fees_usd || 0);
  return curr - prev > 0.05; // at least 5¢ of new fees
}

/**
 * True if the position is in range, healthy PnL, and fees growing.
 * Used to skip claim actions on still-accumulating positions.
 */
export function isHealthy(position, memory) {
  if (!position?.in_range) return false;
  const pnl = Number(position.pnl_pct || 0);
  if (pnl < -10) return false; // too deep
  if (pnl > 30) return false; // already over TP
  return isFeeGrowthAccelerating(memory, position.position);
}

/**
 * Bundle: get a quick risk signal for a position based on snapshot trends.
 * Returns:
 *   { level: "ok" | "watch" | "act", reasons: [...] }
 */
export function assessTrend(position, memory) {
  const reasons = [];
  if (isFeeGrowthDecelerating(memory, position.position)) reasons.push("fee_growth_flat");
  if (isRangeDriftAccelerating(memory, position.position)) reasons.push("pnl_declining");
  if (isRecoveryImproving(memory, position.position)) reasons.push("pnl_improving");
  if (isFeeGrowthAccelerating(memory, position.position)) reasons.push("fee_growth_strong");
  let level = "ok";
  if (reasons.includes("fee_growth_flat") || reasons.includes("pnl_declining")) level = "act";
  else if (reasons.includes("pnl_improving") || reasons.includes("fee_growth_strong")) level = "ok";
  else level = "watch";
  return { level, reasons };
}
