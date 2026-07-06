#!/usr/bin/env node
// Dead-man watchdog — run from SYSTEM cron (outside the daemon), e.g.:
//   */10 * * * * cd /path/to/meridian && node scripts/watchdog.mjs >> logs/watchdog.log 2>&1
//
// The daemon writes data/heartbeat.json after every management cycle. If the
// heartbeat goes stale while positions are open, the bot is dead or hung and
// nobody is watching the stops — this script is the only thing that will
// tell you. It alerts via the Telegram bot API directly (no daemon imports),
// and rate-limits itself to one alert per hour.
//
// Env overrides: WATCHDOG_STALE_MINUTES (default 20), WATCHDOG_ALERT_COOLDOWN_MINUTES (default 60).

import "../envcrypt.js"; // loads .env (with encrypted-key decryption)
import fs from "fs";
import path from "path";
import { PATHS } from "../utils/paths.js";

const STALE_MINUTES = Number(process.env.WATCHDOG_STALE_MINUTES || 20);
const ALERT_COOLDOWN_MINUTES = Number(process.env.WATCHDOG_ALERT_COOLDOWN_MINUTES || 60);

const HEARTBEAT_PATH = path.join(PATHS.data, "heartbeat.json");
const WATCHDOG_STATE_PATH = path.join(PATHS.data, "watchdog-state.json");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function openPositionCount() {
  const state = readJson(PATHS.state, { positions: {} });
  return Object.values(state.positions || {}).filter((p) => !p.closed).length;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId =
    process.env.TELEGRAM_CHAT_ID || readJson(PATHS.userConfig, {})?.telegramChatId;
  if (!token || !chatId) {
    console.error(`[watchdog] ${new Date().toISOString()} ALERT (no Telegram configured): ${text}`);
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok;
}

async function main() {
  const openCount = openPositionCount();
  if (openCount === 0) {
    console.log(`[watchdog] ${new Date().toISOString()} OK — no open positions, nothing at risk`);
    return;
  }

  const hb = readJson(HEARTBEAT_PATH);
  const hbAt = hb?.at ? Date.parse(hb.at) : NaN;
  const staleMinutes = Number.isFinite(hbAt) ? (Date.now() - hbAt) / 60000 : Infinity;

  if (staleMinutes < STALE_MINUTES) {
    console.log(`[watchdog] ${new Date().toISOString()} OK — heartbeat ${staleMinutes.toFixed(1)}m old, ${openCount} open position(s)`);
    return;
  }

  // Rate-limit alerts so a dead daemon doesn't spam every cron tick
  const wdState = readJson(WATCHDOG_STATE_PATH, {});
  const lastAlertAt = wdState.last_alert_at ? Date.parse(wdState.last_alert_at) : 0;
  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MINUTES * 60000) {
    console.log(`[watchdog] ${new Date().toISOString()} STALE but alert cooldown active (last alert ${new Date(lastAlertAt).toISOString()})`);
    return;
  }

  const msg =
    `🚨 WATCHDOG: Meridian daemon heartbeat is ${Number.isFinite(staleMinutes) ? `${Math.round(staleMinutes)}m stale` : "MISSING"} ` +
    `with ${openCount} OPEN position(s).\n` +
    `The bot is down or hung — stop losses are NOT being watched.\n` +
    `Last heartbeat: ${hb?.at || "never"} (source: ${hb?.source || "?"}, pid ${hb?.pid || "?"}).\n` +
    `Restart the daemon, or close positions manually.`;

  const sent = await sendTelegram(msg);
  fs.writeFileSync(
    WATCHDOG_STATE_PATH,
    JSON.stringify({ last_alert_at: new Date().toISOString(), sent, stale_minutes: Math.round(staleMinutes) }, null, 2)
  );
  console.error(`[watchdog] ${new Date().toISOString()} ALERT ${sent ? "sent" : "FAILED to send"} — heartbeat ${Math.round(staleMinutes)}m stale, ${openCount} open position(s)`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[watchdog] fatal: ${e.message}`);
  process.exitCode = 1;
});
