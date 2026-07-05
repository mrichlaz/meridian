/**
 * Background Solana bot tracker — polls a tracked wallet for token activity
 * and maintains an SQLite DB that feeds get_crypto_bot_tokens().
 *
 * Silently runs in the background when Meridian starts. No TUI/logs.
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { log } from "../logger.js";
import { getConnection } from "../utils/rpc-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const DB_PATH = path.join(DATA_DIR, "bot-tracker.db");

const BOTS = (process.env.BOT_WALLETS || "3QUnrcMqCQoiGB73s1A6uDzxziywaNFpTLiZiiZbEUoN,NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV,joeHSutRWndCtp1EPx5tz5zHyaPBZUZ5JsxDEVB1RPZ,MEViEnscUm6tsQRoGd9h6nLQaQspKj7DB2M5FwM3Xvz")
  .split(",").map(a => a.trim()).filter(Boolean);
const DEX_API = "https://api.dexscreener.com/latest/dex/tokens";
const W = 4 * 3600 * 1000;       // 4h window
const POLL_INTERVAL = 10_000;     // poll every 10s
const ENRICH_INTERVAL = 60_000;   // enrich every 60s
const SIG_LIMIT = 25;
const BATCH_SIZE = 30;
const WSOL = "So11111111111111111111111111111111111111112";

const DEX_NAMES = {
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

// ─── Rate limiter ───
class RateLimiter {
  constructor(gapMs) { this.gap = gapMs; this.last = 0; }
  async wait() {
    const wait = Math.max(0, this.gap - (Date.now() - this.last));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.last = Date.now();
  }
}

// ─── Fetch with retry ───
async function fetchWithRetry(url, opts, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429) {
        await new Promise(r => setTimeout(r, (i + 1) * 2000));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, (i + 1) * 1000));
    }
  }
  throw lastErr || new Error("fetch failed");
}

// ─── DB init ───
function openWithSchema() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  // wal_autocheckpoint is measured in PAGES (~4KB each). 10000 pages let the
  // WAL balloon to ~40MB before checkpointing; SQLite's default is 1000.
  db.pragma("wal_autocheckpoint = 500");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      tx_signature TEXT,
      token_mint   TEXT NOT NULL,
      timestamp    INTEGER NOT NULL,
      PRIMARY KEY (tx_signature, token_mint)
    );
    CREATE TABLE IF NOT EXISTS tokens (
      mint              TEXT PRIMARY KEY,
      symbol            TEXT,
      name              TEXT,
      price_usd         REAL,
      liquidity_usd     REAL,
      fdv               REAL,
      volume_h24        REAL,
      pair_created_at   INTEGER,
      dex               TEXT,
      last_seen         INTEGER NOT NULL,
      occurrence_count  INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS seen_sigs (
      tx_signature TEXT PRIMARY KEY,
      timestamp    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS e_tt ON events(token_mint, timestamp);
    CREATE INDEX IF NOT EXISTS e_ts ON events(timestamp);
    CREATE INDEX IF NOT EXISTS s_ts ON seen_sigs(timestamp);
  `);
  return db;
}

function initDB() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return openWithSchema();
  } catch (e) {
    // If DB is corrupted, delete and recreate
    log("bot_tracker", `DB error: ${e.message} — recreating...`);
    try {
      fs.unlinkSync(DB_PATH);
      fs.unlinkSync(DB_PATH + '-wal');
      fs.unlinkSync(DB_PATH + '-shm');
    } catch {}
    return openWithSchema();
  }
}

// ─── Helius RPC call ───
async function heliusCall(method, params) {
  const conn = getConnection();
  const r = await fetchWithRetry(conn.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Helius HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// ─── Extract mints from a transaction ───
function extractMints(tx) {
  if (!tx?.meta) return [];
  const s = new Set();
  for (const t of tx.meta.preTokenBalances || []) if (t.mint) s.add(t.mint);
  for (const t of tx.meta.postTokenBalances || []) if (t.mint) s.add(t.mint);
  return [...s].filter(m => m !== WSOL);
}

// ─── DexScreener batch fetch (with 429 retry + backoff) ───
async function fetchDexData(mints) {
  if (!mints.length) return new Map();
  const out = new Map();
  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const batch = mints.slice(i, i + BATCH_SIZE).join(",");
    let retries = 3;
    while (retries > 0) {
      try {
        const r = await fetch(`${DEX_API}/${batch}`, { signal: AbortSignal.timeout(15_000) });
        if (r.status === 429) {
          retries--;
          const wait = (4 - retries) * 3000;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!r.ok) break;
        const d = await r.json();
        if (!d.pairs) break;
        const groups = {};
        for (const p of d.pairs) {
          if (p.chainId !== "solana") continue;
          const bt = p.baseToken?.address;
          if (!bt) continue;
          if (!groups[bt]) groups[bt] = [];
          groups[bt].push(p);
        }
        for (const [mint, pairs] of Object.entries(groups)) {
          let best = pairs[0];
          for (const p of pairs) if ((p.liquidity?.usd || 0) > (best.liquidity?.usd || 0)) best = p;
          let totalLiq = 0, totalVol = 0;
          for (const p of pairs) {
            totalLiq += p.liquidity?.usd || 0;
            totalVol += p.volume?.h24 || 0;
          }
          out.set(mint, {
            symbol: best.baseToken?.symbol || null,
            name: best.baseToken?.name || null,
            price: best.priceUsd != null ? parseFloat(best.priceUsd) : null,
            liquidity: totalLiq,
            fdv: best.fdv ?? null,
            volume: totalVol,
            createdAt: best.pairCreatedAt ?? null,
            dex: DEX_NAMES[best.pairAddress] || best.dexId || null,
          });
        }
        break;
      } catch {
        // A thrown fetch (timeout, DNS) must consume a retry too — the old
        // empty catch left `retries` untouched, so persistent timeouts spun
        // this loop forever and wedged the whole tracker cycle.
        retries--;
        if (retries > 0) await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (i + BATCH_SIZE < mints.length) await new Promise(r => setTimeout(r, 3000));
  }
  return out;
}

// ─── Process a single signature ───
async function processSignature(db, txrl, sig, stats) {
  const seen = db.prepare("SELECT 1 FROM seen_sigs WHERE tx_signature=? LIMIT 1").get(sig);
  if (seen) return;
  await txrl.wait();
  try {
    const t = await heliusCall("getTransaction", [sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    // Record the sig even when the tx has no token mints — otherwise every
    // non-token tx in the wallet's recent list gets re-fetched on every poll.
    db.prepare("INSERT OR IGNORE INTO seen_sigs VALUES (?,?)").run(sig, Date.now());
    if (!t) return;
    const mints = extractMints(t);
    if (!mints.length) return;
    const ts = t.blockTime ? t.blockTime * 1000 : Date.now();
    const ins = db.prepare("INSERT OR IGNORE INTO events VALUES (?,?,?)");
    db.transaction(() => {
      for (const m of mints) {
        ins.run(sig, m, ts);
        stats.newEvents++;
        // Insert placeholder token row if not exists
        db.prepare("INSERT OR IGNORE INTO tokens (mint,last_seen) VALUES (?,?)").run(m, ts);
      }
    })();
    stats.newMints.push(...mints);
  } catch (e) {
    stats.errors.push(e.message);
  }
}

// ─── Enrich token metadata from DexScreener ───
async function enrichTokens(db) {
  const tokens = db.prepare("SELECT mint FROM tokens WHERE occurrence_count > 0 ORDER BY occurrence_count DESC LIMIT 50").all();
  if (!tokens.length) return;
  const mints = tokens.map(r => r.mint);
  const data = await fetchDexData(mints);
  if (data.size === 0) return;
  const up = db.prepare(`
    INSERT INTO tokens (mint,symbol,name,price_usd,liquidity_usd,fdv,volume_h24,pair_created_at,dex,last_seen,occurrence_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(mint) DO UPDATE SET
      symbol=COALESCE(excluded.symbol,tokens.symbol),
      name=COALESCE(excluded.name,tokens.name),
      price_usd=COALESCE(excluded.price_usd,tokens.price_usd),
      liquidity_usd=COALESCE(excluded.liquidity_usd,tokens.liquidity_usd),
      fdv=COALESCE(excluded.fdv,tokens.fdv),
      volume_h24=COALESCE(excluded.volume_h24,tokens.volume_h24),
      pair_created_at=COALESCE(excluded.pair_created_at,tokens.pair_created_at),
      dex=COALESCE(excluded.dex,tokens.dex),
      last_seen=excluded.last_seen,
      occurrence_count=tokens.occurrence_count+1
  `);
  db.transaction(() => {
    for (const [mint, d] of data) {
      up.run(mint, d.symbol, d.name, d.price, d.liquidity, d.fdv, d.volume, d.createdAt, d.dex, Date.now());
    }
  })();
}

// ─── Main background loop ───
let _stopped = false;

export function startBotTracker() {
  const db = initDB();
  if (!db) {
    log("bot_tracker", "DB init failed — tracker disabled");
    return;
  }

  _stopped = false;
  const txrl = new RateLimiter(200);  // 200ms between txs
  const sigrl = new RateLimiter(100);  // 100ms between sig fetches

  let lastEnrich = 0;

  log("bot_tracker", `Started tracking ${BOTS.length} wallet(s)...`);

  let lastHeartbeat = 0;

  (async function loop() {
    while (!_stopped) {
      try {
        const stats = { newEvents: 0, newMints: [], errors: [] };

        // Poll all tracked wallets
        for (const wallet of BOTS) {
          if (_stopped) break;

          // Fetch recent signatures
          await sigrl.wait();
          let sigs;
          try {
            sigs = await heliusCall("getSignaturesForAddress", [wallet, { limit: SIG_LIMIT }]);
          } catch {
            continue;
          }

          // Process each new signature
          for (const s of sigs) {
            if (_stopped) break;
            await processSignature(db, txrl, s.signature, stats);
          }

          // Brief pause between wallets
          await new Promise(r => setTimeout(r, 500));
        }

        // DexScreener enrichment every ENRICH_INTERVAL
        if (Date.now() - lastEnrich > ENRICH_INTERVAL) {
          await enrichTokens(db);
          lastEnrich = Date.now();
        }

        // Prune old events + orphaned tokens outside 4h window
        const cutoff = Date.now() - W;
        db.prepare("DELETE FROM events WHERE timestamp < ?").run(cutoff);
        db.prepare("DELETE FROM tokens WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.token_mint = tokens.mint)").run();
        db.prepare("DELETE FROM seen_sigs WHERE timestamp < ?").run(cutoff);
        // Fold the WAL back into the main db so it can't accumulate unbounded
        try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}

        if (stats.newEvents > 0) {
          log("bot_tracker", `${stats.newEvents} new events, ${db.prepare("SELECT COUNT(*) as c FROM tokens").get().c} tokens tracked`);
        }

        // Heartbeat every 5 minutes so terminal shows the tracker is alive
        if (Date.now() - lastHeartbeat > 300_000) {
          const tokenCount = db.prepare("SELECT COUNT(*) as c FROM tokens").get().c;
          const eventCount = db.prepare("SELECT COUNT(*) as c FROM events").get().c;
          log("bot_tracker", `Heartbeat — ${tokenCount} tokens, ${eventCount} events tracked`);
          lastHeartbeat = Date.now();
        }
      } catch (e) {
        log("bot_tracker", `Cycle error: ${e.message}`);
      }

      // Wait for next poll
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    db.close();
    log("bot_tracker", "Stopped");
  })();
}

export function stopBotTracker() {
  _stopped = true;
}
