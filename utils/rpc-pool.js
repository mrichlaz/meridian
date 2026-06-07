import { Connection } from "@solana/web3.js";

/**
 * Round-robin RPC connection pool across multiple endpoints.
 *
 * Set RPC_URLS=url1,url2,url3 in .env (comma-separated).
 * Falls back to single RPC_URL if RPC_URLS is not set.
 *
 * Each endpoint has its own rate-limit budget, so 3 keys = ~3x capacity.
 */

let _pool = null;
let _idx = 0;

function initPool() {
  if (_pool) return _pool;

  const raw = process.env.RPC_URLS;
  const urls = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [process.env.RPC_URL].filter(Boolean);

  if (urls.length === 0) {
    throw new Error("No RPC endpoints configured. Set RPC_URL or RPC_URLS in .env");
  }

  _pool = urls.map((url) => new Connection(url, "confirmed"));
  return _pool;
}

/**
 * Returns the next Connection in round-robin order.
 */
export function getConnection() {
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
