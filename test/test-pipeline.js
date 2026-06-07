#!/usr/bin/env node
/**
 * Full pipeline diagnostic — tests every stage of management + screening
 * cycles independently with timing. Run locally:
 *
 *   node test/test-pipeline.js
 *
 * Requires: .env with WALLET_PRIVATE_KEY, RPC keys, etc.
 */

import { config } from "../config.js";

// ─── Helpers ──────────────────────────────────────────────────────

let stageNum = 0;
async function timed(label, fn) {
  stageNum++;
  const tag = `[${stageNum}] ${label}`;
  const t0 = Date.now();
  try {
    process.stdout.write(`${tag} ... `);
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT (30s)")), 30_000)),
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

// ═══════════════════════════════════════════════════════════════
//  PHASE 1: MANAGEMENT CYCLE
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ MANAGEMENT CYCLE ══════\n");

const { getMyPositions, getWalletPositions } = await import("../tools/dlmm.js");
const { getWalletBalances } = await import("../tools/wallet.js");

// 1. getWalletBalances
const balance = await timed("getWalletBalances()", () => getWalletBalances());
console.log(`    balance: ${balance?.sol ?? "?"} SOL`);

// 2. getMyPositions — the big one that can hang
const positions = await timed("getMyPositions({ force: true })", () =>
  getMyPositions({ force: true })
);
console.log(`    positions: ${positions?.total_positions ?? 0} open`);
if (positions?.positions?.length) {
  for (const p of positions.positions) {
    console.log(`      - ${p.pair} | val=$${p.total_value_usd ?? "?"} | pnl=${p.pnl_pct ?? "?"}% | in_range=${p.in_range}`);
  }
}

// 3. Pool memory + snapshots (what management does after getting positions)
const { recordPositionSnapshot, recallForPool } = await import("../pool-memory.js");
if (positions?.positions?.length) {
  const mem = timed("recordPositionSnapshot() per position", async () => {
    for (const p of positions.positions) {
      recordPositionSnapshot(p.pool, p);
    }
  });
  await mem;

  const recall = timed("recallForPool() per position", async () => {
    for (const p of positions.positions) {
      const r = recallForPool(p.pool);
      console.log(`    ${p.pair} memory: ${r?.slice(0, 80) ?? "(empty)"}...`);
    }
  });
  await recall;
}

// 4. Trailing TP checks
const { updatePnlAndCheckExits, getTrackedPositions } = await import("../state.js");
const trailResult = timed("updatePnlAndCheckExits() per position", async () => {
  if (!positions?.positions?.length) return null;
  const results = [];
  for (const p of positions.positions) {
    const exit = updatePnlAndCheckExits(p.position, p, config.management);
    results.push({ pair: p.pair, exit });
    console.log(`    ${p.pair}: exit=${exit ? exit.action : "none"}`);
  }
  return results;
});
await trailResult;

// 5. Deterministic close rules
const { getDeterministicCloseRule } = await import("../state.js");
const rules = timed("getDeterministicCloseRule() per position", async () => {
  if (!positions?.positions?.length) return null;
  for (const p of positions.positions) {
    const rule = getDeterministicCloseRule(p, config.management);
    console.log(`    ${p.pair}: rule=${rule ? `Rule ${rule.rule} (${rule.reason})` : "none"}`);
  }
});
await rules;

// 6. Report formatting
const { formatManagementReport } = await import("../utils/telegram-formatter.js");
const fmtResult = timed("formatManagementReport()", () => {
  if (!positions?.positions?.length) return null;
  const reportLines = positions.positions.map(p =>
    `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: $${p.total_value_usd ?? "?"} | PnL: ${p.pnl_pct ?? "?"}%`
  );
  const report = reportLines.join("\n") + `\n\nSummary: 💼 ${positions.positions.length} positions`;
  const { text } = formatManagementReport(report, positions.positions);
  console.log(`    report length: ${text?.length ?? 0} chars`);
  return text;
});
await fmtResult;


// ═══════════════════════════════════════════════════════════════
//  PHASE 2: SCREENING CYCLE
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ SCREENING CYCLE ══════\n");

// 1. getTopCandidates — the heavy one
const { getTopCandidates } = await import("../tools/screening.js");
const candidates = await timed("getTopCandidates({ limit: 10 })", () =>
  getTopCandidates({ limit: 10 })
);
const pools = candidates?.candidates || candidates?.pools || [];
console.log(`    pools found: ${pools.length}`);
if (pools.length > 0) {
  for (const p of pools.slice(0, 3)) {
    console.log(`      - ${p.name} (${p.pool?.slice(0, 12)}...) tvl=$${p.tvl ?? "?"} fee/tvl=${p.fee_active_tvl_ratio ?? "?"}`);
  }
}

// 2. Enrichment (smart wallets, token info, narrative, study)
const { checkSmartWalletsOnPool } = await import("../smart-wallets.js");
const { getTokenNarrative, getTokenInfo } = await import("../tools/token.js");

if (pools.length > 0) {
  const testPool = pools[0];
  const mint = testPool.base?.mint;

  console.log(`\n  Testing enrichment for: ${testPool.name} (${mint?.slice(0, 8)}...)`);

  await timed("checkSmartWalletsOnPool()", () =>
    checkSmartWalletsOnPool({ pool_address: testPool.pool })
  );

  await timed("getTokenNarrative()", () =>
    mint ? getTokenNarrative({ mint }) : Promise.resolve(null)
  );

  await timed("getTokenInfo()", () =>
    mint ? getTokenInfo({ query: mint }) : Promise.resolve(null)
  );
}

// 3. Pool detail fetch
const { fetchFreshPoolDetail } = await import("../tools/executor.js").catch(() => ({ fetchFreshPoolDetail: null }));
if (pools.length > 0) {
  const testPool = pools[0];
  console.log(`\n  Pool detail for: ${testPool.name}`);
  try {
    const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
    const detail = await timed("Pool Discovery API (fetchFreshPoolDetail equiv)", async () => {
      const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=pool_address=${testPool.pool}&timeframe=${config.screening?.timeframe || "5m"}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data?.data || [])[0] ?? null;
    });
    if (detail) {
      console.log(`    tvl=$${detail.tvl ?? "?"} volume=$${detail.volume ?? "?"} fee_tvl=${detail.fee_active_tvl_ratio ?? "?"} volatility=${detail.volatility ?? "?"}`);
    }
  } catch (e) {
    console.log(`    pool detail failed: ${e.message}`);
  }
}

// 4. Active bin
const { getActiveBin } = await import("../tools/dlmm.js");
if (pools.length > 0) {
  await timed("getActiveBin()", () =>
    getActiveBin({ pool_address: pools[0].pool })
  );
}


// ═══════════════════════════════════════════════════════════════
//  PHASE 3: EXTERNAL API LATENCY
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ EXTERNAL API LATENCY ══════\n");

const wallet = "9qGKjN8ZQqPpDuGTLpa77K5xRe2UMw4c7m9348XpyCRf";

await timed("Meteora Portfolio API", async () => {
  const res = await fetch(`https://dlmm.datapi.meteora.ag/portfolio/open?user=${wallet}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});

await timed("Meteora PnL API (first pool if available)", async () => {
  const poolAddr = positions?.positions?.[0]?.pool || "2C1XgnTarjmMNZpup44BL3rjsuWLPgsF3pHjzwRiXthS";
  const res = await fetch(`https://dlmm.datapi.meteora.ag/positions/${poolAddr}/pnl?user=${wallet}&status=open&pageSize=100&page=1`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});

await timed("Pool Discovery API", async () => {
  const url = `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=pool_address=2C1XgnTarjmMNZpup44BL3rjsuWLPgsF3pHjzwRiXthS&timeframe=5m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});

await timed("LPAgent API (if configured)", async () => {
  const key = process.env.LPAGENT_API_KEY;
  if (!key) { console.log("\n    (skipped — no LPAGENT_API_KEY)"); return null; }
  const res = await fetch(`https://dlmm.agentmeridian.xyz/api/lp-positions/opening?owner=${wallet}`, {
    headers: { "x-api-key": key },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});

await timed("Agent Meridian relay (if configured)", async () => {
  const key = process.env.PUBLIC_API_KEY;
  if (!key) { console.log("\n    (skipped — no PUBLIC_API_KEY)"); return null; }
  const { agentMeridianJson, getAgentMeridianHeaders, getAgentIdForRequests } = await import("../tools/agent-meridian.js").catch(() => ({}));
  if (!agentMeridianJson) { console.log("\n    (skipped — module not found)"); return null; }
  const search = new URLSearchParams({ owner: wallet, agentId: getAgentIdForRequests?.() || "test" });
  return agentMeridianJson(`/positions/open/raw?${search}`, { headers: getAgentMeridianHeaders?.() });
});


// ═══════════════════════════════════════════════════════════════
//  PHASE 4: LLM
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ LLM ══════\n");

await timed("LLM health check (single call)", async () => {
  const { agentLoop } = await import("../agent.js");
  const model = config.llm.generalModel;
  console.log(`\n    model: ${model}`);
  const { content } = await agentLoop("Reply with OK", 1, [], "GENERAL", model, 10);
  console.log(`    response: ${content?.slice(0, 80) ?? "(empty)"}`);
  return content;
});


// ═══════════════════════════════════════════════════════════════
//  SUMMARY
// ═══════════════════════════════════════════════════════════════

console.log("\n══════ DONE ══════");
console.log("If any stage showed TIMEOUT or >5s, that's the bottleneck.\n");
process.exit(0);
