import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRYPTO_DB = path.resolve(__dirname, "../data/bot-tracker.db");

/**
 * Read top tokens from the crypto bot tracker SQLite DB.
 * Returns tokens with the most trade events, optionally filtered by recency
 * and liquidity/volume thresholds. Defaults are more permissive than the
 * previous hardcoded values so quiet wallets still produce candidates.
 */
export function getCryptoBotTokens({
  limit = 20,
  maxAgeMinutes = 1440,    // was 240 — extend to 24h so quiet wallets still surface
  minLiquidityUsd = 5000,  // was 50000 — allow smaller caps to surface
  minVolume24h = 50000,    // was 500000 — allow lower-volume pools
  requireDexData = false,  // set true if you only want DexScreener-enriched tokens
} = {}) {
  let db;
  try {
    db = new Database(CRYPTO_DB, { readonly: true });
  } catch (e) {
    log("crypto_signals", `Cannot open crypto DB: ${e.message}`);
    return { success: false, error: "Crypto tracker DB not found — has it been running on /crypto?", tokens: [] };
  }

  // Stables and majors are plumbing, not signals — bot wallets touch these on
  // every route hop, so counting them as "bot-traded tokens" is pure noise.
  const EXCLUDED_MINTS = new Set([
    "So11111111111111111111111111111111111111112",  // WSOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  ]);

  try {
    const cutoff = maxAgeMinutes
      ? Date.now() - maxAgeMinutes * 60 * 1000
      : null;

    // SQL parameter ORDER must match the SQL template's `?` placeholders in
    // source order. Template renders (when requireDexData=false, cutoff set):
    //   AND (liquidity >= ?)
    //   AND (volume >= ?)
    //   AND e.timestamp >= ?
    //   LIMIT ?
    // So params must be: [minLiquidityUsd, minVolume24h, cutoff, limit]
    const params = [];
    if (!requireDexData) {
      params.push(minLiquidityUsd);
      params.push(minVolume24h);
    }
    if (cutoff) params.push(cutoff);
    params.push(limit);

    const rows = db.prepare(`
      SELECT
        t.symbol,
        t.name,
        t.mint,
        t.price_usd,
        t.liquidity_usd,
        t.volume_h24,
        t.fdv,
        COUNT(e.token_mint) as trade_count,
        MAX(e.timestamp) as last_trade_ms
      FROM events e
      JOIN tokens t ON t.mint = e.token_mint
      WHERE t.symbol IS NOT NULL
        ${requireDexData ? "AND t.liquidity_usd IS NOT NULL AND t.volume_h24 IS NOT NULL" : ""}
        ${requireDexData ? "" : "AND (t.liquidity_usd IS NULL OR t.liquidity_usd >= ?)"}
        ${requireDexData ? "" : "AND (t.volume_h24 IS NULL OR t.volume_h24 >= ?)"}
        ${cutoff ? "AND e.timestamp >= ?" : ""}
      GROUP BY e.token_mint
      ORDER BY trade_count DESC
      LIMIT ?
    `).all(...params);

    db.close();

    return {
      success: true,
      source: "bot-tracker (crypto)",
      tokens: rows.filter(r => !EXCLUDED_MINTS.has(r.mint)).map(r => ({
        symbol: r.symbol,
        name: r.name,
        mint: r.mint,
        price_usd: r.price_usd,
        liquidity_usd: r.liquidity_usd,
        volume_24h: r.volume_h24,
        fdv: r.fdv,
        trade_count: r.trade_count,
        last_trade_ago: r.last_trade_ms ? `${Math.round((Date.now() - r.last_trade_ms) / 60000)}m ago` : null,
      })),
    };
  } catch (e) {
    db?.close();
    log("crypto_signals", `Query error: ${e.message}`);
    return { success: false, error: e.message, tokens: [] };
  }
}
