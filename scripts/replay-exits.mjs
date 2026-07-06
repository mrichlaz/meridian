#!/usr/bin/env node
// Exit-rule replay harness — evaluate rule variants against closed-position
// history BEFORE letting them trade real money.
//
// Usage:
//   node scripts/replay-exits.mjs                          # data/lessons.json performance records
//   node scripts/replay-exits.mjs --export ~/Downloads/bengbeng-*.json   # a wallet export
//   node scripts/replay-exits.mjs --since 2026-07-02       # only closes after a date
//
// What it can and cannot do with endpoint-only data (no full price path):
//   - TIME STOP: positions held past the cap are "affected". Their PnL at the
//     cap is estimated by LINEAR interpolation (pnl × cap/held). Real paths
//     are convex on losers (bleeds accelerate), so the estimate is
//     CONSERVATIVE for losses avoided.
//   - STOP LOSS: assumes a monotonic-enough path — a position that finished
//     below the stop is assumed to have crossed it once. Savings = final − SL.
//     This is an OPTIMISTIC bound (ignores V-shapes that recovered), so read
//     it as "max avoidable", and weigh it against winners that dipped below
//     the stop intraday (invisible in endpoint data — noted in output).
// Where pool-memory snapshots exist for a position (last ~8h only), rules are
// replayed on the actual 10-min PnL path instead — exact, no assumptions.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const exportFile = argValue("--export");
const since = argValue("--since") || "1970-01-01";

// ── Load records into a common shape ─────────────────────────────
// { pnl_pct, pnl_usd, fees_usd, minutes_held, closed_at, pair, position }
let records = [];
if (exportFile) {
  const raw = JSON.parse(fs.readFileSync(exportFile, "utf8"));
  records = (raw.positions || [])
    .filter((p) => p.is_closed)
    .map((p) => ({
      pnl_pct: p.pnl_pct_quote,
      pnl_usd: p.pnl_usd,
      fees_usd: p.fees_total_usd,
      minutes_held: p.held_seconds / 60,
      closed_at: p.closed_at,
      pair: p.pair,
      position: p.position_address,
    }));
} else {
  const lessonsPath = path.join(process.env.DATA_DIR, "lessons.json");
  const raw = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
  records = (raw.performance || [])
    .filter((p) => typeof p.pnl_pct === "number")
    .map((p) => ({
      pnl_pct: p.pnl_pct,
      pnl_usd: p.pnl_usd ?? null,
      fees_usd: p.fees_earned_usd ?? null,
      minutes_held: p.minutes_held ?? null,
      closed_at: p.recorded_at || p.closed_at,
      pair: p.pool_name,
      position: p.position,
    }));
}
records = records.filter((r) => (r.closed_at || "") >= since);

if (!records.length) {
  console.error("No records to replay. Check --export path / --since date / data/lessons.json.");
  process.exit(1);
}

// Snapshot paths (exact replay where available)
let snapshotPaths = new Map(); // position -> [{age_minutes, pnl_pct}]
try {
  const pm = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "pool-memory.json"), "utf8"));
  for (const entry of Object.values(pm)) {
    for (const s of entry.snapshots || []) {
      if (!s.position || s.pnl_pct == null || s.age_minutes == null) continue;
      if (!snapshotPaths.has(s.position)) snapshotPaths.set(s.position, []);
      snapshotPaths.get(s.position).push({ age: s.age_minutes, pnl: s.pnl_pct });
    }
  }
  for (const p of snapshotPaths.values()) p.sort((a, b) => a.age - b.age);
} catch {}

const total = records.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
const withHold = records.filter((r) => r.minutes_held != null);
console.log(`Replaying ${records.length} closes (${withHold.length} with hold time) since ${since}`);
console.log(`Baseline: total PnL $${total.toFixed(2)}, win rate ${(records.filter((r) => (r.pnl_usd ?? r.pnl_pct) > 0).length / records.length * 100).toFixed(0)}%\n`);

// ── TIME STOP grid ────────────────────────────────────────────────
console.log("── TIME STOP (maxHoldMinutes) — linear-interp estimate, conservative on losses ──");
console.log("cap(m) | affected | their actual PnL | est. PnL if cut | est. delta");
for (const cap of [180, 240, 300, 360, 480]) {
  const affected = withHold.filter((r) => r.minutes_held > cap);
  if (!affected.length) {
    console.log(`${String(cap).padStart(6)} | ${String(0).padStart(8)} | — no positions held past cap`);
    continue;
  }
  let actual = 0;
  let estimated = 0;
  for (const r of affected) {
    actual += r.pnl_usd ?? 0;
    const snaps = snapshotPaths.get(r.position);
    const atCap = snaps?.length
      ? (snaps.filter((s) => s.age <= cap).at(-1)?.pnl ?? null)
      : null;
    if (atCap != null && r.pnl_pct) {
      estimated += (r.pnl_usd ?? 0) * (atCap / r.pnl_pct); // exact path point, scaled to USD
    } else {
      estimated += (r.pnl_usd ?? 0) * Math.min(1, cap / r.minutes_held); // linear interp
    }
  }
  const delta = estimated - actual;
  console.log(
    `${String(cap).padStart(6)} | ${String(affected.length).padStart(8)} | ${("$" + actual.toFixed(1)).padStart(16)} | ${("$" + estimated.toFixed(1)).padStart(15)} | ${(delta >= 0 ? "+" : "") + "$" + delta.toFixed(1)}`
  );
}

// ── STOP LOSS grid ────────────────────────────────────────────────
console.log("\n── STOP LOSS (stopLossPct) — optimistic bound: assumes the stop fills at the level ──");
console.log("SL(%) | breached | actual PnL of breachers | PnL if stopped | max saved");
for (const sl of [-5, -8, -10, -12, -15]) {
  const breached = records.filter((r) => r.pnl_pct != null && r.pnl_pct < sl && r.pnl_usd != null && r.pnl_pct !== 0);
  if (!breached.length) {
    console.log(`${String(sl).padStart(5)} | ${String(0).padStart(8)} | — none finished below this level`);
    continue;
  }
  let actual = 0;
  let stopped = 0;
  for (const r of breached) {
    actual += r.pnl_usd;
    stopped += r.pnl_usd * (sl / r.pnl_pct); // USD at the stop level
  }
  console.log(
    `${String(sl).padStart(5)} | ${String(breached.length).padStart(8)} | ${("$" + actual.toFixed(1)).padStart(23)} | ${("$" + stopped.toFixed(1)).padStart(14)} | ${("+$" + (stopped - actual).toFixed(1))}`
  );
}
console.log("(Invisible in endpoint data: winners that dipped below the stop intraday and recovered — a tighter stop also cuts some of those. Use snapshot-path counts below to sanity-check.)");

// ── Snapshot-path coverage ────────────────────────────────────────
const covered = records.filter((r) => snapshotPaths.get(r.position)?.length >= 2);
console.log(`\nSnapshot paths available for ${covered.length}/${records.length} closes (pool-memory keeps ~8h rolling). The more history accumulates before you read a variant's numbers, the more the estimates above are replaced by exact path replays.`);
