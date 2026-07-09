/**
 * Outcome logging — the feedback loop that tells you if the signal actually
 * works. Without this, the scoring weights are just guesses.
 *
 * When an alert fires we snapshot the entry price/mcap. A resolver then records
 * the % move at +15m / +1h / +6h and the peak gain, so `cli.js performance`
 * can report win rate and average return per signal type — and you can tune
 * the weights against reality.
 *
 * Values in p15/p60/p360 and max_gain_pct are stored as PERCENT change from
 * entry price.
 */
import { CONFIG } from "./config.js";
import { log } from "./logger.js";

const M = 60_000;
const pct = (entry, val) => (entry > 0 && val != null ? ((val - entry) / entry) * 100 : null);

/**
 * Record alerts for the tokens we just notified. Deduplicates against an
 * existing unresolved alert of the same type within the last hour.
 */
export function recordAlerts(db, type, items) {
  if (!CONFIG.outcomeTracking || !items?.length) return;
  const now = Date.now();
  const dupe = db.prepare(
    "SELECT id FROM alerts WHERE mint=? AND type=? AND resolved=0 AND ts > ?"
  );
  const ins = db.prepare(
    `INSERT INTO alerts (mint, symbol, type, ts, entry_price, entry_mcap, score)
     VALUES (?,?,?,?,?,?,?)`
  );
  db.transaction(() => {
    for (const s of items) {
      if (dupe.get(s.mint, type, now - 60 * M)) continue;
      ins.run(s.mint, s.symbol, type, now, s.price_usd ?? null, s.market_cap ?? null, s.score ?? null);
    }
  })();
}

/**
 * Aggregate hit-rate / return stats per signal type.
 */
export function performance(db) {
  const types = ["top", "surge"];
  const report = {};
  for (const type of types) {
    const rows = db.prepare("SELECT * FROM alerts WHERE type = ?").all(type);
    const resolved = rows.filter((r) => r.p60 != null);
    const avg = (arr, k) => {
      const vals = arr.map((r) => r[k]).filter((v) => v != null);
      return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    };
    const wins = resolved.filter((r) => r.p60 >= 10).length; // +10% at 1h = win
    report[type] = {
      alerts: rows.length,
      resolved_1h: resolved.length,
      win_rate_1h: resolved.length ? Math.round((wins / resolved.length) * 100) : null,
      avg_15m_pct: avg(rows, "p15"),
      avg_1h_pct: avg(rows, "p60"),
      avg_6h_pct: avg(rows, "p360"),
      avg_peak_pct: avg(rows, "max_gain_pct"),
      best_peak_pct: rows.length ? Math.max(...rows.map((r) => r.max_gain_pct || 0)) : null,
      worst_1h_pct: resolved.length ? Math.min(...resolved.map((r) => r.p60)) : null,
    };
  }
  return report;
}

/**
 * Fill forward-price outcomes for unresolved alerts as each horizon elapses,
 * using the token's latest enriched price. Resolves at +6h.
 */
export function resolveOutcomes(db) {
  if (!CONFIG.outcomeTracking) return { updated: 0, resolved: 0 };
  const now = Date.now();
  const alerts = db.prepare("SELECT * FROM alerts WHERE resolved = 0").all();
  if (!alerts.length) return { updated: 0, resolved: 0 };

  const tokPrice = db.prepare("SELECT price_usd FROM tokens WHERE mint = ?");
  const updMax = db.prepare("UPDATE alerts SET max_gain_pct = ? WHERE id = ?");
  const updP15 = db.prepare("UPDATE alerts SET p15 = ? WHERE id = ?");
  const updP60 = db.prepare("UPDATE alerts SET p60 = ? WHERE id = ?");
  const updP360 = db.prepare("UPDATE alerts SET p360 = ?, resolved = 1 WHERE id = ?");
  const resolveNoData = db.prepare("UPDATE alerts SET resolved = 1 WHERE id = ?");

  let updated = 0;
  let resolved = 0;
  db.transaction(() => {
    for (const a of alerts) {
      const age = now - a.ts;
      const cur = tokPrice.get(a.mint)?.price_usd ?? null;
      const gain = pct(a.entry_price, cur);
      if (gain != null && gain > (a.max_gain_pct || 0)) {
        updMax.run(Math.round(gain * 10) / 10, a.id);
      }
      if (age >= 15 * M && a.p15 == null && gain != null) {
        updP15.run(Math.round(gain * 10) / 10, a.id);
        updated++;
      }
      if (age >= 60 * M && a.p60 == null && gain != null) {
        updP60.run(Math.round(gain * 10) / 10, a.id);
        updated++;
      }
      if (age >= 360 * M) {
        if (gain != null) {
          updP360.run(Math.round(gain * 10) / 10, a.id);
        } else {
          resolveNoData.run(a.id); // token gone; nothing more to sample
        }
        resolved++;
      }
    }
  })();
  if (updated || resolved) log("outcomes", `resolver: ${updated} filled, ${resolved} closed`);
  return { updated, resolved };
}

/** Mints with an unresolved alert (pruner must keep these for outcome sampling). */
export function unresolvedAlertMints(db) {
  return db.prepare("SELECT DISTINCT mint FROM alerts WHERE resolved = 0").all().map((r) => r.mint);
}
