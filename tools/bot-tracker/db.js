/**
 * SQLite persistence for the bot tracker.
 *
 * Schema (kept intentionally small + indexed so it stays fast under a very
 * active wallet):
 *   seen_sigs  — dedup of processed signatures
 *   events     — a tracked wallet touched a token mint at time T
 *   tokens     — latest metadata + running OBV + prev values for delta calc
 *   snapshots  — time-series of price / market cap / volume for momentum
 */
import Database from "better-sqlite3";
import fs from "fs";
import { PATHS } from "./config.js";
import { log } from "./logger.js";

function openWithSchema() {
  const db = new Database(PATHS.db);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 500");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_sigs (
      tx_signature TEXT PRIMARY KEY,
      timestamp    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      tx_signature TEXT,
      token_mint   TEXT NOT NULL,
      wallet       TEXT,
      timestamp    INTEGER NOT NULL,
      PRIMARY KEY (tx_signature, token_mint)
    );

    CREATE TABLE IF NOT EXISTS tokens (
      mint             TEXT PRIMARY KEY,
      symbol           TEXT,
      name             TEXT,
      dex              TEXT,
      first_seen       INTEGER NOT NULL,
      last_seen        INTEGER NOT NULL,
      last_event       INTEGER,
      occurrence_count INTEGER DEFAULT 1,
      price_usd        REAL,
      liquidity_usd    REAL,
      fdv              REAL,
      market_cap       REAL,
      volume_h24       REAL,
      prev_price       REAL,
      prev_volume_h24  REAL,
      prev_market_cap  REAL,
      first_price      REAL,
      pair_created_at  INTEGER,
      buys_h1          INTEGER,
      sells_h1         INTEGER,
      price_change_h1  REAL,
      obv              REAL DEFAULT 0,
      last_enriched    INTEGER,
      last_notified    INTEGER,
      last_fade_notified INTEGER,
      last_surge_notified INTEGER,
      holders          INTEGER,
      prev_holders     INTEGER,
      last_holders_at  INTEGER,
      safe             INTEGER,
      safety_flags     TEXT,
      last_safety_at   INTEGER,
      pumped_at        INTEGER,
      peak_mcap        REAL,
      pump_count       INTEGER DEFAULT 0,
      faded            INTEGER DEFAULT 0,
      pumped           INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      mint          TEXT NOT NULL,
      timestamp     INTEGER NOT NULL,
      price_usd     REAL,
      market_cap    REAL,
      volume_h24    REAL,
      liquidity_usd REAL,
      flow          REAL,   -- per-interval traded volume (signed into OBV)
      obv           REAL,
      PRIMARY KEY (mint, timestamp)
    );

    CREATE TABLE IF NOT EXISTS holder_snaps (
      mint      TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      holders   INTEGER NOT NULL,
      PRIMARY KEY (mint, timestamp)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mint        TEXT NOT NULL,
      symbol      TEXT,
      type        TEXT NOT NULL,       -- 'top' | 'surge'
      ts          INTEGER NOT NULL,
      entry_price REAL,
      entry_mcap  REAL,
      score       REAL,
      p15         REAL,
      p60         REAL,
      p360        REAL,
      max_gain_pct REAL DEFAULT 0,
      resolved    INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS e_tt  ON events(token_mint, timestamp);
    CREATE INDEX IF NOT EXISTS e_ts  ON events(timestamp);
    CREATE INDEX IF NOT EXISTS s_ts  ON seen_sigs(timestamp);
    CREATE INDEX IF NOT EXISTS sn_mt ON snapshots(mint, timestamp);
    CREATE INDEX IF NOT EXISTS hs_mt ON holder_snaps(mint, timestamp);
    CREATE INDEX IF NOT EXISTS al_mint ON alerts(mint);
    CREATE INDEX IF NOT EXISTS al_res ON alerts(resolved);
    CREATE INDEX IF NOT EXISTS tk_ev ON tokens(last_event);
  `);

  // Lightweight migrations for older DBs — add columns if missing.
  const snapCols = db.prepare("PRAGMA table_info(snapshots)").all();
  if (!snapCols.some((c) => c.name === "flow")) {
    db.exec("ALTER TABLE snapshots ADD COLUMN flow REAL");
  }
  const evCols = db.prepare("PRAGMA table_info(events)").all();
  if (!evCols.some((c) => c.name === "wallet")) {
    db.exec("ALTER TABLE events ADD COLUMN wallet TEXT");
  }
  const tkCols = db.prepare("PRAGMA table_info(tokens)").all();
  const addTokCol = (name, type) => {
    if (!tkCols.some((c) => c.name === name))
      db.exec(`ALTER TABLE tokens ADD COLUMN ${name} ${type}`);
  };
  addTokCol("first_price", "REAL");
  addTokCol("pair_created_at", "INTEGER");
  addTokCol("buys_h1", "INTEGER");
  addTokCol("sells_h1", "INTEGER");
  addTokCol("price_change_h1", "REAL");
  addTokCol("last_fade_notified", "INTEGER");
  addTokCol("faded", "INTEGER");
  addTokCol("last_surge_notified", "INTEGER");
  addTokCol("holders", "INTEGER");
  addTokCol("prev_holders", "INTEGER");
  addTokCol("last_holders_at", "INTEGER");
  addTokCol("safe", "INTEGER");
  addTokCol("safety_flags", "TEXT");
  addTokCol("last_safety_at", "INTEGER");
  addTokCol("pumped_at", "INTEGER");
  addTokCol("peak_mcap", "REAL");
  addTokCol("pump_count", "INTEGER");
  return db;
}

let _db = null;

export function getDB() {
  if (_db) return _db;
  try {
    fs.mkdirSync(PATHS.data, { recursive: true });
    _db = openWithSchema();
  } catch (e) {
    log("db_error", `DB error: ${e.message} — recreating...`);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(PATHS.db + suffix);
      } catch {}
    }
    _db = openWithSchema();
  }
  return _db;
}

export function closeDB() {
  if (_db) {
    try {
      _db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    _db.close();
    _db = null;
  }
}

/**
 * Distinct bot wallets that have actually shown up in the events table, with
 * activity stats derived from the observed txs. This is the DB-side mirror of
 * `arb-wallets.js` — the curated list from sandwiched.me is a *watchlist*;
 * the result here is what the tracked-data path has *actually* seen.
 *
 * Distinguishes "currently active" from "stale" so the operator can tell at
 * a glance whether a wallet in the watchlist is actually doing anything.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs]  only count events within this many ms
 *                                  (default 24h); 0 disables the window.
 * @param {number} [opts.minEvents] hide wallets with fewer than this many
 *                                  events (default 1).
 * @param {boolean} [opts.activeOnly] only return wallets with at least one
 *                                  event within `activeWindowMs` (default 30 min).
 * @returns {Array<{wallet: string, events: number, distinct_tokens: number,
 *                  first_seen: number, last_seen: number, active: boolean}>}
 */
/**
 * Distinct bot wallets that have actually shown up in the events table, with
 * activity stats derived from the observed txs. This is the DB-side mirror of
 * `arb-wallets.js` — the curated list from sandwiched.me is a *watchlist*;
 * the result here is what the tracked-data path has *actually* seen.
 *
 * Distinguishes "currently active" from "stale" so the operator can tell at
 * a glance whether a wallet in the watchlist is actually doing anything.
 *
 * Set `withTokens: true` to populate each row with a `tokens` array of the
 * mints that wallet has touched (sorted by per-token event count, so the
 * busiest token comes first). The token rows are joined from the `tokens`
 * table so symbol/name/dex/price are populated when available — useful for
 * "which wallets are moving this specific token?" follow-ups.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs]  only count events within this many ms
 *                                  (default 24h); 0 disables the window.
 * @param {number} [opts.minEvents] hide wallets with fewer than this many
 *                                  events (default 1).
 * @param {boolean} [opts.activeOnly] only return wallets with at least one
 *                                  event within `activeWindowMs` (default 30 min).
 * @param {number} [opts.maxTokensPerWallet] cap on the `tokens` array size
 *                                  when `withTokens` is set (default 10).
 * @param {boolean} [opts.withTokens] populate each row's `tokens` array.
 * @returns {Array<{wallet: string, events: number, distinct_tokens: number,
 *                  first_seen: number, last_seen: number, active: boolean,
 *                  tokens?: Array<{mint: string, symbol: string|null,
 *                                   name: string|null, dex: string|null,
 *                                   events: number, last_event: number}>}>}
 */
export function botsFromEvents({
  windowMs = 24 * 60 * 60_000,
  minEvents = 1,
  activeOnly = false,
  activeWindowMs = 30 * 60_000,
  withTokens = false,
  maxTokensPerWallet = 10,
} = {}) {
  const db = getDB();
  const where = ["wallet IS NOT NULL", "length(wallet) > 0"];
  const params = [];
  if (windowMs > 0) {
    where.push("timestamp >= ?");
    params.push(Date.now() - windowMs);
  }
  const sql = `
    SELECT
      wallet,
      COUNT(*) AS events,
      COUNT(DISTINCT token_mint) AS distinct_tokens,
      MIN(timestamp) AS first_seen,
      MAX(timestamp) AS last_seen
    FROM events
    WHERE ${where.join(" AND ")}
    GROUP BY wallet
    HAVING events >= ?
    ORDER BY events DESC, last_seen DESC
  `;
  params.push(minEvents);
  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return rows;
  const now = Date.now();
  const out = rows
    .filter((r) => !activeOnly || now - r.last_seen <= activeWindowMs)
    .map((r) => ({ ...r, active: now - r.last_seen <= activeWindowMs }));

  if (!withTokens || !out.length) return out;

  // One round-trip per wallet keeps the SQL bounded and predictable; the cap
  // (`maxTokensPerWallet`) avoids unbounded payloads for whales that touch
  // hundreds of tokens. Operators who want the full list can pump up the cap.
  const mintCountSql = `
    SELECT
      e.token_mint AS mint,
      t.symbol,
      t.name,
      t.dex,
      COUNT(*) AS events,
      MAX(e.timestamp) AS last_event
    FROM events e
    LEFT JOIN tokens t ON t.mint = e.token_mint
    WHERE e.wallet = ? ${windowMs > 0 ? "AND e.timestamp >= ?" : ""}
    GROUP BY e.token_mint
    ORDER BY events DESC, last_event DESC
    LIMIT ?
  `;
  const stmt = db.prepare(mintCountSql);
  for (const r of out) {
    const args = [r.wallet];
    if (windowMs > 0) args.push(Date.now() - windowMs);
    args.push(maxTokensPerWallet);
    r.tokens = stmt.all(...args);
  }
  return out;
}
