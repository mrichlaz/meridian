import { Connection } from "@solana/web3.js";

/**
 * Round-robin RPC connection pool across multiple endpoints.
 *
 * Two config styles, checked in order:
 *   1. HELIUS_API_KEYS=key1,key2,key3  → builds URLs automatically
 *   2. HELIUS_API_KEY=key1,key2,key3   → same (comma-separated single var)
 *   3. RPC_URLS=url1,url2,url3         → full URLs
 *   4. RPC_URL=url                      → single fallback
 *
 * Each Helius key has its own rate-limit budget, so 3 keys ≈ 3× capacity.
 */

const HELIUS_BASE = "https://mainnet.helius-rpc.com/?api-key=";

let _pool = null;
let _idx = 0;

function initPool() {
  if (_pool) return _pool;

  // 1. HELIUS_API_KEYS or HELIUS_API_KEY (comma-separated keys)
  const heKeys = process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY;
  if (heKeys) {
    const keys = heKeys.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length > 0) {
      _pool = keys.map((key) => new Connection(`${HELIUS_BASE}${key}`, "confirmed"));
      return _pool;
    }
  }

  // 2. RPC_URLS (comma-separated full URLs)
  const raw = process.env.RPC_URLS;
  if (raw) {
    const urls = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (urls.length > 0) {
      _pool = urls.map((url) => new Connection(url, "confirmed"));
      return _pool;
    }
  }

  // 3. Single RPC_URL
  if (process.env.RPC_URL) {
    _pool = [new Connection(process.env.RPC_URL, "confirmed")];
    return _pool;
  }

  throw new Error("No RPC endpoints configured. Set HELIUS_API_KEYS, RPC_URLS, or RPC_URL in .env");
}

/**
 * Returns the next Connection in round-robin order (for reads).
 */
export function getConnection() {
  const pool = initPool();
  const conn = pool[_idx % pool.length];
  _idx++;
  return conn;
}

/**
 * Returns a connection for transactions — round-robin like reads.
 * All keys share the same Helius plan tier, so txs work on any.
 */
export function getPrimaryConnection() {
  const pool = initPool();
  const conn = pool[_idx % pool.length];
  _idx++;
  return conn;
}

/**
 * Returns all connections (e.g. for refreshing caches or health checks).
 */
export function getConnections() {
  return [...initPool()];
}

/**
 * Reset the pool (useful for testing or config reload).
 */
export function resetPool() {
  _pool = null;
  _idx = 0;
}
