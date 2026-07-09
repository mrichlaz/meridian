/**
 * Daily arb-wallet auto-updater.
 *
 * Pulls the top arbitrage programs/signers from sandwiched.me and recycles the
 * tracked-wallet set once per day. The dedicated bot programs (each bot's own
 * on-chain arb program) are exactly what we want to watch — but SHARED
 * infrastructure (Jupiter router, DEX programs, token programs) must be
 * excluded, because sandwiched.me itself notes that many bots share the
 * Jupiter program, so tracking it would be a useless firehose.
 *
 * The list is persisted to data/wallets.json so a failed fetch (or offline
 * start) falls back to the last good set, then to BOT_WALLETS from .env.
 */
import fs from "fs";
import path from "path";
import { CONFIG, PATHS } from "./config.js";
import { log } from "./logger.js";

const WALLETS_FILE = path.join(PATHS.data, "wallets.json");

// Shared infrastructure that must never be tracked as a "bot wallet".
const SHARED_INFRA = new Set([
  // Jupiter routers (catch-all: many bots share these)
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",
  // Raydium
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  // Orca
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  // Meteora
  "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K",
  "LBUZKhRxPF3XUpBCjp4YzTKsidLd3oRmYQzCPyQnRgH",
  // Pump.fun
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  // SPL Token / Token-2022 / System
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "11111111111111111111111111111111",
]);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Slice the balanced JSON array that follows `"key":` in the (unescaped) RSC.
function sliceJsonArray(text, key) {
  const i = text.indexOf(`"${key}":`);
  if (i < 0) return null;
  const start = text.indexOf("[", i);
  if (start < 0) return null;
  let depth = 0,
    inStr = false,
    esc = false;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      if (--depth === 0) return text.slice(start, k + 1);
    }
  }
  return null;
}

function parseLeaderboard(unescaped, key) {
  const seg = sliceJsonArray(unescaped, key);
  if (!seg) return [];
  try {
    const arr = JSON.parse(seg);
    return arr.map((o) => o.address).filter((a) => a && BASE58.test(a));
  } catch {
    // Fallback: pull addresses in order from the bounded segment.
    return [...seg.matchAll(/"address":"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((m) => m[1]);
  }
}

/** Fetch + parse the top arb wallets from sandwiched.me (no persistence). */
export async function fetchTopArbWallets() {
  const r = await fetch(CONFIG.arbWalletsUrl, {
    headers: { "User-Agent": "Mozilla/5.0 bot-tracker" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`sandwiched.me HTTP ${r.status}`);
  const html = await r.text();
  const u = html.replace(/\\"/g, '"');

  const programs = parseLeaderboard(u, "topArbitragers");
  const signers = parseLeaderboard(u, "topSigners");
  if (!programs.length && !signers.length)
    throw new Error("no arb wallets parsed (page format may have changed)");

  let source;
  if (CONFIG.arbWalletsSource === "signers") source = [...signers];
  else if (CONFIG.arbWalletsSource === "both") source = [...programs, ...signers];
  else source = [...programs, ...signers]; // 'programs' first, backfill from signers

  const seen = new Set();
  const picked = [];
  for (const a of source) {
    if (SHARED_INFRA.has(a) || seen.has(a)) continue;
    seen.add(a);
    picked.push(a);
    if (picked.length >= CONFIG.arbWalletsTopN) break;
  }
  return picked;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Refresh the tracked-wallet set from sandwiched.me and persist it.
 * On failure, keeps the existing cache. Always unions in CONFIG.seedWallets.
 */
export async function refreshArbWallets() {
  if (!CONFIG.arbWalletsAuto) return getTrackedWallets();
  try {
    const fetched = await fetchTopArbWallets();
    const wallets = [...new Set([...CONFIG.seedWallets, ...fetched])];
    fs.writeFileSync(
      WALLETS_FILE,
      JSON.stringify({ updatedAt: Date.now(), source: CONFIG.arbWalletsSource, fetched, wallets }, null, 2)
    );
    _cache = wallets;
    log("arb_wallets", `Recycled tracked set: ${wallets.length} wallets (top ${fetched.length} arb + ${CONFIG.seedWallets.length} seed)`);
    return wallets;
  } catch (e) {
    log("arb_wallets_warn", `Refresh failed (${e.message}); keeping existing set`);
    return getTrackedWallets();
  }
}

let _cache = null;

/**
 * Current tracked wallets: cached memory → wallets.json → seed ∪ BOT_WALLETS.
 */
export function getTrackedWallets() {
  if (_cache && _cache.length) return _cache;
  const cached = readCache();
  if (cached?.wallets?.length) {
    _cache = cached.wallets;
    return _cache;
  }
  const fallback = [...new Set([...CONFIG.seedWallets, ...CONFIG.wallets])];
  _cache = fallback;
  return fallback;
}

export function walletsInfo() {
  const cached = readCache();
  return {
    active: getTrackedWallets(),
    updatedAt: cached?.updatedAt || null,
    source: cached?.source || CONFIG.arbWalletsSource,
    auto: CONFIG.arbWalletsAuto,
  };
}
