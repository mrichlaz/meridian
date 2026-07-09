#!/usr/bin/env node
/**
 * bot-tracker CLI — read-only inspection of the bot-tracker DB.
 *
 *   node cli.js bots [--window 24h] [--active-only] [--with-tokens]
 *                                              bots observed in `events` (DB-derived)
 *   node cli.js tokens-freq [--window 24h] [--min-events 1] [--min-bots 0] [--limit 50] [--json]
 *                                              tokens ranked by event frequency
 *                                              (stream + RPC merged; per-source breakdown)
 *
 * Run from the repo root with:  node tools/bot-tracker/cli.js <command>
 */
import "dotenv/config";
import { getDB, closeDB, botsFromEvents, tokensByFrequency } from "./db.js";

const argv = process.argv.slice(2);
const cmd = argv[0] || "bots";
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);
const json = (o) => console.log(JSON.stringify(o, null, 2));

function parseWindowMs(input) {
  if (input == null || input === "") return 24 * 3_600_000;
  if (/^\d+$/.test(input)) return Number(input) * 1000;
  if (input.endsWith("m")) return parseInt(input) * 60_000;
  if (input.endsWith("h")) return parseInt(input) * 3_600_000;
  if (input.endsWith("d")) return parseInt(input) * 86_400_000;
  return 24 * 3_600_000;
}

function fmtAgo(ts, now = Date.now()) {
  if (!ts) return "—";
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtUsd(n) {
  if (n == null) return "?";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

async function main() {
  switch (cmd) {
    case "bots": {
      const winRaw = flag("window", "24h");
      const windowMs = parseWindowMs(winRaw);
      const minEvents = Number(flag("min-events", 1));
      const activeOnly = has("active-only");
      const withTokens = has("with-tokens");
      const maxTokens = Number(flag("max-tokens", 10));
      const rows = botsFromEvents({ windowMs, minEvents, activeOnly, withTokens, maxTokensPerWallet: maxTokens });
      if (has("json")) return json({ windowMs, count: rows.length, bots: rows });
      if (!rows.length) return console.log(`No bot wallets in events within window=${winRaw}.`);
      console.log(`Bot wallets observed in events (window=${winRaw}${activeOnly ? ", active-only" : ""}${withTokens ? ", with-tokens" : ""}):`);
      console.log("");
      for (const r of rows) {
        const mark = r.active ? "●" : "○";
        console.log(
          `${mark} ${r.wallet.padEnd(46)}  events ${String(r.events).padStart(5)}  ` +
          `tokens ${String(r.distinct_tokens).padStart(4)}  ` +
          `last ${fmtAgo(r.last_seen).padStart(8)}  first ${fmtAgo(r.first_seen).padStart(8)}`
        );
        if (withTokens && r.tokens?.length) {
          for (const t of r.tokens) {
            const sym = t.symbol ? t.symbol.padEnd(8) : "(no sym)".padEnd(8);
            const tag = [t.symbol ? null : "missing-meta"].filter(Boolean).join(",");
            console.log(
              `      ${sym}  ${(t.dex || "(no dex)").padEnd(10)}  ` +
              `events ${String(t.events).padStart(4)}  last ${fmtAgo(t.last_event)}  ${t.mint} ${tag}`
            );
          }
        }
      }
      console.log("");
      console.log(`Total: ${rows.length} bot wallet(s).  ● = active in last 30m, ○ = quiet.`);
      break;
    }

    case "tokens-freq": {
      const winRaw = flag("window", "24h");
      const windowMs = parseWindowMs(winRaw);
      const minEvents = Number(flag("min-events", 1));
      const minBots = Number(flag("min-bots", 0));
      const limit = Number(flag("limit", 50));
      const rows = tokensByFrequency({ windowMs, minEvents, minDistinctBots: minBots, limit });
      if (has("json")) return json({ windowMs, count: rows.length, tokens: rows });
      if (!rows.length) return console.log(`No tokens with >= ${minEvents} events within window=${winRaw}.`);
      console.log(`Tokens ranked by event frequency (stream + rpc merged; window=${winRaw}, min-events=${minEvents}${minBots > 0 ? `, min-bots=${minBots}` : ""}):`);
      console.log("");
      console.log("┌────────────┬─────────┬────────┬────────┬────────┬────────────────┬────────────────┐");
      console.log("│ token      │ events  │ stream │  rpc   │  bots  │ mcap     / liq │ vol            │");
      console.log("├────────────┼─────────┼────────┼────────┼────────┼────────────────┼────────────────┤");
      for (const r of rows) {
        const sym = (r.symbol || "?").padEnd(10);
        const mcap = fmtUsd(r.market_cap).padStart(8);
        const liq = fmtUsd(r.liquidity_usd).padStart(7);
        const vol = fmtUsd(r.volume_h24).padStart(14);
        const ev = String(r.total_events).padStart(7);
        const strm = String(r.stream_events || 0).padStart(6);
        const rpc = String(r.rpc_events || 0).padStart(6);
        const bots = String(r.distinct_bots || 0).padStart(6);
        console.log(`│ ${sym}  │ ${ev} │ ${strm} │ ${rpc} │ ${bots} │ ${mcap} / ${liq} │ ${vol} │`);
      }
      console.log("└────────────┴─────────┴────────┴────────┴────────┴────────────────┴────────────────┘");
      console.log("");
      console.log(`Total: ${rows.length} token(s). Top of list = most-touched across stream + rpc.`);
      console.log(`Last event: ${fmtAgo(rows[0]?.last_seen)}`);
      break;
    }

    default:
      console.log("Commands:");
      console.log("  bots [--window 24h] [--active-only] [--with-tokens]   bot wallets from events");
      console.log("  tokens-freq [--window 24h] [--min-events 1] [--min-bots 0] [--limit 50]");
      console.log("                                                          tokens ranked by frequency (stream+rpc merged)");
  }
}

main()
  .catch((e) => { console.error(e.message); process.exit(1); })
  .finally(() => closeDB());
