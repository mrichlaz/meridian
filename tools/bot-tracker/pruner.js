/**
 * Pruner — keeps the DB small + fast under a very active wallet.
 *
 * Removes, in order:
 *   1. Pumped tokens        (market cap >= PUMP_CEILING_USD) — target already hit.
 *   2. Inactive/exhausted   (no bot activity within INACTIVE_WINDOW_MIN, or
 *                            OBV + volume both declining over the window).
 *   3. Stale snapshots      (older than SNAPSHOT_RETENTION_MIN, plus a per-token
 *                            cap of MAX_SNAPSHOTS_PER_TOKEN newest rows).
 *   4. Orphan events/sigs   (outside the retention window).
 *   5. Overflow             (if still over MAX_TRACKED_TOKENS, drop the weakest:
 *                            least active + oldest activity first).
 *
 * Returns a summary of what was removed.
 */
import { getDB } from "./db.js";
import { log } from "./logger.js";
import { CONFIG } from "./config.js";
import { unresolvedAlertMints } from "./outcomes.js";

function deleteToken(db, mints) {
  if (!mints.length) return;
  // Never delete a token that still has an unresolved alert — we need its
  // forward price to score the outcome.
  const keep = new Set(unresolvedAlertMints(db));
  const targets = mints.filter((m) => !keep.has(m));
  if (!targets.length) return;
  const delTok = db.prepare("DELETE FROM tokens WHERE mint = ?");
  const delSnap = db.prepare("DELETE FROM snapshots WHERE mint = ?");
  const delEv = db.prepare("DELETE FROM events WHERE token_mint = ?");
  const delHold = db.prepare("DELETE FROM holder_snaps WHERE mint = ?");
  db.transaction(() => {
    for (const m of targets) {
      delTok.run(m);
      delSnap.run(m);
      delEv.run(m);
      delHold.run(m);
    }
  })();
}

export function prune() {
  const db = getDB();
  const now = Date.now();
  const activeCutoff = now - CONFIG.inactiveWindowMin * 60_000;
  const windowStart = now - CONFIG.momentumWindowMin * 60_000;
  const snapCutoff = now - CONFIG.snapshotRetentionMin * 60_000;

  const summary = { pumped: 0, rearmed: 0, inactive: 0, exhausted: 0, overflow: 0, snapshots: 0 };

  // 1. Pumped → PARK, don't delete. Market makers re-pump, so we keep the
  // token + its history, stop alerting, and record the peak. Re-arm later if
  // it retraces. (Deletion only happens via the inactive rule below.)
  const parked = db
    .prepare(
      `UPDATE tokens
       SET pumped = 1,
           pumped_at = COALESCE(pumped_at, ?),
           pump_count = COALESCE(pump_count, 0) + 1,
           peak_mcap = MAX(COALESCE(peak_mcap, 0), market_cap)
       WHERE pumped = 0 AND market_cap >= ?`
    )
    .run(now, CONFIG.pumpCeilingUsd);
  summary.pumped = parked.changes;

  // 1b. Re-arm parked tokens that have retraced well below the ceiling so they
  // can catch a second run. peak_mcap + pump_count are kept as history.
  const rearmed = db
    .prepare(
      `UPDATE tokens
       SET pumped = 0, pumped_at = NULL
       WHERE pumped = 1 AND market_cap > 0 AND market_cap < ?`
    )
    .run(CONFIG.pumpCeilingUsd * CONFIG.pumpRearmFactor);
  summary.rearmed = rearmed.changes;

  // 2a. Inactive — no wallet activity within the window. THIS is what actually
  // removes tokens (including long-dead pumped ones).
  const inactive = db
    .prepare("SELECT mint FROM tokens WHERE last_event IS NOT NULL AND last_event < ?")
    .all(activeCutoff)
    .map((r) => r.mint);
  deleteToken(db, inactive);
  summary.inactive = inactive.length;

  // 2b. Exhausted — enriched, still active, but both OBV and volume are
  // trending down over the momentum window (pump already faded).
  const exhaustedCandidates = db
    .prepare(
      `SELECT mint FROM tokens
       WHERE pumped = 0 AND last_enriched IS NOT NULL AND last_event >= ?`
    )
    .all(activeCutoff);
  const exhausted = [];
  const rangeStmt = db.prepare(
    `SELECT obv, volume_h24 FROM snapshots
     WHERE mint = ? AND timestamp >= ? ORDER BY timestamp ASC`
  );
  for (const { mint } of exhaustedCandidates) {
    const snaps = rangeStmt.all(mint, windowStart);
    if (snaps.length < 3) continue;
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const obvFalling = last.obv < first.obv;
    const volFalling = (last.volume_h24 || 0) < (first.volume_h24 || 0);
    if (obvFalling && volFalling) exhausted.push(mint);
  }
  deleteToken(db, exhausted);
  summary.exhausted = exhausted.length;

  // 3. Stale snapshots + per-token cap.
  const staleSnap = db
    .prepare("DELETE FROM snapshots WHERE timestamp < ?")
    .run(snapCutoff);
  summary.snapshots += staleSnap.changes;
  // Keep only the newest MAX_SNAPSHOTS_PER_TOKEN rows per mint.
  const capOverflow = db
    .prepare(
      `DELETE FROM snapshots
       WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid,
                  ROW_NUMBER() OVER (PARTITION BY mint ORDER BY timestamp DESC) AS rn
           FROM snapshots
         ) WHERE rn > ?
       )`
    )
    .run(CONFIG.maxSnapshotsPerToken);
  summary.snapshots += capOverflow.changes;

  // 4. Orphan events + old seen_sigs.
  db.prepare(
    "DELETE FROM events WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE tokens.mint = events.token_mint)"
  ).run();
  db.prepare("DELETE FROM seen_sigs WHERE timestamp < ?").run(snapCutoff);

  // 5. Hard cap — if still over budget, drop the weakest tokens.
  const total = db.prepare("SELECT COUNT(*) c FROM tokens").get().c;
  if (total > CONFIG.maxTrackedTokens) {
    const excess = total - CONFIG.maxTrackedTokens;
    const weakest = db
      .prepare(
        `SELECT mint FROM tokens
         ORDER BY occurrence_count ASC, COALESCE(last_event, 0) ASC
         LIMIT ?`
      )
      .all(excess)
      .map((r) => r.mint);
    deleteToken(db, weakest);
    summary.overflow = weakest.length;
  }

  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {}

  const removed =
    summary.inactive + summary.exhausted + summary.overflow;
  if (removed > 0 || summary.pumped > 0 || summary.rearmed > 0) {
    log(
      "pruner",
      `parked ${summary.pumped} pumped, re-armed ${summary.rearmed}; removed ${removed} (inactive ${summary.inactive}, exhausted ${summary.exhausted}, overflow ${summary.overflow})`
    );
  }
  return summary;
}
