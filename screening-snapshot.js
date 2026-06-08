/**
 * Screening snapshot log (4C).
 *
 * Appends a JSONL line per screening cycle to
 * `<PATHS.data>/screening-snapshots/YYYY-MM-DD.jsonl`. Each line
 * captures the funnel state at the time of the cycle so we can
 * debug "why did this reject?" without parsing prose.
 *
 * Kept intentionally small and synchronous. The file is one line
 * per cycle, so disk usage is bounded by cycle frequency.
 */

import fs from "fs";
import path from "path";
import { PATHS } from "./utils/paths.js";

const SNAPSHOTS_DIR = path.join(PATHS.data, "screening-snapshots");
const MAX_LINES_PER_FILE = 5_000;

function ensureDir() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

function fileName(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return path.join(SNAPSHOTS_DIR, `${y}-${m}-${d}.jsonl`);
}

function rotateIfOversize(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > MAX_LINES_PER_FILE) {
      const archived = filePath.replace(/\.jsonl$/, `.${Date.now()}.jsonl`);
      fs.renameSync(filePath, archived);
    }
  } catch { /* ignore */ }
}

/**
 * Append a screening cycle snapshot. `snapshot` is any JSON-serializable
 * object. Keep it small (single cycle, no PII).
 */
export function logScreeningSnapshot(snapshot) {
  try {
    ensureDir();
    const file = fileName();
    rotateIfOversize(file);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...snapshot,
    });
    fs.appendFileSync(file, line + "\n");
  } catch (e) {
    // Logging should never crash the cycle. Swallow.
    process.stderr.write(`[screening_snapshot] write failed: ${e.message}\n`);
  }
}

/**
 * Read snapshots for a given UTC day. Returns an array of objects.
 * Capped at `MAX_LINES_PER_FILE` lines.
 */
export function readScreeningSnapshots(date = new Date(), limit = 100) {
  try {
    const file = fileName(date);
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Summarize recent snapshots: counts of screened, passed, and grouped
 * rejection reasons. Useful for a quick "/screening-stats" command.
 */
export function summarizeScreeningSnapshots(snapshots) {
  const summary = {
    cycles: 0,
    total_screened: 0,
    total_eligible: 0,
    bot_tracked_injected: 0,
    rejection_counts: {},
    discovery_timeframes: {},
  };
  for (const s of snapshots || []) {
    summary.cycles++;
    summary.total_screened += s.total_screened || 0;
    summary.total_eligible += s.total_eligible || 0;
    if (s.bot_tracked_injected) summary.bot_tracked_injected++;
    if (s.discovery_timeframe) {
      summary.discovery_timeframes[s.discovery_timeframe] =
        (summary.discovery_timeframes[s.discovery_timeframe] || 0) + 1;
    }
    for (const f of s.filtered_examples || []) {
      const reason = f.reason?.split(" ")[0] || "unknown";
      summary.rejection_counts[reason] = (summary.rejection_counts[reason] || 0) + 1;
    }
  }
  return summary;
}
