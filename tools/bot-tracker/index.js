/**
 * Orchestrator — runs the bot-tracker inside Meridian's process.
 *
 *   tracker   : Helius poller for tracked wallets (its own internal loop)
 *   stream    : Chromium + CDP listener for sandwiched.me WS (sub-second)
 *   score     : every SCORE_INTERVAL   → notify top-N pre-pump signals
 *   fade      : every SCORE_INTERVAL   → notify fading / exit warnings
 *   prune     : every PRUNE_INTERVAL   → keep the DB small + fast
 *
 * Ingestion modes (STREAM_MODE env, default = "stream"):
 *   "stream" → WS primary, Helius flips on only when stream is stale
 *   "both"   → WS + Helius in parallel
 *   "poll"   → Helius only (escape hatch for hosts that can't run Chromium)
 *
 * Exposes startBotTracker() / stopBotTracker() so the parent (Meridian
 * index.js) drives lifecycle instead of running this top-level.
 */
import { CONFIG } from "./config.js";
import { log } from "./logger.js";
import { hasRpc } from "./utils/rpc-pool.js";
import { getDB, closeDB } from "./db.js";
import { startTracker, stopTracker, enrichTokens } from "./tracker.js";
import { startStream, stopStream, streamHealth } from "./stream-ingester.js";
import { prune } from "./pruner.js";
import { notifyTop, notifyFades, notifySurges, notifyOnline, notifyHeartbeat, notifyStreamStale } from "./telegram.js";
import { refreshHolders } from "./holders.js";
import { resolveOutcomes } from "./outcomes.js";
import { refreshArbWallets, getTrackedWallets } from "./arb-wallets.js";

const timers = [];
let _running = false;
let _pollerOn = false;
let _streamLastState = null;
let _startedAt = 0;

export function botTrackerRunning() {
  return _running;
}

export function botTrackerStartedAt() {
  return _startedAt;
}

export function startBotTracker() {
  if (_running) return;
  if (!hasRpc()) {
    log("bot_tracker", "No RPC configured — bot-tracker disabled. Set HELIUS_API_KEYS / HELIUS_API_KEY / RPC_URLS / RPC_URL in .env.");
    return;
  }

  _running = true;
  _startedAt = Date.now();
  getDB(); // init schema early
  log(
    "bot_tracker",
    `Starting bot-tracker | mode=${CONFIG.entryMode} | streamMode=${CONFIG.streamMode} | ` +
      `wallets=${getTrackedWallets().length} | pumpCeiling=$${CONFIG.pumpCeilingUsd} | ` +
      `maxTokens=${CONFIG.maxTrackedTokens} | telegram=${CONFIG.telegram.token && CONFIG.telegram.chatId ? "on" : "off"} | ` +
      `dryRun=${CONFIG.dryRun}`
  );

  // Recycle the tracked-wallet set from sandwiched.me before we start polling.
  if (CONFIG.arbWalletsAuto) {
    refreshArbWallets()
      .catch((e) => log("bot_tracker_warn", `initial wallet refresh: ${e.message}`));
  }

  if (CONFIG.streamMode === "poll") {
    startTracker();
    _pollerOn = true;
  } else if (CONFIG.streamMode === "both") {
    startStream();
    startTracker();
    _pollerOn = true;
  } else {
    // 'stream' (default): WS primary, Helius poller only when the stream is stale.
    startStream();
    timers.push(
      setInterval(() => {
        // Atomic snapshot — capture every value used by the alert text and
        // the side-effect (Helius start/stop) in one block. Prevents the
        // 'Helius fallback: warming up' misnomer that happened when the
        // stream recovered between the streamHealth() read and the alert
        // call (the text used the latest lastFrameAt but a frozen
        // heliusActive=false).
        const snap = (() => {
          const h = streamHealth();
          const now = Date.now();
          const since = h.lastFrameAt ? now - h.lastFrameAt : null;
          const stale = since == null || since > CONFIG.streamStaleMs;
          const unhealthy = since == null || since > CONFIG.streamUnhealthyMs;
          const state = unhealthy ? "unhealthy" : (h.lastFrameAt ? "healthy" : "starting");
          return { h, now, since, stale, unhealthy, state };
        })();

        if (snap.stale && !_pollerOn) {
          log("bot_tracker", `Stream stale (last frame ${snap.since == null ? "never" : Math.round(snap.since / 1000) + "s ago"}) → Helius fallback ON`);
          startTracker();
          _pollerOn = true;
        } else if (!snap.stale && _pollerOn) {
          log("bot_tracker", "Stream recovered → Helius fallback OFF");
          stopTracker();
          _pollerOn = false;
        }

        if (snap.state !== _streamLastState) {
          _streamLastState = snap.state;
          notifyStreamStale({
            lastFrameAt: snap.h.lastFrameAt,
            healthy: snap.state === "healthy",
            heliusActive: _pollerOn,
            sinceMs: snap.since,
          }).catch((e) => log("bot_tracker_warn", `stream alert: ${e.message}`));
        }
      }, 30_000)
    );
  }

  timers.push(
    setInterval(async () => {
      try {
        await notifyTop();
        await notifyFades();
        resolveOutcomes(getDB());
      } catch (e) {
        log("bot_tracker_error", `notify cycle: ${e.message}`);
      }
    }, CONFIG.scoreInterval)
  );

  timers.push(
    setInterval(() => {
      try {
        prune();
      } catch (e) {
        log("bot_tracker_error", `prune cycle: ${e.message}`);
      }
    }, CONFIG.pruneInterval)
  );

  // Enrichment runs on its own timer in every mode — even when the Helius
  // poller is idle (stream mode), we need continuous snapshots for OBV.
  setTimeout(() => enrichTokens(getDB()).catch((e) => log("bot_tracker_error", `enrich: ${e.message}`)), 8000);
  timers.push(
    setInterval(() => {
      enrichTokens(getDB()).catch((e) => log("bot_tracker_error", `enrich cycle: ${e.message}`));
    }, CONFIG.enrichInterval)
  );

  if (CONFIG.surgeAlerts) {
    timers.push(
      setInterval(async () => {
        try {
          await notifySurges();
        } catch (e) {
          log("bot_tracker_error", `surge cycle: ${e.message}`);
        }
      }, CONFIG.surgeInterval)
    );
  }

  if (CONFIG.holderTracking) {
    timers.push(
      setInterval(async () => {
        try {
          await refreshHolders();
        } catch (e) {
          log("bot_tracker_error", `holders cycle: ${e.message}`);
        }
      }, CONFIG.holderInterval)
    );
  }

  if (CONFIG.arbWalletsAuto) {
    timers.push(
      setInterval(async () => {
        try {
          await refreshArbWallets();
        } catch (e) {
          log("bot_tracker_error", `wallet refresh: ${e.message}`);
        }
      }, CONFIG.walletRefreshMs)
    );
  }

  if (CONFIG.startupPing) {
    notifyOnline().catch((e) => log("bot_tracker_error", `startup ping: ${e.message}`));
  }
  if (CONFIG.heartbeatHours > 0) {
    timers.push(
      setInterval(() => {
        notifyHeartbeat().catch((e) => log("bot_tracker_error", `heartbeat: ${e.message}`));
      }, CONFIG.heartbeatHours * 3_600_000)
    );
  }

  // Don't process.exit here — Meridian owns the process. Just clear timers on stop.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("bot_tracker", `Received ${signal} — stopping bot-tracker`);
    stopBotTracker();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export function stopBotTracker() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  try { stopStream(); } catch {}
  if (_pollerOn) {
    try { stopTracker(); } catch {}
    _pollerOn = false;
  }
  _running = false;
}
