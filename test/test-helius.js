#!/usr/bin/env node
/**
 * Helius RPC pressure diagnostic
 *
 * Tests each Helius call site independently with timing,
 * then tests them concurrently to see which ones bottleneck.
 *
 *   node test/test-helius.js
 */

import "../envcrypt.js";

// ═══════════════════════════════════════════════════════════════
//  PHASE 1: Individual call sites
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ INDIVIDUAL HELIUS CALLS ══════\n");

let stage = 0;
async function timed(label, fn) {
  stage++;
  const tag = `[${stage}] ${label}`;
  const t0 = Date.now();
  try {
    process.stdout.write(`${tag} ... `);
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT (15s)")), 15_000)),
    ]);
    const ms = Date.now() - t0;
    console.log(`✓ ${ms}ms`);
    return result;
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`✗ ${ms}ms — ${e.message}`);
    return null;
  }
}

import { getConnection, getPrimaryConnection, getConnections, resetPool } from "../utils/rpc-pool.js";
import { PublicKey } from "@solana/web3.js";

const poolCount = getConnections().length;
console.log(`HELIUS_API_KEYS configured: ${poolCount} key(s)\n`);

// Use a known pool and position for testing
const KNOWN_POOL = new PublicKey("2C1XgnTarjmMNZpup44BL3rjsuWLPgsF3pHjzwRiXthS");
const KNOWN_POSITION = new PublicKey("2mRkYUwNNuv1Nodie5y7MNjS5B89FAXWXHPzGqPBFzor");

// 1. Basic getAccountInfo (our new close guard calls this)
await timed("getAccountInfo (position, primary key)", async () => {
  const info = await getPrimaryConnection().getAccountInfo(KNOWN_POSITION);
  return !!info;
});

// 2. getMultipleAccountsInfo (deploy bin array check)
const BIN_KEYS = [KNOWN_POOL, KNOWN_POSITION]; // dummy keys — just testing latency
await timed("getMultipleAccountsInfo (2 keys, round-robin)", async () => {
  const accounts = await getConnection().getMultipleAccountsInfo(BIN_KEYS, "confirmed");
  return accounts.length;
});

// 3. getParsedAccountInfo (mint lookup on deploy)
await timed("getParsedAccountInfo (mint, round-robin)", async () => {
  const info = await getConnection().getParsedAccountInfo(KNOWN_POOL);
  return !!info;
});

// 4. simulateTransaction (deploy pre-flight) — skipped, needs a real tx
console.log(`[${stage+1}] simulateTransaction ... (skipped — needs real tx)`);
stage++;

// 5. DLMM.create() — the heavy one
let dlmm;
try {
  await timed("DLMM.create() (round-robin)", async () => {
    const { default: { default: DLMM } } = await import("@meteora-ag/dlmm");
    const pool = await DLMM.create(getConnection(), KNOWN_POOL);
    dlmm = pool;
    return !!pool;
  });
} catch (e) {
  console.log(`    DLMM import failed: ${e.message}`);
}

// 6. getActiveBin (SDK call, uses DLMM.create under the hood)
if (dlmm) {
  await timed("pool.getActiveBin()", async () => {
    const bin = await dlmm.getActiveBin();
    return bin?.binId;
  });
}

// 7. getProgramAccounts (position scan)
await timed("getProgramAccounts (DLMM positions, round-robin)", async () => {
  const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
    filters: [
      { memcmp: { offset: 0, bytes: KNOWN_POSITION.toBase58() } },
    ],
  });
  return accounts.length;
});

// 8. simulateTransaction — test with a simple transfer simulation
await timed("simulateTransaction (dummy, primary key)", async () => {
  const { Transaction, SystemProgram } = await import("@solana/web3.js");
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: KNOWN_POSITION,
        toPubkey: KNOWN_POOL,
        lamports: 1,
      })
    );
    // This should fail with "attempt to debit an account not owned by wallet"
    // — we just want to measure the RPC latency
    await getPrimaryConnection().simulateTransaction(tx, { sigVerify: false });
  } catch (e) {
    // Expected failure — we're measuring latency, not success
    return e.message?.includes("debit") || e.message?.includes("AccountNotFound") ? "latency captured" : e.message.slice(0, 80);
  }
});


// ═══════════════════════════════════════════════════════════════
//  PHASE 2: Smart wallet RPC pressure
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ SMART WALLET RPC PRESSURE ══════\n");

const { checkSmartWalletsOnPool } = await import("../smart-wallets.js");

// Test with current wallet list
await timed(`checkSmartWalletsOnPool()`, async () => {
  const result = await checkSmartWalletsOnPool({ pool_address: KNOWN_POOL.toBase58() });
  console.log(`\n    wallets tracked: ${result?.tracked_wallets ?? 0}`);
  console.log(`    in pool: ${result?.in_pool?.length ?? 0}`);
  console.log(`    signal: ${result?.signal?.slice(0, 120) ?? "none"}`);
  return result;
});


// ═══════════════════════════════════════════════════════════════
//  PHASE 3: Concurrent pressure test
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ CONCURRENT PRESSURE ══════\n");

// Simulate what happens when screening + management overlap:
// - Smart wallets check (25 wallets × 3 concurrent = ~9 batches)
// - DLMM.create for a pool
// - getMultipleAccountsInfo for bin array
// - 30s poller calls getMyPositions

await timed("Concurrent: smart wallets + DLMM.create + getAccountInfo", async () => {
  const results = await Promise.allSettled([
    checkSmartWalletsOnPool({ pool_address: KNOWN_POOL.toBase58() }),
    (async () => {
      try {
        const { default: { default: DLMM } } = await import("@meteora-ag/dlmm");
        return DLMM.create(getConnection(), KNOWN_POOL);
      } catch { return null; }
    })(),
    (async () => {
      const info = await getConnection().getAccountInfo(KNOWN_POSITION);
      return !!info;
    })(),
    (async () => {
      const info = await getConnection().getMultipleAccountsInfo(BIN_KEYS, "confirmed");
      return info.length;
    })(),
  ]);

  const ok = results.filter(r => r.status === "fulfilled").length;
  const fail = results.filter(r => r.status === "rejected").length;
  console.log(`\n    ${ok} passed, ${fail} failed (total 4 concurrent)`);
  return results;
});


// ═══════════════════════════════════════════════════════════════
//  PHASE 4: Key distribution test
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ KEY DISTRIBUTION ══════\n");

if (poolCount > 1) {
  console.log(`Testing round-robin distribution across ${poolCount} keys:\n`);

  // Make 6 rapid calls and see which URL each lands on
  for (let i = 0; i < 6; i++) {
    const conn = getConnection();
    console.log(`  call ${i + 1}: ${conn.rpcEndpoint.replace(/\?api-key=.*/, "?api-key=***")}`);
  }

  console.log(`\n  primary key: ${getPrimaryConnection().rpcEndpoint.replace(/\?api-key=.*/, "?api-key=***")}`);
} else {
  console.log("Only 1 Helius key configured — no distribution benefit.\n");
  console.log("To improve: set HELIUS_API_KEYS=key1,key2,key3 in .env");
}


// ═══════════════════════════════════════════════════════════════
//  PHASE 5: Bot tracker RPC check
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ BOT TRACKER ══════\n");

const BOTS = (process.env.BOT_WALLETS || "3QUnrcMqCQoiGB73s1A6uDzxziywaNFpTLiZiiZbEUoN,NA247a7YE9S3p9CdKmMyETx8TTwbSdVbVYHHxpnHTUV,joeHSutRWndCtp1EPx5tz5zH5yaPBZUZ5JsxDEVB1RPZ,MEViEnscUm6tsQRoGd9h6nLQaQspKj7DB2M5FwM3Xvz")
  .split(",").map(a => a.trim());

const rawKey = process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || process.env.HELIUS_KEY || "";
const H_KEY = rawKey.split(",")[0].trim();
const H_HTTP = `https://mainnet.helius-rpc.com/?api-key=${H_KEY}`;

console.log(`Bot tracker uses first Helius key: ${H_HTTP.replace(H_KEY, "***")}`);
console.log(`Tracked wallets: ${BOTS.length}`);
console.log(`Poll interval: 10s | Signature limit: 25`);

// Test a single getSignaturesForAddress call
await timed(`getSignaturesForAddress (bot wallet ${BOTS[0].slice(0, 4)}...)`, async () => {
  const r = await fetch(H_HTTP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "getSignaturesForAddress",
      params: [BOTS[0], { limit: 5 }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j?.result?.length ?? 0;
});


console.log("\n══════ SUMMARY ══════\n");
console.log(`Total Helius keys: ${poolCount}`);
console.log(`Round-robin: reads spread across all keys`);
console.log(`Primary key: used for transactions only`);
console.log(`Smart wallets: ${poolCount > 1 ? "uses round-robin (all keys)" : "single key pressure"}`);
console.log(`Bot tracker: always uses first key (hardcoded H_KEY)`);

// Recommendations
if (poolCount < 3) {
  console.log(`\n⚠️  Recommendation: Add more Helius keys. Current: ${poolCount}. Target: 3+`);
}
console.log("");
process.exit(0);
