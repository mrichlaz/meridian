import { Connection } from "@solana/web3.js";

/**
 * Round-robin RPC connection pool with automatic key rotation + failover.
 *
 * Config styles (checked in order):
 *   1. HELIUS_API_KEYS=key1,key2  → builds mainnet URLs (rotated round-robin)
 *   2. HELIUS_API_KEY=key          → same (single or comma-separated)
 *   3. RPC_URLS=url1,url2          → full URLs
 *   4. RPC_URL=url                  → single fallback
 *
 * Keys are rotated on every call to spread rate-limit budget. A key/endpoint
 * that fails (429/401/5xx) is penalised for RPC_PENALTY_MS and skipped until it
 * recovers, so rotation degrades gracefully instead of hammering a dead key.
 */
const HELIUS_BASE = "https://mainnet.helius-rpc.com/?api-key=";
const PENALTY_MS = Number(process.env.RPC_PENALTY_MS) || 60_000;

let _pool = null;
let _idx = 0;
let _penaltyUntil = [];

function initPool() {
  if (_pool) return _pool;

  const heKeys = process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY;
  if (heKeys) {
    const keys = heKeys.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length) {
      _pool = keys.map((k) => new Connection(`${HELIUS_BASE}${k}`, "confirmed"));
      _penaltyUntil = _pool.map(() => 0);
      return _pool;
    }
  }

  const raw = process.env.RPC_URLS;
  if (raw) {
    const urls = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (urls.length) {
      _pool = urls.map((u) => new Connection(u, "confirmed"));
      _penaltyUntil = _pool.map(() => 0);
      return _pool;
    }
  }

  if (process.env.RPC_URL) {
    _pool = [new Connection(process.env.RPC_URL, "confirmed")];
    _penaltyUntil = [0];
    return _pool;
  }

  throw new Error(
    "No RPC endpoints configured. Set HELIUS_API_KEYS, HELIUS_API_KEY, RPC_URLS, or RPC_URL in .env"
  );
}

/** Next healthy connection (round-robin, skipping penalised endpoints). */
export function getConnection() {
  const pool = initPool();
  const n = pool.length;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const idx = (_idx + i) % n;
    if (_penaltyUntil[idx] <= now) {
      _idx = (idx + 1) % n;
      return pool[idx];
    }
  }
  // All penalised → use the one that recovers soonest.
  let best = 0;
  for (let i = 1; i < n; i++) if (_penaltyUntil[i] < _penaltyUntil[best]) best = i;
  _idx = (best + 1) % n;
  return pool[best];
}

/** Penalise the endpoint behind a failed request so rotation skips it. */
export function reportRpcFailure(rpcEndpoint) {
  if (!_pool) return;
  const idx = _pool.findIndex((c) => c.rpcEndpoint === rpcEndpoint);
  if (idx >= 0) _penaltyUntil[idx] = Date.now() + PENALTY_MS;
}

export function hasRpc() {
  return Boolean(
    process.env.HELIUS_API_KEYS ||
      process.env.HELIUS_API_KEY ||
      process.env.RPC_URLS ||
      process.env.RPC_URL
  );
}

/**
 * Helius API keys for the Enhanced Transactions REST API. Rotated round-robin
 * with the same penalty/failover behaviour as the RPC pool.
 */
export function getHeliusKeys() {
  const raw = process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

let _keyIdx = 0;
let _keyPenalty = [];

export function nextHeliusKey() {
  const keys = getHeliusKeys();
  if (!keys.length) return null;
  if (_keyPenalty.length !== keys.length) _keyPenalty = keys.map(() => 0);
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const idx = (_keyIdx + i) % keys.length;
    if (_keyPenalty[idx] <= now) {
      _keyIdx = (idx + 1) % keys.length;
      return keys[idx];
    }
  }
  _keyIdx = (_keyIdx + 1) % keys.length;
  return keys[_keyIdx];
}

export function reportKeyFailure(key) {
  const keys = getHeliusKeys();
  const idx = keys.indexOf(key);
  if (idx < 0) return;
  if (_keyPenalty.length !== keys.length) _keyPenalty = keys.map(() => 0);
  _keyPenalty[idx] = Date.now() + PENALTY_MS;
}

/** Reset pools (config reload / testing). */
export function resetPool() {
  _pool = null;
  _idx = 0;
  _penaltyUntil = [];
  _keyIdx = 0;
  _keyPenalty = [];
}
