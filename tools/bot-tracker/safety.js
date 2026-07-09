/**
 * Rug / safety gate — the real "avoid getting dumped on" protection.
 *
 * Checks the fatal, hard-to-recover-from risks that momentum can't see:
 *   - mint authority still enabled   (dev can print infinite supply)
 *   - freeze authority still enabled (honeypot: your wallet can be frozen)
 *   - LP not locked / burned          (dev can pull liquidity to zero)
 *   - top-holder concentration        (insiders can dump on you)
 *
 * Source preference:
 *   1. RugCheck summary (1 call, aggregates all of the above)
 *   2. RPC fallback: getAccountInfo (authorities) + getTokenLargestAccounts
 *
 * Results are cached on the token row (SAFETY_TTL_MIN) so we don't re-check
 * constantly. The gate is enforced at the alert boundary (only the handful of
 * tokens we're about to notify), keeping it cheap.
 */
import { getConnection, reportRpcFailure } from "./utils/rpc-pool.js";
import { CONFIG } from "./config.js";
import { log } from "./logger.js";

const DANGER_NAMES = [
  "mint authority",
  "freeze authority",
  "lp unlocked",
  "lp not locked",
  "liquidity unlocked",
  "single holder",
  "top 10 holders",
  "top holders",
  "creator",
];

async function viaRugcheck(mint) {
  try {
    const r = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`,
      { signal: AbortSignal.timeout(12_000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.risks)) return null;
    const flags = [];
    for (const risk of j.risks) {
      const name = (risk.name || "").toLowerCase();
      const level = (risk.level || "").toLowerCase();
      const isDanger =
        level === "danger" || DANGER_NAMES.some((d) => name.includes(d));
      if (isDanger) flags.push(risk.name || name);
    }
    return { safe: flags.length === 0, flags, score: j.score ?? null };
  } catch {
    return null;
  }
}

async function rpc(method, params) {
  const conn = getConnection();
  let r;
  try {
    r = await fetch(conn.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    reportRpcFailure(conn.rpcEndpoint);
    throw e;
  }
  if (!r.ok) {
    if (r.status === 429 || r.status === 401 || r.status >= 500)
      reportRpcFailure(conn.rpcEndpoint);
    throw new Error(`RPC HTTP ${r.status}`);
  }
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function viaRpc(mint) {
  try {
    const info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const parsed = info?.value?.data?.parsed?.info;
    if (!parsed) return null;
    const flags = [];
    if (parsed.mintAuthority) flags.push("mint authority enabled");
    if (parsed.freezeAuthority) flags.push("freeze authority enabled");

    // Top-holder concentration.
    const decimals = parsed.decimals ?? 0;
    const supply = Number(parsed.supply) / 10 ** decimals;
    if (supply > 0) {
      const largest = await rpc("getTokenLargestAccounts", [mint]);
      const accts = largest?.value || [];
      const top10 = accts
        .slice(0, 10)
        .reduce((a, b) => a + (b.uiAmount || 0), 0);
      const top10Pct = (top10 / supply) * 100;
      if (top10Pct > CONFIG.maxTop10Pct)
        flags.push(`top10 ${Math.round(top10Pct)}%`);
    }
    // Note: RPC path cannot verify LP lock — that's RugCheck-only.
    return { safe: flags.length === 0, flags, score: null };
  } catch (e) {
    log("safety_warn", `RPC safety(${mint.slice(0, 6)}): ${e.message}`);
    return null;
  }
}

/** Raw check (network). Returns { safe, flags, score } or null when unknown. */
export async function checkSafety(mint) {
  const rc = await viaRugcheck(mint);
  if (rc) return rc;
  return viaRpc(mint);
}

/**
 * Return cached safety when fresh, otherwise check + persist. Returns the
 * token's { safe, flags } (safe: 1 safe, 0 unsafe, null unknown).
 */
export async function ensureSafety(db, mint) {
  const now = Date.now();
  const row = db
    .prepare("SELECT safe, safety_flags, last_safety_at FROM tokens WHERE mint = ?")
    .get(mint);
  const ttlMs = CONFIG.safetyTtlMin * 60_000;
  if (row && row.safe != null && row.last_safety_at && now - row.last_safety_at < ttlMs) {
    return { safe: row.safe, flags: row.safety_flags ? JSON.parse(row.safety_flags) : [] };
  }
  const res = await checkSafety(mint);
  if (!res) {
    db.prepare("UPDATE tokens SET last_safety_at = ? WHERE mint = ?").run(now, mint);
    return { safe: null, flags: [] };
  }
  const safeInt = res.safe ? 1 : 0;
  db.prepare(
    "UPDATE tokens SET safe = ?, safety_flags = ?, last_safety_at = ? WHERE mint = ?"
  ).run(safeInt, JSON.stringify(res.flags), now, mint);
  return { safe: safeInt, flags: res.flags };
}
