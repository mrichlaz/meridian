import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary, summarizePerformanceRecords } from "./lessons.js";
import { PATHS } from "./utils/paths.js";

const STATE_FILE = PATHS.state;
const LESSONS_FILE = PATHS.lessons;

export function summarizeBriefingActivity(state, lessonsData, { now = Date.now() } = {}) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const allPositions = Object.values(state?.positions || {});
  const performance = lessonsData?.performance || [];
  const perfLast24h = performance.filter((record) => {
    const at = Date.parse(record.recorded_at || record.closed_at || "");
    return Number.isFinite(at) && at > cutoff;
  });
  const openedPositionIds = new Set();
  for (const position of allPositions) {
    const at = Date.parse(position.deployed_at || "");
    if (position.position && Number.isFinite(at) && at > cutoff) openedPositionIds.add(position.position);
  }
  for (const record of perfLast24h) {
    const at = Date.parse(record.deployed_at || "");
    if (record.position && Number.isFinite(at) && at > cutoff) openedPositionIds.add(record.position);
  }
  return {
    allPositions,
    openPositions: allPositions.filter((position) => !position.closed),
    openedLast24h: openedPositionIds.size,
    closedLast24h: perfLast24h.length,
    perfLast24h,
    stats: summarizePerformanceRecords(perfLast24h),
  };
}

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const activity = summarizeBriefingActivity(state, lessonsData, { now: now.getTime() });
  const { openPositions, perfLast24h, stats } = activity;

  // 3. Lessons Learned (skip config-change spam — show only trading insights)
  const lessonsLast24h = (lessonsData.lessons || []).filter(l =>
    new Date(l.created_at) > last24h &&
    !/SELF-TUNED/i.test(l.rule) &&
    l.rule.length < 200
  );

  // 4. Current State
  const perfSummary = getPerformanceSummary();

  // 5. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${activity.openedLast24h}`,
    `📤 Positions Closed: ${activity.closedLast24h}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${stats.total_pnl_usd >= 0 ? "+" : ""}$${stats.total_pnl_usd.toFixed(2)}`,
    `💎 Fees Earned: $${stats.total_fees_usd.toFixed(2)}`,
    stats.decisive_positions > 0
      ? `📈 Win Rate (24h): ${stats.win_rate_pct}% (${stats.decisive_positions} decisive${stats.flat_positions ? `, ${stats.flat_positions} flat/unpriced` : ""})`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
