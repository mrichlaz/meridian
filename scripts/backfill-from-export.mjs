#!/usr/bin/env node
// Reconcile recorded performance with a bengbeng-explainer wallet export.
//
// The poller/backfill race (fixed Jul 12 — see the external-closes bullet in
// CLAUDE.md) left zero-value "flat/unpriced" records in lessons.json, and
// recordPerformance dedups by position address, so the real numbers can never
// be recorded through the normal path. This script patches those records in
// place from the on-chain truth, and fixes the matching pool-memory deploy
// entries (their aggregates self-heal on next read).
//
// Usage:
//   node scripts/backfill-from-export.mjs --export <file>            # dry run: report only
//   node scripts/backfill-from-export.mjs --export <file> --apply    # write (backs up first)
//   --add-missing   also insert records for on-chain closes that were never
//                   recorded at all (minimal records, no signal snapshot —
//                   they improve totals/replays but are thin for ML training)
//   --fix-mismatch  also patch non-flat records whose PnL disagrees with the
//                   on-chain truth beyond tolerance (Jul 13: two recorded
//                   -54%/-56% closes were +$0.59/+$0.13 on-chain — phantom
//                   losses poison regime detection and ML labels)
//
// DATA_DIR env selects the data root (defaults to <repo>/data; /data in Docker
// via utils/paths.js semantics).

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
const apply = args.includes("--apply");
const addMissing = args.includes("--add-missing");
const fixMismatch = args.includes("--fix-mismatch");

if (!exportFile) {
  console.error("Usage: node scripts/backfill-from-export.mjs --export <wallet-export.json> [--apply] [--add-missing]");
  process.exit(1);
}

const lessonsPath = path.join(process.env.DATA_DIR, "lessons.json");
const poolMemoryPath = path.join(process.env.DATA_DIR, "pool-memory.json");

const exportRaw = JSON.parse(fs.readFileSync(exportFile, "utf8"));
const byPosition = new Map();
for (const p of exportRaw.positions || []) {
  if (p.is_closed && p.position_address) byPosition.set(p.position_address, p);
}
console.log(`Export: ${byPosition.size} closed positions (${exportRaw.window?.from?.slice(0, 10)} → ${exportRaw.window?.to?.slice(0, 10)})`);

const lessons = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
const perf = lessons.performance || [];
console.log(`Recorded: ${perf.length} performance records`);

const round2 = (v) => Math.round(Number(v) * 100) / 100;
const isFlat = (r) => (Number(r.pnl_usd) || 0) === 0 && (Number(r.fees_earned_usd) || 0) === 0;

// ── Patch flat (and optionally mismatched) records from on-chain truth ──
let patched = 0;
let mismatchPatched = 0;
let pnlDelta = 0;
let feesDelta = 0;
const patchedPositions = new Map();
for (const rec of perf) {
  if (!rec.position) continue;
  const truth = byPosition.get(rec.position);
  if (!truth) continue;
  const flat = isFlat(rec);
  if (flat) {
    const hasRealData = Number(truth.pnl_usd) !== 0 || Number(truth.fees_total_usd) !== 0 || Number(truth.withdrawal_total_usd) > 0;
    if (!hasRealData) continue; // genuinely flat on-chain too
  } else {
    if (!fixMismatch) continue;
    const truthPnl = round2(truth.pnl_usd);
    const diff = Math.abs((Number(rec.pnl_usd) || 0) - truthPnl);
    const tolerance = Math.max(1, Math.abs(truthPnl) * 0.25);
    if (diff <= tolerance) continue; // agrees with on-chain within tolerance
  }

  const before = { pnl_usd: rec.pnl_usd, fees: rec.fees_earned_usd, pnl_pct: rec.pnl_pct };
  rec.initial_value_usd = round2(truth.deposit_total_usd);
  rec.final_value_usd = round2(truth.withdrawal_total_usd);
  rec.fees_earned_usd = round2(truth.fees_total_usd);
  rec.pnl_usd = round2(truth.pnl_usd);
  rec.pnl_pct = round2(truth.pnl_pct_quote);
  if (truth.held_seconds > 0) rec.minutes_held = Math.round(truth.held_seconds / 60);
  rec.backfilled_from_export = exportRaw.exported_at || new Date().toISOString();

  pnlDelta += rec.pnl_usd - (Number(before.pnl_usd) || 0);
  feesDelta += rec.fees_earned_usd - (Number(before.fees) || 0);
  patchedPositions.set(rec.position, rec);
  if (flat) patched++;
  else mismatchPatched++;
  console.log(`  ${flat ? "patch" : "fix-mismatch"} ${rec.pool_name || truth.pair} ${rec.position.slice(0, 8)}: ${before.pnl_pct ?? 0}%/$${before.pnl_usd ?? 0} → ${rec.pnl_pct}%/$${rec.pnl_usd} (fees $${rec.fees_earned_usd})`);
}

// ── Flag recorded closes with no on-chain counterpart ────────────
// A big recorded PnL inside the export window whose position the wallet
// never held on-chain is fabricated — report it (there is no truth to
// patch from; delete manually after investigating).
const windowFrom = Date.parse(exportRaw.window?.from || 0) || 0;
const phantoms = perf.filter((r) =>
  r.position && !byPosition.has(r.position) &&
  Date.parse(r.recorded_at || 0) >= windowFrom &&
  Math.abs(Number(r.pnl_usd) || 0) >= 50
);
for (const r of phantoms) {
  console.log(`  PHANTOM? ${r.pool_name} ${r.position.slice(0, 8)}: ${r.pnl_pct}%/$${r.pnl_usd} recorded ${r.recorded_at} — position not in export (reason: ${r.close_reason})`);
}

// ── Optionally add never-recorded closes ─────────────────────────
let added = 0;
if (addMissing) {
  const recorded = new Set(perf.map((r) => r.position).filter(Boolean));
  for (const [address, truth] of byPosition) {
    if (recorded.has(address)) continue;
    perf.push({
      position: address,
      pool: truth.pool_address,
      pool_name: (truth.pair || "?").replace("/", "-"),
      base_mint: truth.base_mint || null,
      strategy: null,
      bin_step: truth.bin_step_bp ?? null,
      amount_sol: null,
      fees_earned_usd: round2(truth.fees_total_usd),
      final_value_usd: round2(truth.withdrawal_total_usd),
      initial_value_usd: round2(truth.deposit_total_usd),
      pnl_usd: round2(truth.pnl_usd),
      pnl_pct: round2(truth.pnl_pct_quote),
      minutes_held: Math.round((truth.held_seconds || 0) / 60),
      minutes_in_range: null,
      range_efficiency: null,
      close_reason: "backfilled from wallet export",
      deployed_at: truth.created_at || null,
      recorded_at: truth.closed_at || new Date().toISOString(),
      backfilled_from_export: exportRaw.exported_at || new Date().toISOString(),
    });
    added++;
  }
  if (added) perf.sort((a, b) => new Date(a.recorded_at || 0) - new Date(b.recorded_at || 0));
}

// ── Patch matching pool-memory deploy entries ────────────────────
let poolPatched = 0;
let poolMemory = null;
if (fs.existsSync(poolMemoryPath) && patchedPositions.size > 0) {
  poolMemory = JSON.parse(fs.readFileSync(poolMemoryPath, "utf8"));
  for (const entry of Object.values(poolMemory)) {
    for (const dep of entry?.deploys || []) {
      const rec = dep?.position ? patchedPositions.get(dep.position) : null;
      if (!rec || (Number(dep.pnl_usd) || 0) === Number(rec.pnl_usd)) continue;
      dep.pnl_pct = rec.pnl_pct;
      dep.pnl_usd = rec.pnl_usd;
      dep.fees_earned_usd = rec.fees_earned_usd;
      dep.fee_earned_pct = rec.initial_value_usd > 0 ? round2((rec.fees_earned_usd / rec.initial_value_usd) * 100) : null;
      poolPatched++;
    }
  }
}

// ── Report / write ───────────────────────────────────────────────
console.log("");
console.log(`Flat records patched:      ${patched}`);
console.log(`Mismatches fixed:          ${fixMismatch ? mismatchPatched : `(skipped — pass --fix-mismatch)`}`);
console.log(`Total PnL correction:      ${pnlDelta >= 0 ? "+" : ""}$${pnlDelta.toFixed(2)} (fees ${feesDelta >= 0 ? "+" : ""}$${feesDelta.toFixed(2)})`);
console.log(`Phantom records flagged:   ${phantoms.length} (not patched — no on-chain truth; investigate before deleting)`);
console.log(`Missing records added:     ${addMissing ? added : `(skipped — pass --add-missing)`}`);
console.log(`Pool-memory deploys fixed: ${poolPatched} (aggregates self-heal on next read)`);

if (!apply) {
  console.log("\nDry run — nothing written. Re-run with --apply to write.");
  process.exit(0);
}

const ts = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(lessonsPath, `${lessonsPath}.bak-${ts}`);
fs.writeFileSync(lessonsPath, JSON.stringify(lessons, null, 2));
console.log(`\nWrote ${lessonsPath} (backup: lessons.json.bak-${ts})`);
if (poolMemory && poolPatched > 0) {
  fs.copyFileSync(poolMemoryPath, `${poolMemoryPath}.bak-${ts}`);
  fs.writeFileSync(poolMemoryPath, JSON.stringify(poolMemory, null, 2));
  console.log(`Wrote ${poolMemoryPath} (backup: pool-memory.json.bak-${ts})`);
}
