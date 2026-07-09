/**
 * Telegram notifier — pushes the best N pre-pump signals.
 *
 * Anti-spam: a token is only re-notified after NOTIFY_COOLDOWN_MIN. The
 * `last_notified` timestamp on the token row is the source of truth.
 * When DRY_RUN is set (or no token/chat configured) messages are printed
 * to the log instead of sent.
 */
import { getDB } from "./db.js";
import { log } from "./logger.js";
import { CONFIG } from "./config.js";
import { rankSignals, detectFades, detectSurges } from "./scoring.js";
import { ensureSafety } from "./safety.js";
import { recordAlerts } from "./outcomes.js";
import { getTrackedWallets } from "./arb-wallets.js";

function minAgo(ts) {
  return ts ? `${Math.round((Date.now() - ts) / 60000)}m ago` : "never";
}

/** Verify the bot token is valid (getMe). Cheap, sends no message. */
export async function telegramReachable() {
  if (!BASE) return { configured: false, ok: false };
  try {
    const r = await fetch(`${BASE}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    return { configured: Boolean(TG.chatId), ok: Boolean(j.ok), bot: j.result?.username || null };
  } catch (e) {
    return { configured: false, ok: false, error: e.message };
  }
}

// ── Stream-health alerts ──────────────────────────────────────────────
// The orchestrator flips Helius on when the WS goes stale, but we also want
// a chat ping so an operator notices a wedged Chromium even when the
// fallback is silently papering over it. Suppressed in DRY_RUN.

let _lastStreamAlertAt = 0;
let _lastStreamAlertType = null;  // "stale" | "healthy" | null

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "never";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

export async function notifyStreamStale({ lastFrameAt, healthy = false, heliusActive = false, sinceMs: sinceMsArg = null } = {}) {
  if (CONFIG.dryRun || !BASE || !TG.chatId) return false;
  // Allow the operator to mute the stream-stale alert entirely. The
  // underlying health probe still runs (so the orchestrator flips Helius
  // on/off automatically), but the chat stays quiet.
  if (CONFIG.streamAlertsEnabled === false) return false;
  // Use the caller-supplied sinceMs (atomically snapshotted with the other
  // values) when available, so the message can't lie when the stream
  // recovers between the orchestrator's tick and the alert call. Fall back
  // to recomputing from lastFrameAt if a caller didn't pass it.
  const now = Date.now();
  const sinceMs = sinceMsArg != null ? sinceMsArg : (lastFrameAt ? now - lastFrameAt : null);
  const type = healthy ? "healthy" : "stale";

  // Recovery is the natural pair to an earlier unhealthy alert — always
  // fire it so the operator gets a clean "we're back" alongside the warning.
  if (healthy && _lastStreamAlertType === "stale") {
    _lastStreamAlertAt = now;
    _lastStreamAlertType = "healthy";
    return sendHTML(
      `🟢 <b>bot-tracker stream recovered</b>\n` +
        `last arb frame ${fmtDuration(sinceMs)} ago · Helius fallback toggled OFF`
    );
  }

  // Cooldown for same-direction repeats; with edge-triggered callers this
  // only fires during oscillation (e.g. WS flapping through a Cloudflare
  // rate-limit window).
  if (now - _lastStreamAlertAt < CONFIG.streamAlertCooldownMs) return false;
  _lastStreamAlertAt = now;
  _lastStreamAlertType = type;

  const fallbackOn = sinceMs != null && sinceMs > CONFIG.streamStaleMs;
  // When the Helius fallback is already serving data, the WS outage is
  // informational — token events keep populating the same DB. Make that
  // explicit so the operator doesn't get paged for a problem the fallback
  // handles, and offer the env var to mute the alert entirely.
  return sendHTML(
    `⚠️ <b>bot-tracker stream unhealthy</b>\n` +
      `last arb frame ${sinceMs == null ? "never" : fmtDuration(sinceMs)} ago\n` +
      `threshold ${Math.round(CONFIG.streamUnhealthyMs / 1000)}s · mode=${esc(CONFIG.streamMode)}\n` +
      (fallbackOn
        ? `Helius fallback: <b>active</b> — token events still flowing (DB keeps populating).\n`
        : `Helius fallback: not yet active — orchestrator will start Helius on the next 30s tick.\n`) +
      `Mute this alert with <code>BOT_STREAM_ALERTS_ENABLED=false</code>.`
  );
}

// Exposed for tests / heartbeat probes.
export function _streamAlertState() {
  return { lastAlertAt: _lastStreamAlertAt, lastType: _lastStreamAlertType, cooldownMs: CONFIG.streamAlertCooldownMs };
}

/** "Online" ping on startup. */
export async function notifyOnline() {
  return sendHTML(
    `✅ <b>bot-tracker online</b>\n` +
      `mode ${esc(CONFIG.entryMode)} · stream ${esc(CONFIG.streamMode)} · wallets ${getTrackedWallets().length}`
  );
}

/** Periodic health summary. */
export async function notifyHeartbeat() {
  if (CONFIG.heartbeatEnabled === false) return false;
  const db = getDB();
  const c = (q) => db.prepare(q).get().c;
  const lastEv = db.prepare("SELECT MAX(last_event) m FROM tokens").get().m;
  const lastEn = db.prepare("SELECT MAX(last_enriched) m FROM tokens").get().m;
  const alerts24 = db.prepare("SELECT COUNT(*) c FROM alerts WHERE ts > ?").get(Date.now() - 86_400_000).c;
  return sendHTML(
    `💓 <b>bot-tracker healthy</b>\n` +
      `tokens ${c("SELECT COUNT(*) c FROM tokens")} · events ${c("SELECT COUNT(*) c FROM events")}\n` +
      `last arb ${minAgo(lastEv)} · last enrich ${minAgo(lastEn)}\n` +
      `alerts (24h) ${alerts24}`
  );
}

// Filter a ranked list through the safety gate, returning up to `n` tokens that
// pass. Bounded network checks (only what we're about to alert on).
async function pickSafe(db, list, n) {
  if (!CONFIG.safetyChecks) return list.slice(0, n);
  const out = [];
  let checked = 0;
  for (const s of list) {
    if (out.length >= n || checked >= n * 4) break;
    checked++;
    const { safe, flags } = await ensureSafety(db, s.mint);
    if (safe === 0) {
      log("safety", `Vetoed ${s.symbol}: ${(flags || []).join(", ")}`);
      continue;
    }
    if (CONFIG.requireSafe && safe !== 1) continue;
    s.safe = safe;
    out.push(s);
  }
  return out;
}

const TG = CONFIG.telegram;
const BASE = TG.token ? `https://api.telegram.org/bot${TG.token}` : null;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtUsd(n) {
  if (n == null) return "?";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${Number(n).toFixed(2)}`;
}

function fmtPrice(n) {
  if (n == null) return "?";
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

async function sendHTML(html) {
  if (CONFIG.dryRun || !BASE || !TG.chatId) {
    log("telegram_dry", `[not sent] ${html.replace(/<[^>]+>/g, "").slice(0, 200)}`);
    return false;
  }
  try {
    const r = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG.chatId,
        text: html.slice(0, 4096),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      log("telegram_error", `sendMessage HTTP ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    log("telegram_error", `send failed: ${e.message}`);
    return false;
  }
}

function renderSignal(s, rank) {
  const dexUrl = `https://dexscreener.com/solana/${s.mint}`;
  const accel = s.mcap_accel > 0 ? ` ⚡+${s.mcap_accel}%` : "";
  const age = s.age_min != null ? ` · age ${s.age_min}m` : "";
  const rerun = s.pump_count > 0 ? ` · ↻ re-run #${s.pump_count + 1} (peak ${fmtUsd(s.peak_mcap)})` : "";
  return [
    `<b>#${rank} ${esc(s.symbol)}</b> — <i>${esc(s.name || "")}</i>${rerun}`,
    `MCap ${fmtUsd(s.market_cap)} · Liq ${fmtUsd(s.liquidity_usd)} · Vol24 ${fmtUsd(s.volume_h24)}${age}`,
    `MCap Δ <b>${s.mcap_delta_pct > 0 ? "+" : ""}${s.mcap_delta_pct}%</b>${accel} · OBV ${s.obv_slope > 0 ? "+" : ""}${s.obv_slope}`,
    `Arb ${s.arb_hits_window} hits (${s.arb_per_min}/min${s.arb_accelerating ? " ↗" : ""}) · ${s.distinct_bots} bots · B/S ${s.buy_sell_ratio}`,
    s.holders != null
      ? `Holders ${s.holders} (${s.holders_delta_pct > 0 ? "+" : ""}${s.holders_delta_pct}%${s.holders_rising ? " ↗" : ""})`
      : `Holders: n/a`,
    `Price ${fmtPrice(s.price_usd)} · score <b>${s.score}</b>`,
    `<code>${esc(s.mint)}</code>`,
    `<a href="${dexUrl}">DexScreener</a>`,
  ].join("\n");
}

function renderFade(f) {
  const dexUrl = `https://dexscreener.com/solana/${f.mint}`;
  return [
    `⚠️ <b>${esc(f.symbol)}</b> — <i>${esc(f.name || "")}</i>`,
    `MCap ${fmtUsd(f.market_cap)} · Liq ${fmtUsd(f.liquidity_usd)} · Price ${fmtPrice(f.price_usd)}`,
    `Fading: <b>${f.reasons.map(esc).join(", ")}</b>`,
    `<code>${esc(f.mint)}</code>`,
    `<a href="${dexUrl}">DexScreener</a>`,
  ].join("\n");
}

function renderSurge(s) {
  const dexUrl = `https://dexscreener.com/solana/${s.mint}`;
  return [
    `🚀 <b>${esc(s.symbol)}</b> — <i>${esc(s.name || "")}</i>`,
    `MCap ${fmtUsd(s.market_cap)} · Liq ${fmtUsd(s.liquidity_usd)} · Vol24 ${fmtUsd(s.volume_h24)}`,
    `<b>SURGE</b>: ${s.reasons.map(esc).join(" · ")}`,
    `${s.distinct_bots} bots · arb ${s.arb_per_min}/min · OBV +${s.obv_jump} · Price ${fmtPrice(s.price_usd)}`,
    `<code>${esc(s.mint)}</code>`,
    `<a href="${dexUrl}">DexScreener</a>`,
  ].join("\n");
}

/**
 * Score, pick the best N (respecting cooldown), notify, and stamp last_notified.
 */
export async function notifyTop() {
  const db = getDB();
  const now = Date.now();
  const cooldownMs = TG.cooldownMin * 60_000;

  const ranked = rankSignals({ limit: 25 });
  const eligible = ranked.filter(
    (s) => !s.last_notified || now - s.last_notified > cooldownMs
  );
  const top = await pickSafe(db, eligible, TG.topN);
  if (!top.length) return { sent: 0 };

  const header = `🔔 <b>Bot Tracker — Top ${top.length} pre-pump signal${top.length > 1 ? "s" : ""}</b>`;
  const body = top.map((s, i) => renderSignal(s, i + 1)).join("\n\n");
  const ok = await sendHTML(`${header}\n\n${body}`);

  if (ok || CONFIG.dryRun) {
    const stamp = db.prepare("UPDATE tokens SET last_notified = ? WHERE mint = ?");
    db.transaction(() => {
      for (const s of top) stamp.run(now, s.mint);
    })();
    recordAlerts(db, "top", top);
  }

  log("telegram", `Notified ${top.length} signal(s): ${top.map((s) => s.symbol).join(", ")}`);
  return { sent: top.length, symbols: top.map((s) => s.symbol) };
}

/**
 * Detect fading tokens among prior entries and alert (avoid dumping).
 * Stamps last_fade_notified to respect the fade cooldown.
 */
export async function notifyFades() {
  if (!CONFIG.fadeAlerts) return { sent: 0 };
  if (CONFIG.fadesEnabled === false) return { sent: 0, skipped: "fadesDisabled" };
  const db = getDB();
  const now = Date.now();
  const fades = detectFades();
  if (!fades.length) return { sent: 0 };

  const header = `⚠️ <b>Bot Tracker — Fade / exit warning</b>`;
  const body = fades.slice(0, 5).map(renderFade).join("\n\n");
  const ok = await sendHTML(`${header}\n\n${body}`);

  if (ok || CONFIG.dryRun) {
    const stamp = db.prepare("UPDATE tokens SET last_fade_notified = ? WHERE mint = ?");
    db.transaction(() => {
      for (const f of fades) stamp.run(now, f.mint);
    })();
  }

  log("telegram", `Fade alert for ${fades.length}: ${fades.map((f) => f.symbol).join(", ")}`);
  return { sent: fades.length, symbols: fades.map((f) => f.symbol) };
}

/**
 * Detect surge / market-mover impulses and fire a distinct alert.
 * Stamps last_surge_notified to respect the surge cooldown.
 */
export async function notifySurges() {
  if (!CONFIG.surgeAlerts) return { sent: 0 };
  if (CONFIG.surgesEnabled === false) return { sent: 0, skipped: "surgesDisabled" };
  const db = getDB();
  const now = Date.now();
  const surges = detectSurges();
  if (!surges.length) return { sent: 0 };

  const top = await pickSafe(db, surges, 5);
  if (!top.length) return { sent: 0 };
  const header = `🚀 <b>Bot Tracker — Market mover / surge buy</b>`;
  const body = top.map(renderSurge).join("\n\n");
  const ok = await sendHTML(`${header}\n\n${body}`);

  if (ok || CONFIG.dryRun) {
    const stamp = db.prepare("UPDATE tokens SET last_surge_notified = ? WHERE mint = ?");
    db.transaction(() => {
      for (const s of top) stamp.run(now, s.mint);
    })();
    recordAlerts(db, "surge", top);
  }

  log("telegram", `Surge alert for ${top.length}: ${top.map((s) => s.symbol).join(", ")}`);
  return { sent: top.length, symbols: top.map((s) => s.symbol) };
}
