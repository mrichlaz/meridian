// Test the Telegram close notification on a deployed environment.
// Run this on your /app container where TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID are set.
//
// Usage: docker exec -it meridian node test_notify_deploy.mjs
//    or:  cd /app && node test_notify_deploy.mjs

// Load the actual telegram module
const telegram = await import("./telegram.js");

console.log("=== Telegram env check ===");
console.log("Bot token set:", !!process.env.TELEGRAM_BOT_TOKEN);
console.log("Chat ID set: ", !!process.env.TELEGRAM_CHAT_ID);

// Test 1: Plain notifyClose with fake data
console.log("\n=== Test 1: notifyClose with fake data ===");
try {
  await telegram.notifyClose({
    pair: "TEST-CLOSE/SOL",
    pnlUsd: 0.35,
    pnlPct: 0.14,
    reason: "test notification from test_notify_deploy.mjs",
  });
  console.log("✓ notifyClose returned (check Telegram for the 🔒 Closed message)");
} catch (e) {
  console.error("✗ notifyClose threw:", e.message);
}

// Test 2: notifySwap with fake data
console.log("\n=== Test 2: notifySwap with fake data ===");
try {
  await telegram.notifySwap({
    inputSymbol: "TEST",
    outputSymbol: "SOL",
    amountIn: 100.5,
    amountOut: 0.5,
    tx: "4H3SudjAvnXm9QVcSeGVhefe6VqY2icWmuR69dsSQE8UnQCwfXGMbqXNnJGNkd4bSWEZvgnY44gurCHFc2Sg79rL",
  });
  console.log("✓ notifySwap returned (check Telegram for the 🔄 Swapped message)");
} catch (e) {
  console.error("✗ notifySwap threw:", e.message);
}

// Test 3: Simulate the full close flow through executeTool
console.log("\n=== Test 3: Full close flow through executeTool ===");
try {
  const { executeTool } = await import("./tools/executor.js");
  const result = await executeTool("close_position", {
    position_address: "4H3SudjAvnXm9QVcSeGVhefe6VqY2icWmuR69dsSQE8UnQCwfXGMbqXNnJGNkd4bSWEZvgnY44gurCHFc2Sg79rL",
    reason: "test",
  });
  console.log("Result:", JSON.stringify(result, null, 2).slice(0, 500));
} catch (e) {
  console.error("✗ executeTool failed:", e.message);
}

console.log("\n=== Done — check your Telegram! ===");
process.exit(0);
