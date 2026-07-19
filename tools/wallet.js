import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

import { getConnection, getConnections } from "../utils/rpc-pool.js";

let _wallet = null;
let _lastSolPrice = 0;

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";
const JUPITER_ASSET_SEARCH = "https://datapi.jup.ag/v1/assets/search";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function fetchHeliusWalletBalancesWithFailover({ walletAddress, keys, fetchFn = fetch, maxAttempts = 3 }) {
  const candidates = [...new Set((keys || []).map((key) => String(key).trim()).filter(Boolean))];
  const attempts = Math.min(candidates.length, Math.max(1, maxAttempts));
  let lastError = null;
  for (let index = 0; index < attempts; index++) {
    const key = candidates[index];
    try {
      const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${key}`;
      const res = await fetchFn(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
      return { data: await res.json(), attempts: index + 1, error: null };
    } catch (error) {
      lastError = error;
    }
  }
  return { data: null, attempts, error: lastError?.message || "Helius wallet API unavailable" };
}

async function fetchFallbackSolPrice(fetchFn = fetch) {
  if (_lastSolPrice > 0) return _lastSolPrice;
  try {
    const res = await fetchFn(`${JUPITER_ASSET_SEARCH}?query=${config.tokens.SOL}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return 0;
    const assets = await res.json();
    const sol = (Array.isArray(assets) ? assets : [assets]).find((asset) => asset?.id === config.tokens.SOL) || assets?.[0];
    const price = Number(sol?.usdPrice);
    if (Number.isFinite(price) && price > 0) _lastSolPrice = price;
    return _lastSolPrice;
  } catch {
    return 0;
  }
}

async function fetchRpcSolBalance(publicKey, connections = null) {
  let lastError = null;
  let pool;
  try {
    pool = connections || getConnections();
  } catch (error) {
    return { sol: null, error: error.message };
  }
  for (const connection of pool) {
    try {
      const lamports = await connection.getBalance(publicKey, "confirmed");
      return { sol: lamports / LAMPORTS_PER_SOL, error: null };
    } catch (error) {
      lastError = error;
    }
  }
  return { sol: null, error: lastError?.message || "RPC balance lookup failed" };
}

export async function getWalletBalances({ fetchFn = fetch, connections = null } = {}) {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  // Support HELIUS_API_KEYS or comma-separated HELIUS_API_KEY. Try multiple
  // keys before degrading because 429s can be key-specific.
  const rawKey = process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY;
  const keys = rawKey ? rawKey.split(",").map((s) => s.trim()).filter(Boolean) : [];

  try {
    const helius = await fetchHeliusWalletBalancesWithFailover({ walletAddress, keys, fetchFn });
    if (!helius.data) throw new Error(helius.error || "Helius wallet API unavailable");
    const data = helius.data;
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    if (solPrice > 0) _lastSolPrice = solPrice;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    // The Wallet API is an enrichment convenience, not the source of truth
    // for native SOL. Fall back to JSON-RPC and a cached/public SOL price so a
    // transient Helius gateway error does not cancel the whole screening cycle.
    const rpc = await fetchRpcSolBalance(getWallet().publicKey, connections);
    const solPrice = await fetchFallbackSolPrice(fetchFn);
    if (Number.isFinite(rpc.sol) && rpc.sol >= 0 && solPrice > 0) {
      const sol = Math.round(rpc.sol * 1e6) / 1e6;
      const solUsd = Math.round(sol * solPrice * 100) / 100;
      log("wallet_warn", `Helius wallet API unavailable; using RPC SOL balance fallback after: ${error.message}`);
      return {
        wallet: walletAddress,
        sol,
        sol_price: Math.round(solPrice * 100) / 100,
        sol_usd: solUsd,
        usdc: 0,
        tokens: [],
        total_usd: solUsd,
        degraded: true,
        source: "rpc+jupiter",
      };
    }
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: `${error.message}; fallback failed: ${rpc.error || "SOL price unavailable"}`,
    };
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
