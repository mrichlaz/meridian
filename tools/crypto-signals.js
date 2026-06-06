import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRYPTO_DB = path.resolve(__dirname, "../data/bot-tracker.db");

/**
 * Read top tokens from the crypto bot tracker SQLite DB.
 * Returns tokens with the most trade events, optionally filtered by recency.
 */
export function getCryptoBotTokens({ limit = 10, maxAgeMinutes = null } = {}) {
  let db;
  try {
    db = new Database(CRYPTO_DB, { readonly: true });
  } catch (e) {
    log("crypto_signals", `Cannot open crypto DB: ${e.message}`);
    return { success: false, error: "Crypto tracker DB not found — has it been running on /crypto?", tokens: [] };
  }

  try {
    const cutoff = maxAgeMinutes
      ? Date.now() - maxAgeMinutes * 60 * 1000
      : null;

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
        AND t.liquidity_usd IS NOT NULL
        AND t.volume_h24 IS NOT NULL
        AND t.liquidity_usd > 50000
        AND t.volume_h24 > 500000
        ${cutoff ? "AND e.timestamp >= ?" : ""}
      GROUP BY e.token_mint
      ORDER BY trade_count DESC
      LIMIT ?
    `).all(...(cutoff ? [cutoff, limit] : [limit]));

    db.close();

    return {
      success: true,
      source: "bot-tracker (crypto)",
      tokens: rows.map(r => ({
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
