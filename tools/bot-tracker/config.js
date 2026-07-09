/**
 * Central runtime config for the standalone bot tracker.
 * Reads .env (via dotenv) with safe defaults. All thresholds are overridable
 * from the environment so the app can be tuned without code changes.
 */
import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function num(key, def) {
  const v = process.env[key];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * Like num() but returns null when the env var is unset / empty / "null".
 * Used for opt-in features like PUMP_CEILING_USD where unset = "feature off".
 */
function numOrNull(key) {
  const v = process.env[key];
  if (v == null || v === "" || v.toLowerCase() === "null") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(key, def = false) {
  const v = (process.env[key] || "").toLowerCase();
  if (v === "") return def;
  return v === "true" || v === "1" || v === "yes";
}

function list(key, def = []) {
  const v = process.env[key];
  if (!v) return def;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── Paths ───
// We live inside meridian at tools/bot-tracker/. By default the DB lives
// at <meridian>/data/bot-tracker.db so the crypto-signals reader picks up
// the same file we write. We deliberately ignore the umbrella `DATA_DIR`
// env var (which meridian sets to /app/data for Docker) because the bot-
// tracker DB needs to colocate with the rest of meridian's state.
const ROOT = __dirname;
const PARENT = path.resolve(ROOT, "..", "..");
const DATA_DIR = process.env.BOT_TRACKER_DATA_DIR || path.join(PARENT, "data");
const LOG_DIR = process.env.BOT_TRACKER_LOG_DIR || path.join(DATA_DIR, "logs");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

export const PATHS = {
  root: ROOT,
  data: DATA_DIR,
  logs: LOG_DIR,
  db: path.join(DATA_DIR, "bot-tracker.db"),
};

export const CONFIG = {
  // Wallets to watch (fallback / seed when auto-update is off or fails)
  wallets: list("BOT_WALLETS", [
    "3QUnrcMqCQoiGB73s1A6uDzxziywaNFpTLiZiiZbEUoN",
    "NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV",
    "joeHSutRWndCtp1EPx5tz5zHyaPBZUZ5JsxDEVB1RPZ",
    "MEViEnscUm6tsQRoGd9h6nLQaQspKj7DB2M5FwM3Xvz",
  ]),

  // ─── Daily arb-wallet auto-update (sandwiched.me) ───
  arbWalletsAuto: bool("ARB_WALLETS_AUTO", true),
  arbWalletsUrl: process.env.ARB_WALLETS_URL || "https://sandwiched.me/arbitrages",
  arbWalletsSource: process.env.ARB_WALLETS_SOURCE || "programs", // programs | signers | both
  arbWalletsTopN: num("ARB_WALLETS_TOP_N", 10),
  walletRefreshMs: num("WALLET_REFRESH_MS", 86_400_000), // daily
  // Wallets always tracked in addition to the daily top list.
  seedWallets: list("SEED_WALLETS", []),

  // ─── Realtime arb stream (sandwiched.me WS via headless browser) ───
  // streamMode: stream (WS primary + Helius on stale fallback) | both | poll
  //
  // "stream" is the default: the WebSocket frames from sandwiched.me carry
  // the symbol/name/DEX inline so we get identity for free, and we don't
  // need to call DexScreener to enrich `symbol`/`name`. Helius stays wired
  // up as a transparent safety net — the same orchestrator flips it on when
  // the WS goes stale for `streamStaleMs` and off again when frames resume.
  //
  // "poll"  → Helius only. For hosts that can't run Chromium (Cloudflare
  //            bypass needs ~400-500MB; Lightpanda was tested and rejected
  //            — it can't open the WS).
  // "both"   → WS + Helius always. Useful when you're migrating or want
  //            belt-and-suspenders coverage.
  streamMode: process.env.STREAM_MODE || "stream",
  streamUrl: process.env.STREAM_URL || "https://sandwiched.me/arbitrages",
  // Connect to an existing CDP browser (Docker): ws endpoint or http url.
  browserWsEndpoint: process.env.BROWSER_WS_ENDPOINT || null,
  browserUrl: process.env.BROWSER_URL || null,
  // Or launch a local browser at this executable path.
  browserExecutable: process.env.BROWSER_EXECUTABLE || null,
  // Consider the stream dead if no frame for this long → fall back to Helius.
  streamStaleMs: num("STREAM_STALE_MS", 120_000),
  streamReconnectMs: num("STREAM_RECONNECT_MS", 5_000),
  // Alert thresholds for the WS-primary mode. Used both to flip Helius on/off
  // (every 30 s) and to decide whether to send a Telegram "stream unhealthy"
  // warning. Default 5 min — a long enough lull that we can be confident
  // Cloudflare or Chromium is wedged, not just a quiet block.
  streamUnhealthyMs: num("STREAM_UNHEALTHY_MS", 300_000),
  // Minimum spacing between successive Telegram stream-warning messages so we
  // don't spam the chat when the outage lasts hours.
  streamAlertCooldownMs: num("STREAM_ALERT_COOLDOWN_MS", 600_000),

  // Polling / enrichment cadence (ms) — tuned for low API cost. We SAMPLE
  // which tokens are hot; we don't need every transaction.
  pollInterval: num("POLL_INTERVAL_MS", 60_000),
  enrichInterval: num("ENRICH_INTERVAL_MS", 60_000),
  pruneInterval: num("PRUNE_INTERVAL_MS", 180_000),
  scoreInterval: num("SCORE_INTERVAL_MS", 120_000),
  sigLimit: num("SIG_LIMIT", 40),
  // Hard ceiling on new signatures parsed per cycle (bounds Helius calls even
  // when the bot is extremely active).
  maxSigsPerCycle: num("MAX_SIGS_PER_CYCLE", 200),

  // ── Opt-in filters ──────────────────────────────────────────────
  // Each filter is opt-in. Leave the env var unset (or set to "null") to
  // disable it. The fee-collection strategy wants all of these off — the
  // highest-mcap tokens usually earn the most LP fees, and meridian has its
  // own post-merge filter (mcap / liquidity / bin_step) so we don't need
  // any pre-filtering here.
  //
  // pumpCeilingUsd = null  → no "not yet pumped" gate in scoring; the
  //                          pruner also stops parking tokens (the UPDATE
  //                          `WHERE market_cap >= null` never matches).
  //                          detectSurges still fires on sudden buy impulses
  //                          because that's the one-sided SOL fee signal.
  pumpCeilingUsd: numOrNull("PUMP_CEILING_USD"),
  // When a token crosses the ceiling it is PARKED (marked pumped, alerts
  // stopped) rather than deleted — market makers often re-pump. If it retraces
  // back below (ceiling × rearmFactor) it is re-armed to signal again.
  pumpRearmFactor: num("PUMP_REARM_FACTOR", 0.7),
  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 8_000),
  minVolume24h: num("MIN_VOLUME_24H", 30_000),

  // ─── Notification eligibility (only strong tokens get sent) ───
  // A ranked signal must clear BOTH bars to be notify-worthy, not just be
  // top-N of a weak batch.
  minSignalScore: num("MIN_SIGNAL_SCORE", 0.08),
  minArbHits: num("MIN_ARB_HITS", 3), // min arb touches in the momentum window

  // Activity / momentum windows (minutes)
  inactiveWindowMin: num("INACTIVE_WINDOW_MIN", 240),
  momentumWindowMin: num("MOMENTUM_WINDOW_MIN", 60),

  // ─── Telegram alert toggles (opt-out) ──────────────────────────────
  // Each is a per-channel on/off. Backend ingestion (stream + RPC → events
  // → tokens) keeps running regardless; only the chat message is suppressed.
  // Set BOT_TOP_SIGNALS_ENABLED / BOT_FADES_ENABLED / BOT_SURGES_ENABLED /
  // BOT_HEARTBEAT_ENABLED to "false" to mute that channel. /settings Bot
  // tab also exposes these as toggle buttons.
  topSignalsEnabled:   process.env.BOT_TOP_SIGNALS_ENABLED !== "false",
  fadesEnabled:        process.env.BOT_FADES_ENABLED        !== "false",
  surgesEnabled:       process.env.BOT_SURGES_ENABLED       !== "false",
  heartbeatEnabled:    process.env.BOT_HEARTBEAT_ENABLED    !== "false",

  // ─── Entry gate (confirmed / balanced) ───
  entryMode: process.env.ENTRY_MODE || "balanced", // early | balanced | conservative
  minDistinctBots: num("MIN_DISTINCT_BOTS", 2),
  requireBuyPressure: bool("REQUIRE_BUY_PRESSURE", true),
  // Reject already-extended tokens (window mcap growth beyond this = chasing).
  extendedPctMax: num("EXTENDED_PCT_MAX", 150),
  // Lifecycle gating (minutes since pair creation). 0 disables a bound.
  minTokenAgeMin: num("MIN_TOKEN_AGE_MIN", 10),
  maxTokenAgeMin: num("MAX_TOKEN_AGE_MIN", 0),
  // Conservative-only floors
  minLiqToMcapRatio: num("MIN_LIQ_TO_MCAP_RATIO", 0.02),

  // ─── Fade / exit detection ───
  fadeAlerts: bool("FADE_ALERTS", true),
  fadeLiqDropPct: num("FADE_LIQ_DROP_PCT", 20),
  fadeCooldownMin: num("FADE_COOLDOWN_MIN", 120),
  // Don't fade-warn a token until it's been an active signal this long — avoids
  // firing a buy and an exit alert in the same breath.
  fadeGraceMin: num("FADE_GRACE_MIN", 20),

  // ─── Surge / market-mover detection (sudden buy impulse) ───
  surgeAlerts: bool("SURGE_ALERTS", true),
  surgeInterval: num("SURGE_INTERVAL_MS", 60_000),
  surgeWindowMin: num("SURGE_WINDOW_MIN", 15),
  surgeFlowMult: num("SURGE_FLOW_MULT", 3),      // recent flow vs baseline
  surgeBuyRatio: num("SURGE_BUY_RATIO", 2.5),    // h1 buys/sells dominance
  surgeMinPriceKickPct: num("SURGE_MIN_PRICE_KICK_PCT", 4),
  surgeCooldownMin: num("SURGE_COOLDOWN_MIN", 30),

  // ─── Holder-growth trendline (organic demand) ───
  holderTracking: bool("HOLDER_TRACKING", true),
  holderInterval: num("HOLDER_INTERVAL_MS", 600_000),  // sample every 10 min
  holderWindowMin: num("HOLDER_WINDOW_MIN", 180),        // trendline lookback
  holderShortlist: num("HOLDER_SHORTLIST", 25),          // tokens refreshed/cycle
  holderPageCap: num("HOLDER_PAGE_CAP", 3),              // Helius pagination cap
  requireHoldersRising: bool("REQUIRE_HOLDERS_RISING", false),
  birdeyeApiKey: process.env.BIRDEYE_API_KEY || null,

  // ─── Rug / safety gate (capital protection) ───
  safetyChecks: bool("SAFETY_CHECKS", true),
  safetyTtlMin: num("SAFETY_TTL_MIN", 60),       // re-check cadence
  maxTop10Pct: num("MAX_TOP10_PCT", 40),         // top-10 holder concentration ceiling
  requireSafe: bool("REQUIRE_SAFE", false),      // balanced: veto known-unsafe only

  // ─── Turnover / liquidity-vs-size quality gate ───
  minTurnover: num("MIN_TURNOVER", 0.1),         // 24h volume / market cap floor
  positionSizeUsd: num("POSITION_SIZE_USD", 200),
  maxPriceImpactPct: num("MAX_PRICE_IMPACT_PCT", 2),  // est. impact of your buy

  // ─── Outcome logging (measure hit rate, tune weights) ───
  outcomeTracking: bool("OUTCOME_TRACKING", true),

  // Hard caps to keep the DB small + fast (bot is very active)
  maxTrackedTokens: num("MAX_TRACKED_TOKENS", 300),
  maxSnapshotsPerToken: num("MAX_SNAPSHOTS_PER_TOKEN", 48),
  snapshotRetentionMin: num("SNAPSHOT_RETENTION_MIN", 360),

  // Telegram
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
    topN: num("NOTIFY_TOP_N", 3),
    cooldownMin: num("NOTIFY_COOLDOWN_MIN", 180),
  },

  // ─── Health / heartbeat ───
  startupPing: bool("STARTUP_PING", true),      // send a Telegram "online" on boot
  heartbeatHours: num("HEARTBEAT_HOURS", 0),    // periodic "healthy" summary (0 = off)
  healthEventStaleMin: num("HEALTH_EVENT_STALE_MIN", 15),   // no events => unhealthy
  healthEnrichStaleMin: num("HEALTH_ENRICH_STALE_MIN", 10), // no enrichment => unhealthy

  dryRun: bool("DRY_RUN", false),
  logLevel: process.env.LOG_LEVEL || "info",
};

// Stables / majors are route plumbing, never signals.
export const EXCLUDED_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
]);

export const DEX_NAMES = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": "orca",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "orca",
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: "meteora",
  LBUZKhRxPF3XUpBCjp4YzTKsidLd3oRmYQzCPyQnRgH: "meteora",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pumpfun",
};

export const WSOL = "So11111111111111111111111111111111111111112";
export const DEX_API = "https://api.dexscreener.com/latest/dex/tokens";
