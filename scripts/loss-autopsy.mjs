#!/usr/bin/env node
// Loss autopsy — the analysis half of the learning loop.
//
// Classifies every losing close in the performance history into an archetype,
// aggregates where the money actually leaks, and prints the concrete lever
// for each pattern. Run it after a losing day, or on a cron, and paste the
// output to the operator/agent.
//
// Usage:
//   node scripts/loss-autopsy.mjs [--days 7] [--export <wallet-export.json>]
//
// With --export, on-chain truth is used for PnL (recorded values can lag or
// be wrong for externally-closed positions); otherwise data/lessons.json.
//
// Archetypes:
//   repeat_stop_loss   token already had a material loss in the prior 24h —
//                      the redeploy itself was the mistake (cooldown lever)
//   stop_loss          first material loss on the token in 24h — entry
//                      timing/selection (screening lever)
//   bleed_conversion   slow -2..-5% grind, held > 60m — exit lever
//                      (conversionExitPct / maxHoldMinutes)
//   churn              small loss, held < 20m, near-zero fees — deploy cost
//                      with no fee flow (EV-gate lever)
//   other_loss         anything else
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

const args = process.argv.slice(2);
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const days = Number(argValue("--days") || 7);
const exportFile = argValue("--export");
const sinceMs = Date.now() - days * 86400e3;

let records;
if (exportFile) {
  const exp = JSON.parse(fs.readFileSync(exportFile, "utf8"));
  records = (exp.positions || []).filter((p) => p.is_closed).map((p) => ({
    position: p.position_address,
    token: String(p.pair || "?").split("/")[0],
    base_mint: p.base_mint || null,
    pnl_usd: p.pnl_usd ?? 0,
    pnl_pct: p.pnl_pct_quote ?? 0,
    fees_usd: p.fees_total_usd ?? 0,
    minutes_held: Math.round((p.held_seconds || 0) / 60),
    closed_at: p.closed_at,
    close_reason: null,
  }));
} else {
  const lessons = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "lessons.json"), "utf8"));
  records = (lessons.performance || []).map((r) => ({
    position: r.position,
    token: String(r.pool_name || "?").split("-")[0],
    base_mint: r.base_mint || null,
    pnl_usd: r.pnl_usd ?? 0,
    pnl_pct: r.pnl_pct ?? 0,
    fees_usd: r.fees_earned_usd ?? 0,
    minutes_held: r.minutes_held ?? 0,
    closed_at: r.recorded_at,
    close_reason: r.close_reason || null,
  }));
}
records = records
  .filter((r) => Date.parse(r.closed_at || 0) >= sinceMs)
  .sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at));

const isMaterialLoss = (r) => r.pnl_pct <= -2 || /stop.?loss|loss cut/i.test(r.close_reason || "");

function classify(r, priorSameToken24h) {
  if (r.pnl_usd >= 0) return null;
  if (isMaterialLoss(r)) {
    return priorSameToken24h.some(isMaterialLoss) ? "repeat_stop_loss" : "stop_loss";
  }
  if (r.minutes_held >= 60 && r.pnl_pct <= -1) return "bleed_conversion";
  if (r.minutes_held < 20 && r.fees_usd < 0.5) return "churn";
  return "other_loss";
}

const byToken = new Map();
const byArchetype = new Map();
for (const r of records) {
  const key = r.base_mint || r.token;
  const prior = (byToken.get(key) || []).filter(
    (h) => Date.parse(r.closed_at) - Date.parse(h.closed_at) < 86400e3
  );
  const arch = classify(r, prior);
  if (arch) {
    const bucket = byArchetype.get(arch) || { n: 0, pnl: 0, tokens: new Map() };
    bucket.n++;
    bucket.pnl += r.pnl_usd;
    bucket.tokens.set(r.token, (bucket.tokens.get(r.token) || 0) + r.pnl_usd);
    byArchetype.set(arch, bucket);
  }
  byToken.set(key, [...(byToken.get(key) || []), r]);
}

const totalPnl = records.reduce((a, r) => a + r.pnl_usd, 0);
const totalFees = records.reduce((a, r) => a + r.fees_usd, 0);
const wins = records.filter((r) => r.pnl_usd > 0.005).length;
const losses = records.filter((r) => r.pnl_usd < -0.005).length;
console.log(`Window: last ${days}d | ${records.length} closes | net $${totalPnl.toFixed(2)} | fees $${totalFees.toFixed(2)} | W/L ${wins}/${losses}`);
console.log(`Gross wins: $${records.filter((r) => r.pnl_usd > 0).reduce((a, r) => a + r.pnl_usd, 0).toFixed(2)} | gross losses: $${records.filter((r) => r.pnl_usd < 0).reduce((a, r) => a + r.pnl_usd, 0).toFixed(2)}`);

const LEVERS = {
  repeat_stop_loss: "escalating mint cooldown (6h→24h→72h) — shipped; verify it holds",
  stop_loss: "entry selection: check post-pump entries (6h price change), volatility vs fee flow",
  bleed_conversion: "exit rules: conversionExitPct / maxHoldMinutes / Rule 8 thresholds",
  churn: "EV gate: policyMinFeeVolatilityRatio too permissive for these pools",
  other_loss: "inspect individually",
};

console.log("\n── Loss archetypes ──");
for (const [arch, b] of [...byArchetype.entries()].sort((a, z) => a[1].pnl - z[1].pnl)) {
  const worst = [...b.tokens.entries()].sort((a, z) => a[1] - z[1]).slice(0, 3)
    .map(([t, v]) => `${t} $${v.toFixed(0)}`).join(", ");
  console.log(`${arch.padEnd(18)} ${String(b.n).padStart(3)}x  $${b.pnl.toFixed(2).padStart(9)}  worst: ${worst}`);
  console.log(`${"".padEnd(18)} lever: ${LEVERS[arch]}`);
}

console.log("\n── Tokens with 2+ material losses in the window (cooldown escalation targets) ──");
for (const [, hist] of byToken) {
  const mats = hist.filter(isMaterialLoss);
  if (mats.length < 2) continue;
  const net = hist.reduce((a, r) => a + r.pnl_usd, 0);
  console.log(` ${hist[0].token.padEnd(12)} ${hist.length} deploys, ${mats.length} material losses, net $${net.toFixed(2)}`);
}
