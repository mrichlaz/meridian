/**
 * Holder-growth tracker — an organic-demand signal.
 *
 * Rising unique holders over time is hard to fake with wash trading, so a
 * positive holder trendline is strong confirmation that a token is genuinely
 * being accumulated (not just churned by bots).
 *
 * Economics: we only sample a SHORTLIST of already-active, un-pumped tokens,
 * on a slow timer (HOLDER_INTERVAL_MS, default 10 min). Source preference:
 *   1. Birdeye token_overview (1 call, direct holder count) if BIRDEYE_API_KEY
 *   2. Helius DAS getTokenAccounts (`total` field) otherwise
 */
import { getDB } from "./db.js";
import { log } from "./logger.js";
import { getConnection, reportRpcFailure } from "./utils/rpc-pool.js";
import { CONFIG } from "./config.js";

async function holdersViaBirdeye(mint) {
  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
      {
        headers: {
          "X-API-KEY": CONFIG.birdeyeApiKey,
          "x-chain": "solana",
        },
        signal: AbortSignal.timeout(12_000),
      }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const h = j?.data?.holder;
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

async function heliusPost(body) {
  const conn = getConnection();
  let r;
  try {
    r = await fetch(conn.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    reportRpcFailure(conn.rpcEndpoint);
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

async function holdersViaHelius(mint) {
  // DAS getTokenAccounts returns `total`; when absent, count pages up to a cap.
  try {
    let page = 1;
    let count = 0;
    let sawTotal = null;
    while (page <= CONFIG.holderPageCap) {
      const res = await heliusPost({
        jsonrpc: "2.0",
        id: "holders",
        method: "getTokenAccounts",
        params: { mint, limit: 1000, page, options: { showZeroBalance: false } },
      });
      if (res?.total != null) sawTotal = res.total;
      const accts = res?.token_accounts || [];
      count += accts.length;
      if (accts.length < 1000) break; // last page
      page++;
    }
    if (sawTotal != null) return sawTotal;
    return count > 0 ? count : null;
  } catch (e) {
    log("holders_warn", `Helius holders(${mint.slice(0, 6)}): ${e.message}`);
    return null;
  }
}

async function getHolderCount(mint) {
  if (CONFIG.birdeyeApiKey) {
    const h = await holdersViaBirdeye(mint);
    if (h != null) return h;
  }
  return holdersViaHelius(mint);
}

/**
 * Refresh holder counts for a bounded shortlist of active tokens that are due,
 * writing a holder_snaps row + updating the token's current/prev holders.
 */
export async function refreshHolders() {
  if (!CONFIG.holderTracking) return { refreshed: 0 };
  const db = getDB();
  const now = Date.now();
  const activeCutoff = now - CONFIG.inactiveWindowMin * 60_000;
  const dueCutoff = now - CONFIG.holderInterval;

  const shortlist = db
    .prepare(
      `SELECT mint FROM tokens
       WHERE pumped = 0 AND faded = 0 AND symbol IS NOT NULL
         AND last_event >= ?
         AND (last_holders_at IS NULL OR last_holders_at < ?)
       ORDER BY occurrence_count DESC, last_event DESC
       LIMIT ?`
    )
    .all(activeCutoff, dueCutoff, CONFIG.holderShortlist);
  if (!shortlist.length) return { refreshed: 0 };

  const insSnap = db.prepare(
    "INSERT OR REPLACE INTO holder_snaps (mint, timestamp, holders) VALUES (?,?,?)"
  );
  const upTok = db.prepare(
    `UPDATE tokens SET prev_holders = holders, holders = ?, last_holders_at = ? WHERE mint = ?`
  );

  let refreshed = 0;
  for (const { mint } of shortlist) {
    const h = await getHolderCount(mint);
    const ts = Date.now();
    if (h == null) {
      // Still stamp so we don't hammer a token that has no holder source.
      db.prepare("UPDATE tokens SET last_holders_at = ? WHERE mint = ?").run(ts, mint);
      continue;
    }
    db.transaction(() => {
      insSnap.run(mint, ts, h);
      upTok.run(h, ts, mint);
    })();
    refreshed++;
    await new Promise((r) => setTimeout(r, 250)); // gentle pacing
  }

  if (refreshed > 0) log("holders", `Refreshed holder counts for ${refreshed} token(s)`);
  return { refreshed };
}

/**
 * Fit a simple least-squares slope of holders vs time over the window.
 * Returns null when there aren't enough samples.
 */
export function holderTrend(db, mint) {
  const windowStart = Date.now() - CONFIG.holderWindowMin * 60_000;
  const rows = db
    .prepare(
      `SELECT timestamp, holders FROM holder_snaps
       WHERE mint = ? AND timestamp >= ? ORDER BY timestamp ASC`
    )
    .all(mint, windowStart);
  if (rows.length < 3) return null;

  // Regress holders on elapsed minutes.
  const t0 = rows[0].timestamp;
  const xs = rows.map((r) => (r.timestamp - t0) / 60_000);
  const ys = rows.map((r) => r.holders);
  const n = rows.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const denom = n * sxx - sx * sx;
  const slopePerMin = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;

  const first = ys[0];
  const last = ys[n - 1];
  const deltaPct = first > 0 ? ((last - first) / first) * 100 : 0;

  return {
    samples: n,
    holders: last,
    slopePerHour: slopePerMin * 60,
    deltaPct,
    rising: slopePerMin > 0 && last >= first,
  };
}
