// Reconstruct a closed-position performance record from on-chain data.
//
// When a position is closed via an external wallet (Phantom, Solfare, etc.)
// the agent's local cache may be stale or empty. This module searches the
// wallet's recent transactions for the close instruction, parses the SOL
// and base-token balance changes, then derives:
//   - closed_at            (block time of the close tx)
//   - final_sol            (SOL withdrawn from the position back to wallet)
//   - final_base_tokens    (base tokens returned to wallet)
//   - fees_sol, fees_base  (auto-claimed fees, when the close includes them)
// USD valuations come from Jupiter price API at the close block time.
//
// Best-effort: returns null for any field that can't be derived. Caller
// decides what to do with partial reconstructions.

import { PublicKey } from "@solana/web3.js";
import { getPrimaryConnection } from "../utils/rpc-pool.js";
import { log } from "../logger.js";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const SCAN_LIMIT = 50;          // recent wallet transactions to scan
const CONFIRMATIONS = "confirmed";
const PRICE_CACHE = new Map(); // mint → { usdPrice, fetchedAt }
const PRICE_TTL_MS = 5 * 60_000;

/**
 * Look up a token's USD price at a specific timestamp. We use Jupiter's
 * price API for current prices; for historical we fall back to "current
 * price" and accept the error margin — Jupiter's free tier doesn't expose
 * a clean historical endpoint.
 *
 * @param {string} mint
 * @returns {Promise<number|null>}
 */
async function fetchUsdPrice(mint) {
  if (!mint) return null;
  const cached = PRICE_CACHE.get(mint);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) {
    return cached.usdPrice;
  }
  try {
    const url = `${JUPITER_PRICE_API}?ids=${encodeURIComponent(mint)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    // v3 wraps response as { data: { <mint>: { usdPrice } } }
    const entry = data?.data?.[mint] || data?.[mint];
    const price = entry?.usdPrice != null ? Number(entry.usdPrice) : null;
    if (Number.isFinite(price)) {
      PRICE_CACHE.set(mint, { usdPrice: price, fetchedAt: Date.now() });
    }
    return price;
  } catch {
    return null;
  }
}

/**
 * Scan the wallet's recent transactions for one that touches the position
 * address. Returns the parsed transaction or null.
 *
 * @param {string} walletAddress
 * @param {string} positionAddress
 * @returns {Promise<{signature: string, blockTime: number|null, parsed: object}|null>}
 */
async function findCloseTransaction(walletAddress, positionAddress) {
  if (!walletAddress || !positionAddress) return null;
  const conn = getPrimaryConnection();
  let sigs;
  try {
    sigs = await conn.getSignaturesForAddress(new PublicKey(walletAddress), { limit: SCAN_LIMIT });
  } catch (e) {
    log("rpc_warn", `getSignaturesForAddress failed: ${e.message}`);
    return null;
  }
  if (!sigs?.length) return null;

  const posKey = String(positionAddress);
  for (const s of sigs) {
    // Fast filter — Meteora close txs always reference the position in the
    // signature list of any of their instructions. We could parse the full
    // tx to be sure, but if `s.signature` is in the tx we know it's our
    // wallet's tx. The presence check below catches the rest.
    let parsed;
    try {
      parsed = await conn.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: CONFIRMATIONS,
      });
    } catch {
      continue;
    }
    if (!parsed?.transaction?.message?.accountKeys) continue;

    const keys = parsed.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey?.toString?.() || String(k)
    );
    if (!keys.includes(posKey)) continue;

    return {
      signature: s.signature,
      blockTime: parsed.blockTime ?? s.blockTime ?? null,
      parsed,
    };
  }
  return null;
}

/**
 * Extract SOL and SPL token balance deltas attributable to the wallet.
 *
 * @param {object} parsed  result of getParsedTransaction
 * @param {string} walletAddress
 * @returns {{solDelta: number, tokenDeltas: Array<{mint: string, uiAmount: number}>}}
 */
function extractBalanceDeltas(parsed, walletAddress) {
  const walletKey = String(walletAddress);
  const meta = parsed?.meta;
  if (!meta) return { solDelta: 0, tokenDeltas: [] };

  // SOL delta: preBalance - postBalance (positive = wallet received SOL)
  const pre = meta.preBalances || [];
  const post = meta.postBalances || [];
  const keys = parsed.transaction.message.accountKeys;
  let walletIdx = -1;
  for (let i = 0; i < keys.length; i++) {
    const k = typeof keys[i] === "string" ? keys[i] : keys[i].pubkey?.toString?.();
    if (k === walletKey) { walletIdx = i; break; }
  }
  const solDelta = walletIdx >= 0 ? (pre[walletIdx] - post[walletIdx]) / 1e9 : 0;

  // Token deltas: preTokenBalances vs postTokenBalances
  const preTokens = meta.preTokenBalances || [];
  const postTokens = meta.postTokenBalances || [];
  const tokenMap = new Map(); // mint → {pre, post}
  for (const t of preTokens) {
    if (t.owner !== walletKey) continue;
    tokenMap.set(t.mint, { pre: t.uiTokenAmount?.uiAmount ?? 0, post: 0 });
  }
  for (const t of postTokens) {
    if (t.owner !== walletKey) continue;
    const entry = tokenMap.get(t.mint) || { pre: 0, post: 0 };
    entry.post = t.uiTokenAmount?.uiAmount ?? 0;
    tokenMap.set(t.mint, entry);
  }
  const tokenDeltas = [];
  for (const [mint, { pre, post }] of tokenMap.entries()) {
    tokenDeltas.push({ mint, uiAmount: post - pre });
  }

  return { solDelta, tokenDeltas };
}

/**
 * Reconstruct the final USD value of a closed position.
 *
 * Heuristic: when a DLMM position closes, the wallet receives SOL and/or
 * base tokens equal to the position's value. Fees (if auto-claimed) appear
 * as a small excess on top of the principal.
 *
 * For the SOL-denominated side, the wallet's SOL balance can decrease by
 * the position's principal (if fees are paid in SOL) plus tiny amounts
 * for gas. We look at the net change attributable to the position, but
 * only for the specific mints involved (base mint + SOL).
 *
 * Returns:
 *   {
 *     found: boolean,
 *     closed_at: ISO string or null,
 *     final_sol: number,           // SOL returned to wallet (positive)
 *     final_base_tokens: number,   // base tokens returned (positive)
 *     final_value_usd: number,     // combined USD at close time
 *     fees_sol: number,            // fee portion of SOL delta (best-effort)
 *     fees_base_tokens: number,
 *     fees_earned_usd: number,     // fee portion in USD
 *     signature: string,           // close tx signature
 *   }
 */
export async function reconstructClosedPosition({
  position_address,
  wallet_address,
  base_mint,
  initial_value_usd = null,  // if known (from state.json)
}) {
  if (!position_address || !wallet_address) return { found: false, reason: "missing_addresses" };

  const close = await findCloseTransaction(wallet_address, position_address);
  if (!close) return { found: false, reason: "close_tx_not_found_in_recent_window" };

  const { solDelta, tokenDeltas } = extractBalanceDeltas(close.parsed, wallet_address);

  // Identify base-token delta. We treat positive base-token amounts as
  // "value returned to wallet". Negative would be unusual (could happen
  // if the user pre-swapped or sent tokens out during the same tx).
  let baseDelta = 0;
  if (base_mint) {
    const entry = tokenDeltas.find((t) => t.mint === base_mint);
    baseDelta = entry?.uiAmount || 0;
  }

  // SOL delta: positive means wallet received SOL (from position close
  // + auto-claimed SOL fees). We treat the entire positive SOL delta as
  // "value returned" because we can't reliably split principal from fees
  // without the original position's pre-close balance.
  const solDeltaPositive = solDelta > 0 ? solDelta : 0;

  // Fetch prices
  const [solPriceUsd, basePriceUsd] = await Promise.all([
    fetchUsdPrice("So11111111111111111111111111111111111111112"),
    base_mint ? fetchUsdPrice(base_mint) : Promise.resolve(null),
  ]);

  const solUsd = solDeltaPositive * (solPriceUsd || 0);
  const baseUsd = baseDelta * (basePriceUsd || 0);
  const finalValueUsd = solUsd + baseUsd;

  // Best-effort fee estimate: the excess over initial_value_usd. If we
  // know initial_value_usd, anything above it is fees (capped at a sane
  // multiple to avoid mistaking a price move for fees).
  let feesEarnedUsd = 0;
  if (initial_value_usd != null && initial_value_usd > 0 && finalValueUsd > initial_value_usd) {
    const excess = finalValueUsd - initial_value_usd;
    // Cap at 50% of initial — anything beyond that is more likely price
    // movement than fees. Caller can refine.
    feesEarnedUsd = Math.min(excess, initial_value_usd * 0.5);
  }

  return {
    found: true,
    closed_at: close.blockTime ? new Date(close.blockTime * 1000).toISOString() : null,
    signature: close.signature,
    final_sol: solDeltaPositive,
    final_base_tokens: baseDelta,
    final_value_usd: Math.round(finalValueUsd * 100) / 100,
    fees_earned_usd: Math.round(feesEarnedUsd * 100) / 100,
    prices: {
      sol_usd: solPriceUsd,
      base_usd: basePriceUsd,
    },
  };
}

/**
 * Best-effort merge of reconstruction data with whatever cached values
 * the caller already has. Cached values win when they're finite AND not
 * null/undefined; RPC reconstruction fills the gaps. Explicit zeros in
 * cached (e.g. fees_earned_usd: 0) are preserved over RPC's value.
 */
export function mergeWithCache(cached = {}, rpc = {}) {
  // "present" means a finite number that isn't null/undefined. Zeros
  // count as present — the caller knows the position earned no fees.
  const present = (v) => v != null && Number.isFinite(Number(v));
  return {
    initial_value_usd:  present(cached.initial_value_usd) ? Number(cached.initial_value_usd) : null,
    final_value_usd:    present(cached.final_value_usd)   ? Number(cached.final_value_usd)   : (present(rpc.final_value_usd)   ? Number(rpc.final_value_usd)   : 0),
    fees_earned_usd:    present(cached.fees_earned_usd)   ? Number(cached.fees_earned_usd)   : (present(rpc.fees_earned_usd)   ? Number(rpc.fees_earned_usd)   : 0),
    closed_at:          cached.closed_at || rpc.closed_at || null,
    signature:          rpc.signature || null,
  };
}