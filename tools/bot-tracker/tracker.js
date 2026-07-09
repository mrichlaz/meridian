/**
 * Tracker — the ingest half of the app.
 *
 *  1. Poll each tracked wallet's recent signatures (Helius RPC).
 *  2. Extract non-WSOL token mints from each new tx → record an `event`.
 *  3. Periodically enrich tracked tokens from DexScreener (price, market cap,
 *     liquidity, 24h volume) and write a time-series `snapshot`.
 *  4. On every enrichment, roll the token's OBV forward and stash prev_* values
 *     so the scoring engine can compute market-cap / volume deltas.
 */
import { getDB } from "./db.js";
import { log } from "./logger.js";
import { getConnection, nextHeliusKey, reportRpcFailure, reportKeyFailure } from "./utils/rpc-pool.js";
import { CONFIG, DEX_NAMES, DEX_API, WSOL, EXCLUDED_MINTS } from "./config.js";
import { getTrackedWallets } from "./arb-wallets.js";

const BATCH_SIZE = 30;

// ─── Rate limiter ───
class RateLimiter {
  constructor(gapMs) {
    this.gap = gapMs;
    this.last = 0;
  }
  async wait() {
    const wait = Math.max(0, this.gap - (Date.now() - this.last));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
  }
}

async function heliusCall(method, params) {
  const conn = getConnection();
  let r;
  try {
    r = await fetch(conn.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    reportRpcFailure(conn.rpcEndpoint); // network/timeout → rotate away
    throw e;
  }
  if (!r.ok) {
    if (r.status === 429 || r.status === 401 || r.status >= 500)
      reportRpcFailure(conn.rpcEndpoint);
    throw new Error(`Helius HTTP ${r.status}`);
  }
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

function extractMints(tx) {
  if (!tx?.meta) return [];
  const s = new Set();
  for (const t of tx.meta.preTokenBalances || []) if (t.mint) s.add(t.mint);
  for (const t of tx.meta.postTokenBalances || []) if (t.mint) s.add(t.mint);
  return [...s].filter((m) => m !== WSOL && !EXCLUDED_MINTS.has(m));
}

// ─── Helius Enhanced Transactions API: batch-parse up to 100 sigs per call ──
// One HTTP call replaces up to 100 getTransaction RPC calls. Returns a Map of
// signature → { mints:[], ts }. Only usable with Helius keys.
async function parseEnhanced(sigs) {
  const key = nextHeliusKey();
  if (!key) return null; // signal caller to fall back
  const out = new Map();
  for (let i = 0; i < sigs.length; i += 100) {
    const chunk = sigs.slice(i, i + 100);
    try {
      const r = await fetch(
        `https://api.helius.xyz/v0/transactions/?api-key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactions: chunk }),
          signal: AbortSignal.timeout(20_000),
        }
      );
      if (!r.ok) {
        if (r.status === 429 || r.status === 401 || r.status >= 500)
          reportKeyFailure(key);
        log("tracker_warn", `Enhanced API HTTP ${r.status}`);
        continue;
      }
      const arr = await r.json();
      for (const tx of arr || []) {
        const mints = new Set();
        for (const tt of tx.tokenTransfers || []) {
          if (tt.mint && tt.mint !== WSOL && !EXCLUDED_MINTS.has(tt.mint))
            mints.add(tt.mint);
        }
        out.set(tx.signature, {
          mints: [...mints],
          ts: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
        });
      }
    } catch (e) {
      log("tracker_warn", `Enhanced API error: ${e.message}`);
    }
    if (i + 100 < sigs.length) await new Promise((res) => setTimeout(res, 300));
  }
  return out;
}

// ─── DexScreener batch fetch with 429 backoff ───
async function fetchDexData(mints) {
  if (!mints.length) return new Map();
  const out = new Map();
  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const batch = mints.slice(i, i + BATCH_SIZE).join(",");
    let retries = 3;
    while (retries > 0) {
      try {
        const r = await fetch(`${DEX_API}/${batch}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (r.status === 429) {
          retries--;
          await new Promise((res) => setTimeout(res, (4 - retries) * 3000));
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
          (groups[bt] ||= []).push(p);
        }
        for (const [mint, pairs] of Object.entries(groups)) {
          let best = pairs[0];
          for (const p of pairs)
            if ((p.liquidity?.usd || 0) > (best.liquidity?.usd || 0)) best = p;
          let totalLiq = 0,
            totalVol = 0;
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
            marketCap: best.marketCap ?? best.fdv ?? null,
            volume: totalVol,
            volM5: best.volume?.m5 ?? null,
            volH1: best.volume?.h1 ?? null,
            buysH1: best.txns?.h1?.buys ?? null,
            sellsH1: best.txns?.h1?.sells ?? null,
            priceChangeH1: best.priceChange?.h1 ?? null,
            pairCreatedAt: best.pairCreatedAt ?? null,
            dex: DEX_NAMES[best.pairAddress] || best.dexId || null,
          });
        }
        break;
      } catch {
        retries--;
        if (retries > 0) await new Promise((res) => setTimeout(res, 2000));
      }
    }
    if (i + BATCH_SIZE < mints.length)
      await new Promise((res) => setTimeout(res, 3000));
  }
  return out;
}

// Persist parsed sigs → events. `parsed` is Map<sig,{mints,ts}>, walletBySig
// attributes each sig to the wallet whose feed it came from.
function recordParsed(db, parsed, walletBySig, stats) {
  const insSeen = db.prepare("INSERT OR IGNORE INTO seen_sigs VALUES (?,?)");
  const insEvent = db.prepare("INSERT OR IGNORE INTO events VALUES (?,?,?,?)");
  const upToken = db.prepare(`
    INSERT INTO tokens (mint, first_seen, last_seen, last_event, occurrence_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(mint) DO UPDATE SET
      last_seen = excluded.last_seen,
      last_event = excluded.last_event,
      occurrence_count = tokens.occurrence_count + 1
  `);
  const now = Date.now();
  db.transaction(() => {
    for (const [sig, info] of parsed) {
      insSeen.run(sig, now);
      const wallet = walletBySig.get(sig) || null;
      for (const m of info.mints) {
        insEvent.run(sig, m, wallet, info.ts);
        upToken.run(m, info.ts, info.ts, info.ts);
        stats.newEvents++;
      }
    }
  })();
}

// Fallback path (non-Helius RPC): parse sigs one at a time via getTransaction.
async function parseViaRpc(txrl, sigs) {
  const out = new Map();
  for (const sig of sigs) {
    await txrl.wait();
    try {
      const t = await heliusCall("getTransaction", [
        sig,
        { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ]);
      if (!t) {
        out.set(sig, { mints: [], ts: Date.now() });
        continue;
      }
      out.set(sig, {
        mints: extractMints(t),
        ts: t.blockTime ? t.blockTime * 1000 : Date.now(),
      });
    } catch {
      /* skip this sig; it stays unseen and may retry next cycle */
    }
  }
  return out;
}

/**
 * Enrich the most relevant tokens and write snapshots + OBV.
 * Prioritises never-enriched tokens, then most active + most recent.
 */
export async function enrichTokens(db) {
  // Enrich the MOST ACTIVE tokens every cycle so they accumulate the 3+
  // snapshots momentum needs. (Prioritising never-enriched tokens instead
  // starved the signal: under a busy stream, new tokens kept jumping the queue
  // and the hot ones never built any history.)
  const tokens = db
    .prepare(
      `
    SELECT mint, price_usd, volume_h24, obv, first_price
    FROM tokens
    ORDER BY occurrence_count DESC, last_event DESC
    LIMIT 120
  `
    )
    .all();
  if (!tokens.length) return;

  const data = await fetchDexData(tokens.map((t) => t.mint));
  if (!data.size) return;

  const now = Date.now();
  const prevByMint = new Map(tokens.map((t) => [t.mint, t]));

  const upToken = db.prepare(`
    UPDATE tokens SET
      symbol = COALESCE(?, symbol),
      name = COALESCE(?, name),
      dex = COALESCE(?, dex),
      price_usd = ?, liquidity_usd = ?, fdv = ?, market_cap = ?, volume_h24 = ?,
      prev_price = ?, prev_volume_h24 = ?, prev_market_cap = ?,
      first_price = COALESCE(first_price, ?),
      pair_created_at = COALESCE(?, pair_created_at),
      buys_h1 = ?, sells_h1 = ?, price_change_h1 = ?,
      obv = ?, last_enriched = ?, last_seen = ?
    WHERE mint = ?
  `);
  const insSnap = db.prepare(`
    INSERT OR REPLACE INTO snapshots
      (mint, timestamp, price_usd, market_cap, volume_h24, liquidity_usd, flow, obv)
    VALUES (?,?,?,?,?,?,?,?)
  `);

  // Per-interval traded volume ≈ short DexScreener bucket scaled to the enrich
  // cadence, so overlapping windows aren't counted multiple times.
  const enrichMin = CONFIG.enrichInterval / 60_000;
  const flowFrom = (d, prev) => {
    if (d.volM5 != null) return Math.max(0, d.volM5) * (enrichMin / 5);
    if (d.volH1 != null) return Math.max(0, d.volH1) * (enrichMin / 60);
    return Math.max(0, (d.volume || 0) - (prev.volume_h24 || 0));
  };

  db.transaction(() => {
    for (const [mint, d] of data) {
      const prev = prevByMint.get(mint) || {};
      // OBV: signed per-interval flow — add when price rises, subtract when it
      // falls. Textbook OBV, using a fresh-flow proxy instead of diffing h24.
      let obv = prev.obv || 0;
      const flow = flowFrom(d, prev);
      if (prev.price_usd != null && d.price != null) {
        if (d.price > prev.price_usd) obv += flow;
        else if (d.price < prev.price_usd) obv -= flow;
      }
      upToken.run(
        d.symbol, d.name, d.dex,
        d.price, d.liquidity, d.fdv, d.marketCap, d.volume,
        prev.price_usd ?? null, prev.volume_h24 ?? null, prev.market_cap ?? null,
        d.price ?? null,
        d.pairCreatedAt ?? null,
        d.buysH1 ?? null, d.sellsH1 ?? null, d.priceChangeH1 ?? null,
        obv, now, now,
        mint
      );
      insSnap.run(mint, now, d.price, d.marketCap, d.volume, d.liquidity, Math.round(flow), obv);
    }
  })();
}

let _stopped = false;
let _running = false;

export function startTracker() {
  if (_running) return;
  _running = true;
  _stopped = false;
  const db = getDB();
  const txrl = new RateLimiter(200);
  const sigrl = new RateLimiter(100);
  let lastHeartbeat = 0;

  log("tracker", `Started tracking ${getTrackedWallets().length} wallet(s)...`);

  (async function loop() {
    while (!_stopped) {
      try {
        const stats = { newEvents: 0, errors: [] };

        // 1. Collect NEW (unseen) signatures across wallets — 1 RPC call/wallet.
        const walletBySig = new Map();
        const newSigs = [];
        const seenStmt = db.prepare(
          "SELECT 1 FROM seen_sigs WHERE tx_signature=? LIMIT 1"
        );
        for (const wallet of getTrackedWallets()) {
          if (_stopped) break;
          await sigrl.wait();
          let sigs;
          try {
            sigs = await heliusCall("getSignaturesForAddress", [
              wallet,
              { limit: CONFIG.sigLimit },
            ]);
          } catch {
            continue;
          }
          for (const s of sigs) {
            if (walletBySig.has(s.signature)) continue;
            if (seenStmt.get(s.signature)) continue;
            walletBySig.set(s.signature, wallet);
            newSigs.push(s.signature);
          }
        }

        // Bound the per-cycle parse budget (protects against very active bots).
        const toParse = newSigs.slice(0, CONFIG.maxSigsPerCycle);

        // 2. Parse in bulk. Prefer Helius Enhanced API (1 call / 100 sigs);
        // fall back to per-sig getTransaction only when no Helius key exists.
        if (toParse.length) {
          let parsed = await parseEnhanced(toParse);
          if (parsed === null) parsed = await parseViaRpc(txrl, toParse);
          recordParsed(db, parsed, walletBySig, stats);
        }

        // Enrichment now runs on its own timer in index.js (all modes), so it
        // keeps producing snapshots even when this poller is idle in stream
        // mode. Nothing to enrich here.

        if (stats.newEvents > 0) {
          const c = db.prepare("SELECT COUNT(*) c FROM tokens").get().c;
          log(
            "tracker",
            `${toParse.length} new sigs → ${stats.newEvents} token events, ${c} tokens tracked`
          );
        }

        if (Date.now() - lastHeartbeat > 300_000) {
          const tk = db.prepare("SELECT COUNT(*) c FROM tokens").get().c;
          const ev = db.prepare("SELECT COUNT(*) c FROM events").get().c;
          log("tracker", `Heartbeat — ${tk} tokens, ${ev} events`);
          lastHeartbeat = Date.now();
        }
      } catch (e) {
        log("tracker_error", `Cycle error: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, CONFIG.pollInterval));
    }
    _running = false;
    log("tracker", "Stopped");
  })();
}

export function stopTracker() {
  _stopped = true;
}
