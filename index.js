import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { normalizeMint } from "./tools/wallet.js";
import { getTopCandidates, chooseAdaptiveDeployProfile } from "./tools/screening.js";
import { formatGmgnCandidateForPrompt } from "./tools/gmgn.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { checkCircuitBreaker, getMarketRegime, rankCandidates, sizeMultiplierForScore, scoreCandidate } from "./policy-engine.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, updatePnlAndCheckExits, effectiveLossPnlPct, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { logScreeningSnapshot, summarizeScreeningSnapshots, readScreeningSnapshots } from "./screening-snapshot.js";
import { isRangeDriftAccelerating, isRecoveryImproving, isFeeGrowthDecelerating, isFeeGrowthAccelerating, assessTrend } from "./utils/position-trend.js";
import { startBotTracker } from "./tools/bot-tracker.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { studyTopLPers } from "./tools/study.js";
import { stageSignals, stageMlFeatures } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import {
  formatScreeningReport,
  formatManagementReport,
  formatWalletStatus,
  formatPositionCard,
  formatPositionPnLCard,
  formatCandidatesList,
  formatPoolDetail,
  formatBalance,
  formatConfigSnapshot as formatConfigSnapshotCard,
  formatThresholds,
  formatLessons,
  formatPerformance,
  formatError,
  formatHelp,
  formatStart,
  formatDeployResult,
  formatCloseResult,
  formatClaimResult,
  formatCandidatesListPlain,
  formatConfigSnapshotPlain,
  formatThresholdsPlain,
  formatLessonsPlain,
  formatPerformancePlain,
  liveStage,
} from "./utils/telegram-formatter.js";
import { setRuntimeMode as setRuntimeModeUtil, RUNTIME_MODES, safeSetInterval, safeSetTimeout, isCli, isTelegram } from "./utils/runtime-mode.js";

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const isMain = entrypointPath
  ? path.resolve(entrypointPath) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  // Resolve runtime mode (repl / telegram / daemon) — overrides only
  // if it wasn't already set explicitly via env or setRuntimeMode.
  if (!process.env.MERIDIAN_RUNTIME_MODE) {
    if (process.env.TELEGRAM_BOT_TOKEN) {
      setRuntimeModeUtil(RUNTIME_MODES.TELEGRAM);
    } else if (process.stdin && process.stdin.isTTY) {
      setRuntimeModeUtil(RUNTIME_MODES.REPL);
    } else {
      setRuntimeModeUtil(RUNTIME_MODES.DAEMON);
    }
  }

  log("startup", "DLMM LP Agent starting...");
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  log("startup", `Runtime mode: ${process.env.MERIDIAN_RUNTIME_MODE}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  ensureAgentId();
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();
  startBotTracker();
}

// Use a fresh read every time — config evolves during runtime.
function getDeployAmount() { return config.management.deployAmountSol; }

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _studyFailStreak = 0;    // consecutive LP-study timeouts across candidates
let _studySkipUntil = 0;     // epoch ms — circuit breaker: skip LP studies until then
let _pnlPollCalmSkips = 0;   // ticks to skip while all positions are calm (CPU saver)
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management
let _pnlPollBusy = false;   // module-level so runWalletSweepOnce can read it
let _sweepBusy = false;     // module-level so runWalletSweepOnce can read/write it
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;
// Poll-triggered management cooldown for loss-cutting exits (stop loss /
// below range). Normal alerts wait a full management interval; emergencies
// only wait long enough to avoid hammering the RPC during one dump.
const EMERGENCY_POLL_COOLDOWN_MS = 90_000;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function shouldUsePnlRecheck() {
  return !config.api.lpAgentRelayEnabled;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: false, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct_derived ?? position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct_derived ?? position?.pnl_pct ?? null,
        config.management,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) {
    if (task && typeof task.stop === "function") task.stop();
  }
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._sweepInterval) clearInterval(_cronTasks._sweepInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false, triggerScreening = true } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      if (triggerScreening) {
        runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      }
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (
        !p.pnl_pct_suspicious &&
        // Record peaks from the same fresh mark the trailing-drop check uses
        // (derived preferred) so peak and current are on one scale.
        queuePeakConfirmation(p.position, p.pnl_pct_derived ?? p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
        shouldUsePnlRecheck()
      ) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management)) {
            scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN RANGE" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = `$${p.total_value_usd ?? "?"}`;
      const unclaimed = `$${p.unclaimed_fees_usd ?? "?"}`;
      const bins = p.lower_bin != null ? `${p.lower_bin} → ${p.upper_bin}` : "?";
      const active = p.active_bin != null ? `active=${p.active_bin}` : "";
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      const shortPool = (p.pool || "").slice(0, 12);
      const shortPos = (p.position || "").slice(0, 12);

      let line = [
        `**${p.pair}**  ${inRange}  ${statusLabel}`,
        `Pool: \`${shortPool}...\`  Pos: \`${shortPos}...\``,
        `Bins: ${bins}  ${active}  |  Age: ${p.age_minutes ?? "?"}m`,
        `Value: ${val}  |  PnL: ${p.pnl_pct ?? "?"}%  |  Fees: ${unclaimed}  |  Yield: ${p.fee_per_tvl_24h ?? "?"}%`,
      ].join("\n");
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    // 1. Handle Immediate Actions (CLOSE/CLAIM) - NO LLM REQUIRED
    const immediateActions = actionPositions.filter(p => {
      const a = actionMap.get(p.position);
      return a.action === "CLOSE" || a.action === "CLAIM";
    });

    for (const p of immediateActions) {
      const act = actionMap.get(p.position);
      log("cron", `Management: Executing immediate ${act.action} for ${p.pair} (${act.reason || ""})`);
      
      const toolName = act.action === "CLOSE" ? "close_position" : "claim_fees";
      // FIX: Use position_address to match executor expectations
      const result = await executeTool(toolName, { position_address: p.position });

      if (result?.success && !result.already_closed) {
        log("cron", `Management: Successfully executed ${act.action} for ${p.pair}`);
        if (telegramEnabled()) {
          await sendMessage(`⚡ ${act.action} executed for ${p.pair}\nReason: ${act.reason || "Rule triggered"}`);
        }
      } else if (result?.already_closed) {
        // Position was already closed when the tool ran (on-chain account
        // gone, or local state already marked closed). Don't claim
        // "⚡ CLOSE executed" — but don't stay silent either: if the original
        // close failed after the on-chain part, this is the operator's only
        // signal that the position is gone. Include PnL when the tool has it.
        log("cron", `Management: ${act.action} for ${p.pair} was already closed`);
        if (act.action === "CLOSE" && telegramEnabled()) {
          const pnlStr = result.pnl_pct != null ? ` (PnL ${result.pnl_pct >= 0 ? "+" : ""}${Number(result.pnl_pct).toFixed(2)}%)` : "";
          await sendMessage(`ℹ️ ${p.pair} was already closed${pnlStr}${result.auto_swapped ? " — leftover base token swapped back to SOL" : ""}\nReason: ${act.reason || "rule triggered"}`).catch(() => {});
        }
      } else {
        log("cron_error", `Management: Failed to execute ${act.action} for ${p.pair}: ${result?.error || "Unknown error"}`);
        // A silent close failure is how positions bleed past their stop with
        // zero operator feedback — always surface it.
        if (telegramEnabled()) {
          await sendMessage(`❌ ${act.action} FAILED for ${p.pair}: ${result?.error || "unknown error"}\nReason it was triggered: ${act.reason || "rule"}\nWill retry next cycle.`).catch(() => {});
        }
      }
    }

    // 2. Handle LLM Actions (INSTRUCTION)
    const llmActions = actionPositions.filter(p => {
      const a = actionMap.get(p.position);
      return a.action === "INSTRUCTION";
    });

    if (llmActions.length > 0) {
      log("cron", `Management: ${llmActions.length} instruction(s) pending — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = llmActions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT INSTRUCTION REQUIRED — ${llmActions.length} position(s)

${actionBlocks}

RULES:
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
- After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else if (immediateActions.length === 0) {
      log("cron", "Management: all positions STAY — skipping LLM");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (triggerScreening && afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) {
          await liveMessage.finalize(mgmtReport.slice(0, 4000)).catch(() => {});
        } else {
          await sendMessage(mgmtReport.slice(0, 4000)).catch(() => {});
        }
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    const breaker = checkCircuitBreaker({ positions: prePositions, balance: preBalance });
    if (breaker.blocked) {
      screenReport = `Screening skipped — circuit breaker: ${breaker.reason}.`;
    } else if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
    } else {
      const minRequired = config.management.deployAmountSol + config.management.gasReserve;
      const isDryRun = process.env.DRY_RUN === "true";
      if (!isDryRun && preBalance.sol < minRequired) {
        log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
        screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      }
    }
    if (screenReport) {
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: screenReport,
      });
      if (!silent && telegramEnabled()) {
        await sendMessage(screenReport).catch(() => {});
      }
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    if (!silent && telegramEnabled()) {
      await sendMessage(screenReport).catch(() => {});
    }
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  let deployAttempted = false;
  let deploySucceeded = false;
  let deployPool = null;
  let deployPoolName = null;
  let screeningBalance = preBalance;
  let screeningDeployAmount = 0;
  let passingForFallback = [];
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    screeningBalance = currentBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    screeningDeployAmount = deployAmount;
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

    await liveStage(liveMessage, "fetching");
    // Fetch + enrich + filter candidates via the shared pipeline. This is
    // the same pipeline the manual /screen path uses, so both surfaces
    // (auto cron and manual /deploy N) see the same surviving pool set.
    const pipeline = await enrichAndFilterCandidates({ limit: 10, liveMessage });
    if (pipeline?.error) {
      screenReport = `Screening failed: ${pipeline.error}`;
      return screenReport;
    }
    let { passing, filteredOut, gmgnStageCounts, gmgnAllFiltered, topCandidates, allCandidates } = pipeline;
    const regime = getMarketRegime();
    const rankedPassing = rankCandidates(passing, { regime });
    const policyFiltered = passing.filter((entry) => !rankedPassing.some((ranked) => ranked.pool?.pool === entry.pool?.pool));
    if (policyFiltered.length > 0) {
      filteredOut.push(...policyFiltered.map((entry) => ({
        name: entry.pool?.name || entry.pool?.pool || "unknown",
        reason: `policy score ${entry.policy?.score ?? "below"} below ${regime.minScore} in ${regime.regime}`,
      })));
    }
    passing = rankedPassing;
    if (config.ml?.enabled && passing.length > 0) {
      try {
        const { scoreCandidate: scoreMlCandidate } = await import("./ml/inference.js");
        passing = passing.map((entry) => {
          const ml = scoreMlCandidate({ ...entry.pool, policy: entry.policy }, {
            studyData: entry.study?.patterns || null,
            context: {
              walletSol: currentBalance.sol,
              walletTotalUsd: currentBalance.total_usd,
              activePositions: prePositions.total_positions,
              maxPositions: config.risk.maxPositions,
              deployAmountSol: deployAmount,
              policy: entry.policy,
              flow: entry.policy?.flow,
            },
          });
          const lambda = Number(ml.lambda ?? config.ml?.blendLambdaStart ?? 0.3);
          const finalScore = Math.round(((1 - lambda) * Number(entry.policy.score || 0)) + (lambda * Number(ml.mlScore || 0.5) * 100));
          const verdict = finalScore >= entry.policy.score + 5 ? "boost" : finalScore <= entry.policy.score - 5 ? "penalty" : "neutral";
          return { ...entry, policy: { ...entry.policy, ml, finalScore, mlVerdict: verdict } };
        })
          .filter((entry) => entry.policy.finalScore >= entry.policy.minScore)
          .sort((a, b) => b.policy.finalScore - a.policy.finalScore);
      } catch (error) {
        log("ml_inference", `Policy/ML blend skipped: ${error.message}`);
      }
    }
    passingForFallback = passing;
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    // Stash the full top-level result for the screening-snapshot log
    _lastScreeningResult = topCandidates || {};
    // Stash the surviving pools + enriched context for /deploy N consistency.
    // The manual /screen path does the same thing, so the cached list always
    // matches what the cron saw.
    setLatestCandidates(passing.map(({ pool }) => pool));
    _latestCandidatesEnriched = new Map(passing.map((entry) => [entry.pool.pool, entry]));

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 5)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      // Per-reason kill counts across the whole funnel — the examples alone
      // can't show which filter is doing most of the rejecting.
      const rejectCounts = topCandidates?.reject_summary && Object.keys(topCandidates.reject_summary).length
        ? "Reject counts:\n" + Object.entries(topCandidates.reject_summary)
            .sort((a, b) => b[1] - a[1]).slice(0, 6)
            .map(([reason, count]) => `- ${count}× ${reason}`).join("\n")
        : null;
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      const thresholds = `Thresholds: tvl>$${config.screening.minTvl} | vol>$${config.screening.minVolume} | organic>${config.screening.minOrganic}% | holders>${config.screening.minHolders} | fee/tvl>${config.screening.minFeeActiveTvlRatio}%`;
      screenReport = [
        "No candidates available.",
        funnelBlock,
        rejectCounts,
        !funnelBlock && combinedExamples ? `Filtered examples:\n${combinedExamples}` : null,
        !funnelBlock && !combinedExamples && !rejectCounts ? thresholds : null,
      ].filter(Boolean).join("\n\n");
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: funnelBlock || combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
        metrics: {
          screened_candidates: Array.isArray(combined) ? combined.length : 0,
          positions_open: prePositions.total_positions,
          wallet_sol: currentBalance.sol,
        },
      });
      return screenReport;
    }

    if (passing.length <= 1 && gmgnStageCounts) {
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      if (funnelBlock) log("screening", `GMGN funnel (sparse):\n${funnelBlock}`);
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
          funnelBlock ? `\n${funnelBlock}` : null,
        ].filter(Boolean).join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
          metrics: {
            fee_tvl_ratio: passing[0].pool?.fee_active_tvl_ratio ?? null,
            volume: passing[0].pool?.volume_window ?? null,
            organic: passing[0].pool?.organic_score ?? null,
            holders: passing[0].pool?.holders ?? null,
            concentration_top10: passing[0].ti?.audit?.top_holders_pct ?? null,
            volatility: passing[0].pool?.volatility ?? null,
            token_age_hours: passing[0].pool?.token_age_hours ?? null,
          },
        });
        return screenReport;
      }
    }

    await liveStage(liveMessage, "scoring");
    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Stage ML features for all passing candidates (for training data capture)
    if (config.ml?.enabled) {
      const { extractFeatures, normalizeVector } = await import("./ml/features.js");
      for (const { pool, study, mem, policy } of passing) {
        try {
          const rawFeatures = extractFeatures({
            candidate: { ...pool, policy },
            poolMemory: null,
            studyData: study?.patterns || null,
            context: {
              walletSol: currentBalance.sol,
              walletTotalUsd: currentBalance.total_usd,
              activePositions: prePositions.total_positions,
              maxPositions: config.risk.maxPositions,
              deployAmountSol: deployAmount,
              entryMcap: pool.mcap ?? pool.token_x?.market_cap,
              entryTvl: pool.tvl ?? pool.active_tvl,
              entryVolume: pool.volume_window ?? pool.volume,
              entryHolders: pool.holders ?? pool.token_x?.holder_count,
            },
          });
          if (pool.pool) {
            stageMlFeatures(pool.pool, {
              raw: Array.from(rawFeatures),
              norm: Array.from(normalizeVector(rawFeatures)),
              studyData: study ? { patterns: study.patterns } : null,
            });
          }
        } catch {}
      }
    }

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem, policy }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const botLine = pool.bot_traded ? `  bot_traded: true (${pool.bot_trade_count} trades)` : null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      let block;
      if (pool.gmgn) {
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  policy: score=${policy?.score ?? "?"}/${policy?.minScore ?? "?"}, final=${policy?.finalScore ?? policy?.score ?? "?"}, regime=${policy?.regime ?? "NEUTRAL"}, fee/vol=${policy?.flow?.feeVolatilityRatio?.toFixed?.(4) ?? "?"}, volume_persist=${policy?.flow?.volumePersistenceRatio?.toFixed?.(2) ?? "?"}${policy?.ml ? `, ml=${policy.ml.mlScore} (${policy.mlVerdict})` : ""}${policy?.flow?.toxic ? `, toxic=${policy.flow.toxicReasons.join("; ")}` : ""}`,
          formatGmgnCandidateForPrompt(pool),
          pvpLine,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      } else {
        const gmgnPriceLine = pool.gmgn_price_action
          ? `  gmgn_price: rsi2=${pool.gmgn_price_action.rsi2 ?? "?"}, supertrend=${pool.gmgn_price_action.supertrend?.direction || "?"}, price_vs_ath=${pool.gmgn_price_action.priceVsAthPct ?? "?"}%, 1h_change=${pool.gmgn_price_action.priceChangePct ?? "?"}%, max_vol_candle=${pool.gmgn_price_action.maxVolumeShare ?? "?"}%`
          : null;
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  policy: score=${policy?.score ?? "?"}/${policy?.minScore ?? "?"}, final=${policy?.finalScore ?? policy?.score ?? "?"}, regime=${policy?.regime ?? "NEUTRAL"}, fee/vol=${policy?.flow?.feeVolatilityRatio?.toFixed?.(4) ?? "?"}, volume_persist=${policy?.flow?.volumePersistenceRatio?.toFixed?.(2) ?? "?"}${policy?.ml ? `, ml=${policy.ml.mlScore} (${policy.mlVerdict})` : ""}${policy?.flow?.toxic ? `, toxic=${policy.flow.toxicReasons.join("; ")}` : ""}`,
          `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
          `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
          gmgnPriceLine,
          pvpLine,
          okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
          okxTags  ? `  tags: ${okxTags}` : null,
          botLine,
          pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      }

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
          entry_mcap:            pool.mcap                  ?? null,
          entry_tvl:             pool.tvl                   ?? null,
          entry_volume:          pool.volume_window         ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    // ML emotion & personality context for the screener
    let mlEmotionContext = "";
    try {
      const { getEmotionalPromptContext } = await import("./ml/inference.js");
      mlEmotionContext = getEmotionalPromptContext();
    } catch {}

    // Build a CONFIG section with the actual current config values, so the
    // LLM never has to guess or invent thresholds.
    const configBlock = [
      "CONFIG (current values from user-config.json — use these EXACT numbers, do not invent):",
      `  minFeeActiveTvlRatio: ${config.screening.minFeeActiveTvlRatio}%`,
      `  minTvl / maxTvl: $${config.screening.minTvl} / $${config.screening.maxTvl}`,
      `  minVolume: $${config.screening.minVolume}`,
      `  minOrganic: ${config.screening.minOrganic}`,
      `  minHolders: ${config.screening.minHolders}`,
      `  minMcap / maxMcap: $${config.screening.minMcap} / $${config.screening.maxMcap}`,
      `  maxBotHoldersPct: ${config.screening.maxBotHoldersPct}%`,
      `  maxTop10Pct: ${config.screening.maxTop10Pct}%`,
      `  minTokenFeesSol: ${config.screening.minTokenFeesSol} SOL`,
      `  maxBinStep: ${config.screening.maxBinStep}`,
      `  minTokenAgeHours: ${config.screening.minTokenAgeHours ?? "(none)"}`,
      `  blockedLaunchpads: ${JSON.stringify(config.screening.blockedLaunchpads)}`,
      `  allowedLaunchpads: ${JSON.stringify(config.screening.allowedLaunchpads)}`,
    ].join("\n");

    // Build a per-pool hard-filter verdict block. The LLM gets to see, for
    // each surviving pool, which checks passed and which failed (none should
    // have failed if it's in `passing`, but show it for transparency).
    const verdictBlock = passing.map((entry, i) => {
      const v = formatHardFilterVerdict(entry);
      return `--- Hard-filter verdict for #${i + 1} ---\n${v}`;
    }).join("\n\n");

    deployAttempted = false;
    deploySucceeded = false;
    deployPool = null;
    deployPoolName = null;
    await liveStage(liveMessage, "deciding");
    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL
${mlEmotionContext ? "\n" + mlEmotionContext + "\n" : ""}
${configBlock}

${passing.length} candidate(s) survived every hard check below. Their per-pool hard-filter verdicts are:
${verdictBlock}

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

RULES — read carefully:
1. Every candidate above has ALREADY passed: (a) hard screening thresholds (config values listed in CONFIG), (b) launchpad allow/block filters, (c) bot-holder concentration check, (d) adaptive deploy profile (token age + volatility guard), and (e) lone-candidate narrative/smart-wallet guard. You are NOT supposed to re-veto pools that passed these checks. Your only job is to pick the best one of ${passing.length} survivor(s).
2. DO NOT invent thresholds, percentages, or requirements not in the CONFIG section above. If a number in the pool data does not match a CONFIG threshold, the verdict block will say so explicitly.
3. If you decide no pool qualifies, your reason MUST reference specific data from the pool blocks or the verdict blocks. Never cite a threshold or percentage unless you copy the EXACT number from CONFIG or the pool block.
4. IMPORTANT on units: if CONFIG says minFeeActiveTvlRatio = 0.015%, that means exactly 0.015%. Do NOT restate it as 2%, 1.5%, or "effectively zero".
5. IMPORTANT on survivors: every pool shown here already passed the hard threshold checks. That means you must NOT use threshold-failure language like "fee/aTVL below CONFIG minimum", "organic below minimum", or similar for these survivors. If you choose NO DEPLOY anyway, the reason must be qualitative or comparative, not a hard-threshold failure.
6. If 0 candidates passed (passing.length = 0), use the ⛔ NO DEPLOY format. Otherwise, you should almost always DEPLOY the top-ranked survivor unless there is a strong, data-grounded reason not to.

STEPS:
1. If passing.length >= 1, deploy the top survivor (the one with the highest fee/aTVL × organic × smart-wallet score). If you have a strong data-grounded reason to skip it, name the pool and cite the specific qualitative or comparative data point exactly as shown.
2. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*(${config.strategy.maxBinsBelow - config.strategy.minBinsBelow})) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   pass deploy_position.volatility = the candidate volatility value.
   pass deploy_position.discovery_timeframe = the candidate discovery_timeframe value exactly as shown.
   For single-side SOL deploys, do not invent upside:
   set amount_y only, keep amount_x = 0, keep bins_above = 0, and let the upper bin stay at the active bin.
3. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
4. Only use the ⛔ NO DEPLOY format below if you have a strong, data-grounded reason. Use the format:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <must cite a specific comparative or qualitative data point from the pool/verdict blocks above. Do NOT claim that a shown survivor failed CONFIG minimums, because shown survivors already passed those hard checks. Good examples: "no smart-wallet confirmation while the other survivor had strong confirmation", "narrative is materially weaker than the other survivor", "momentum/volume persistence is weaker than the alternative despite passing minimums">

   REJECTED
   <short flat list of top candidate names and the SPECIFIC qualitative/comparative reason each was skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
- If you cite a CONFIG threshold, copy the EXACT number from the CONFIG section above. Do not paraphrase.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        candidatesPreloaded: true,
        candidateCount: passing.length,
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            log("screening", `LLM invoked deploy_position tool`);
          }
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
            log("screening", `Deploy attempt finished: success=${deploySucceeded} pool=${result?.pool_name || result?.pool || "unknown"}` + (deploySucceeded ? "" : ` error=${result?.error || "unknown"}`));
            if (deploySucceeded) {
              deployPool = result?.pool || null;
              deployPoolName = result?.pool_name || null;
            }
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    screenReport = content;
    // Log the LLM's verdict so the operator can see what the model decided
    // (the actual narrative goes to Telegram; this is the binary outcome).
    const llmVerdict = /⛔\s*NO DEPLOY/i.test(content) ? "NO DEPLOY"
                     : /🚀\s*DEPLOY/i.test(content) ? "DEPLOY"
                     : deployAttempted ? "DEPLOY_ATTEMPTED"
                     : "AMBIGUOUS";
    log("screening", `LLM verdict: ${llmVerdict} (${content.length} chars, ${passing.length} hard-filter survivor(s))`);

    if (/⛔\s*NO DEPLOY/i.test(content)) {
      // Data-anchored audit: when the LLM chose no deploy, surface the actual
      // hard-filter verdict on the top survivor alongside the LLM's narrative.
      // The LLM's judgment is respected, but the operator gets to see whether
      // the LLM's reason matches the data. This is informational, not an
      // override — the LLM remains the final decision-maker.
      if (passing.length >= 1) {
        const topSurvivor = passing[0];
        const hardFilterVerdict = formatHardFilterVerdict(topSurvivor);
        const auditBlock = [
          "DATA AUDIT (operator visibility only — LLM's decision stands)",
          `Top survivor: ${topSurvivor.pool?.name || "unknown"} — passed all hard checks above.`,
          "The LLM declined to deploy. Reasons may be qualitative (narrative, smart-wallet timing) or may not match the data. Use /deploy 1 to force-deploy this pool if you disagree.",
          "",
          "Hard-filter verdict on the top survivor:",
          hardFilterVerdict,
        ].join("\n");
        log("screening", `LLM no-deploy audit (${passing.length} hard-filter survivors)\n${hardFilterVerdict}`);
        // Append the audit to the LLM's narrative so the operator sees both side by side.
        screenReport = `${content}\n\n${auditBlock}`;
      }
      // Cross-check the LLM's narrative against the actual data. If the LLM
      // cited a config threshold that doesn't match the live config, OR a
      // pool value that doesn't match the data, treat that as a false veto.
      // In that case we proceed with a deterministic deploy of the top
      // survivor instead of letting a hallucinated reason block execution.
      if (passing.length >= 1) {
        const llmText = stripThink(content);
        const dataMismatchWarnings = checkLlmNarrativeAgainstData(llmText, passing, config);
        if (dataMismatchWarnings.length > 0) {
          const mismatchBlock = [
            "⚠️ NARRATIVE / DATA MISMATCH (the LLM cited a number that doesn't match the live data):",
            ...dataMismatchWarnings.map((w) => `  - ${w}`),
            "",
            "Because this NO DEPLOY reason contradicts live data, Meridian will ignore the false veto and deploy the top survivor automatically.",
          ].join("\n");
          log("screening", `LLM narrative/data mismatches:\n${dataMismatchWarnings.join("\n")}`);
          screenReport = `${screenReport}\n\n${mismatchBlock}`;

          const topSurvivor = passing[0]?.pool;
          if (topSurvivor) {
            const deployProfile = chooseAdaptiveDeployProfile(topSurvivor, config.strategy);
            if (deployProfile.overrideReason) {
              log("screening", `Adaptive override: ${topSurvivor.name} config=${deployProfile.configStrategy} → effective=${deployProfile.strategy} (${deployProfile.overrideReason})`);
            }
            if (deployProfile.deployable) {
              const deployAmountOverride = Number((deployAmount * (deployProfile.sizeMultiplier || 1) * sizeMultiplierForScore(passing[0]?.policy?.score || 66, regime)).toFixed(2));
              const initialValueUsd = currentBalance.sol_price ? deployAmountOverride * currentBalance.sol_price : null;
              const binsBelow = Math.max(config.minSafeBinsBelow, Math.round(computeBinsBelow(topSurvivor.volatility) * (deployProfile.binsMultiplier || 1)));
              const fallbackResult = await executeTool("deploy_position", {
                pool_address: topSurvivor.pool,
                amount_y: deployAmountOverride,
                strategy: deployProfile.strategy,
                bins_below: binsBelow,
                bins_above: 0,
                pool_name: topSurvivor.name,
                base_mint: topSurvivor.base?.mint || topSurvivor.base_mint || null,
                bin_step: topSurvivor.bin_step,
                base_fee: topSurvivor.base_fee,
                volatility: topSurvivor.volatility,
                fee_tvl_ratio: topSurvivor.fee_active_tvl_ratio ?? topSurvivor.fee_tvl_ratio,
                organic_score: topSurvivor.organic_score,
                discovery_timeframe: topSurvivor.discovery_timeframe || config.screening.timeframe,
                initial_value_usd: initialValueUsd,
                entry_score: passing[0]?.policy?.finalScore ?? passing[0]?.policy?.score ?? null,
                entry_regime: regime.regime,
                entry_fee_volatility_ratio: passing[0]?.policy?.flow?.feeVolatilityRatio ?? null,
                entry_volume_persistence_ratio: passing[0]?.policy?.flow?.volumePersistenceRatio ?? null,
                entry_toxic_flow: passing[0]?.policy?.flow?.toxicReasons ?? null,
              });
              deployAttempted = true;
              deploySucceeded = Boolean(fallbackResult?.success && !fallbackResult?.error && !fallbackResult?.blocked);
              if (deploySucceeded) {
                deployPool = fallbackResult?.pool || topSurvivor.pool;
                deployPoolName = fallbackResult?.pool_name || topSurvivor.name;
                screenReport = [
                  "🚀 DEPLOYED (DATA-INTEGRITY FALLBACK)",
                  "",
                  `${topSurvivor.name}`,
                  `${topSurvivor.pool}`,
                  "",
                  `◎ ${deployAmountOverride} SOL | ${deployProfile.strategy}`,
                  `Reason: LLM NO DEPLOY contradicted live data, so the false veto was ignored.`,
                ].join("\n");
              }
            }
          }
        }
      }
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
        metrics: {
          passing_candidates: passing.length,
          positions_open: prePositions.total_positions,
          deploy_amount_sol: deployAmount,
        },
      });
    } else if (!deploySucceeded) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
        metrics: {
          passing_candidates: passing.length,
          deploy_attempted: deployAttempted,
          deploy_succeeded: deploySucceeded,
        },
      });
    }
  } catch (error) {
    const errorText = String(error?.message || error || "unknown error");
    // Provider fallback: if the LLM provider dies before making a decision,
    // but screening already produced survivors, deploy the top survivor
    // deterministically instead of losing the whole cycle.
    if ((/502|503|524|529|no body|empty response|timeout/i.test(errorText)) && passingForFallback.length >= 1) {
      try {
        const topSurvivor = passingForFallback[0]?.pool;
        if (topSurvivor) {
          const deployProfile = chooseAdaptiveDeployProfile(topSurvivor, config.strategy);
          if (deployProfile.overrideReason) {
            log("screening", `Adaptive override: ${topSurvivor.name} config=${deployProfile.configStrategy} → effective=${deployProfile.strategy} (${deployProfile.overrideReason})`);
          }
          if (deployProfile.deployable) {
            const deployAmountOverride = Number((screeningDeployAmount * (deployProfile.sizeMultiplier || 1) * sizeMultiplierForScore(passingForFallback[0]?.policy?.score || 66)).toFixed(2));
            const initialValueUsd = screeningBalance?.sol_price ? deployAmountOverride * screeningBalance.sol_price : null;
            const binsBelow = Math.max(config.minSafeBinsBelow, Math.round(computeBinsBelow(topSurvivor.volatility) * (deployProfile.binsMultiplier || 1)));
            const fallbackResult = await executeTool("deploy_position", {
              pool_address: topSurvivor.pool,
              amount_y: deployAmountOverride,
              strategy: deployProfile.strategy,
              bins_below: binsBelow,
              bins_above: 0,
              pool_name: topSurvivor.name,
              base_mint: topSurvivor.base?.mint || topSurvivor.base_mint || null,
              bin_step: topSurvivor.bin_step,
              base_fee: topSurvivor.base_fee,
              volatility: topSurvivor.volatility,
              fee_tvl_ratio: topSurvivor.fee_active_tvl_ratio ?? topSurvivor.fee_tvl_ratio,
              organic_score: topSurvivor.organic_score,
              discovery_timeframe: topSurvivor.discovery_timeframe || config.screening.timeframe,
              initial_value_usd: initialValueUsd,
              entry_score: passingForFallback[0]?.policy?.finalScore ?? passingForFallback[0]?.policy?.score ?? null,
              entry_regime: passingForFallback[0]?.policy?.regime ?? null,
              entry_fee_volatility_ratio: passingForFallback[0]?.policy?.flow?.feeVolatilityRatio ?? null,
              entry_volume_persistence_ratio: passingForFallback[0]?.policy?.flow?.volumePersistenceRatio ?? null,
              entry_toxic_flow: passingForFallback[0]?.policy?.flow?.toxicReasons ?? null,
            });
            deployAttempted = true;
            deploySucceeded = Boolean(fallbackResult?.success && !fallbackResult?.error && !fallbackResult?.blocked);
            if (deploySucceeded) {
              deployPool = fallbackResult?.pool || topSurvivor.pool;
              deployPoolName = fallbackResult?.pool_name || topSurvivor.name;
              screenReport = [
                "🚀 DEPLOYED (PROVIDER FALLBACK)",
                "",
                `${topSurvivor.name}`,
                `${topSurvivor.pool}`,
                "",
                `◎ ${deployAmountOverride} SOL | ${deployProfile.strategy}`,
                `Reason: LLM provider failed (${errorText}), so Meridian deployed the top screened survivor deterministically.`,
              ].join("\n");
              log("screening", `Provider failure fallback deployed ${topSurvivor.name} after LLM error: ${errorText}`);
            } else {
              log("cron_error", `Provider fallback deploy failed after screening error: ${fallbackResult?.error || fallbackResult?.reason || errorText}`);
              screenReport = `Screening cycle failed: ${errorText}`;
            }
          } else {
            screenReport = `Screening cycle failed: ${errorText}`;
          }
        } else {
          screenReport = `Screening cycle failed: ${errorText}`;
        }
      } catch (fallbackError) {
        log("cron_error", `Provider fallback path failed: ${fallbackError.message}`);
        screenReport = `Screening cycle failed: ${errorText}`;
      }
    } else {
      log("cron_error", `Screening cycle failed: ${errorText}`);
      screenReport = `Screening cycle failed: ${errorText}`;
    }
  } finally {
    // Update ML emotions based on screening outcome
    try {
      const { onScreenerCycle } = await import("./ml/emotions.js");
      onScreenerCycle({
        deployed: deploySucceeded && deployAttempted,
        skipReason: screenReport?.includes("NO DEPLOY") ? "llm rejected"
                  : screenReport?.includes("not worth deploying") ? "all filtered"
                  : screenReport?.includes("skipped") ? "no candidates"
                  : deployAttempted && !deploySucceeded ? "deploy failed"
                  : null,
      });
    } catch {}

    // Persist a structured funnel snapshot to data/screening-snapshots/*.jsonl
    try {
      const lastResult = _lastScreeningResult || {};
      logScreeningSnapshot({
        runtime_mode: process.env.MERIDIAN_RUNTIME_MODE,
        total_screened: lastResult.total_screened ?? null,
        total_eligible: lastResult.total_eligible ?? null,
        discovery_timeframe: lastResult.discovery_timeframe ?? null,
        bot_tracked_injected: !!lastResult.bot_tracked_injected,
        deployed: deploySucceeded && deployAttempted,
        pool: deployPool,
        pool_name: deployPoolName,
        filtered_examples: (lastResult.filtered_examples || []).slice(0, 5),
      });
      _lastScreeningResult = null;
    } catch {}
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        const { sendMessageWithButtons } = await import("./telegram.js");
        const { formatScreeningReport } = await import("./utils/telegram-formatter.js");
        const { text, buttons } = formatScreeningReport(stripThink(screenReport), {
          pool: deploySucceeded ? deployPool : null,
          poolName: deployPoolName,
        });
        if (liveMessage) {
          await liveMessage.finalize(null).catch(() => {});
          await sendMessageWithButtons(text, buttons).catch(() => {});
        } else {
          await sendMessageWithButtons(text, buttons).catch(() => {});
        }
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, async () => {
    if (_screeningBusy) {
      log("cron", "Screening cron skipped — previous cycle still running");
      return;
    }
    try {
      const report = await runScreeningCycle();
      if (report) log("cron", `Screening cycle finished, report length: ${report.length}`);
      else log("cron", "Screening cycle returned no report");
    } catch (e) {
      log("cron_error", `Screening cycle failed: ${e.message}`);
    }
  });

  // Deterministic hourly health check — no LLM. The old version asked the
  // MANAGER agent to write a report whose return value was discarded; the
  // model often produced an empty markdown table. Real data, logged directly.
  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      const [balances, mine] = await Promise.all([
        getWalletBalances().catch(() => null),
        getMyPositions({ force: true }).catch(() => null),
      ]);
      const lines = ["HEALTH CHECK"];
      if (balances) {
        const tokenUsd = (balances.tokens || []).reduce((s, t) => s + (Number(t.usd) || 0), 0);
        lines.push(`Wallet: ${Number(balances.sol ?? 0).toFixed(3)} SOL${tokenUsd > 0.5 ? ` + $${tokenUsd.toFixed(2)} in tokens` : ""}`);
      } else {
        lines.push("Wallet: balance lookup failed");
      }
      const positions = mine?.positions || [];
      lines.push(`Open positions: ${positions.length}/${config.risk.maxPositions}`);
      for (const p of positions) {
        const pnl = p.pnl_pct != null ? `${p.pnl_pct >= 0 ? "+" : ""}${Number(p.pnl_pct).toFixed(2)}%` : "?";
        const fees = p.unclaimed_fees_usd != null ? ` | fees $${Number(p.unclaimed_fees_usd).toFixed(2)}` : "";
        const oor = p.in_range === false ? ` | OOR ${p.minutes_out_of_range ?? "?"}m` : "";
        lines.push(`  ${p.pair}: ${pnl}${fees}${oor}`);
      }
      const perf = getPerformanceSummary();
      if (perf) lines.push(String(perf).split("\n")[0]);
      log("cron", lines.join("\n"));
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight PnL poller — updates trailing TP state between management cycles, no LLM.
  // Runs on public infra (RPC + Jupiter + Meteora deposits) so it can poll aggressively.
  const pnlPollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 10)) * 1000;
  const pnlPollInterval = safeSetInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    // Calm-skip: each poll is a full RPC position decode (the main steady CPU
    // cost of the daemon). When the last poll showed every position in range,
    // not trailing, and well clear of the stop, skip 2 ticks (3x slower).
    // Any hot signal on the next real poll restores full cadence.
    if (_pnlPollCalmSkips > 0) {
      _pnlPollCalmSkips -= 1;
      return;
    }
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      const stopLoss = Number(config.management.stopLossPct ?? -50);
      const allCalm = result.positions.every((p) => {
        // Judge calmness on the more pessimistic of reported/derived so a
        // lagging reported pct can't slow the poll while the real mark bleeds.
        const worstPnl = Math.min(p.pnl_pct ?? Infinity, p.pnl_pct_derived ?? Infinity);
        return (
          p.in_range !== false &&
          !getTrackedPosition(p.position)?.trailing_active &&
          Number.isFinite(worstPnl) && worstPnl > stopLoss + 4
        );
      });
      _pnlPollCalmSkips = allCalm ? 2 : 0;
      for (const p of result.positions) {
        if (
          !p.pnl_pct_suspicious &&
          queuePeakConfirmation(p.position, p.pnl_pct_derived ?? p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
          shouldUsePnlRecheck()
        ) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management)) {
              scheduleTrailingDropConfirmation(p.position);
            }
            continue;
          }
          // Stop-loss breaches bypass the normal management-interval cooldown:
          // a fast dump can move -10% → -50% inside one 10-minute window, so
          // capping the left tail is worth an extra management cycle.
          const isEmergency = exit.action === "STOP_LOSS";
          const cooldownMs = isEmergency
            ? EMERGENCY_POLL_COOLDOWN_MS
            : config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management${isEmergency ? " (emergency)" : ""}`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
        const closeRule = getDeterministicCloseRule(p, config.management);
        if (closeRule) {
          // Rule 1 (stop loss) and Rule 6 (below range) are loss-cutting rules —
          // same emergency bypass as STOP_LOSS above.
          const isEmergency = closeRule.rule === 1 || closeRule.rule === 6;
          const cooldownMs = isEmergency
            ? EMERGENCY_POLL_COOLDOWN_MS
            : config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — triggering management${isEmergency ? " (emergency)" : ""}`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, pnlPollMs);

  // ─── Wallet sweeper ──────────────────────────────────────────────
  // Periodically scans the wallet for base tokens (above the dust floor)
  // and swaps them to SOL. This is the missing complement to the
  // close/claim auto-swap — the close/claim auto-swap only fires on
  // those events, but if base tokens are already in the wallet
  // (from old closes before the fix, or from manual transfers), they
  // need a separate sweep to consolidate.
  const sweepIntervalMs = Math.max(60_000, Number(config.management.walletSweepIntervalSec ?? 300) * 1000);
  const sweepTimer = safeSetInterval(async () => {
    log("sweep_debug", `Sweep tick fired (interval=${sweepIntervalMs / 1000}s)`);
    await runWalletSweepOnce({ source: "cron" });
  }, sweepIntervalMs);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog, sweepTimer];
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._sweepInterval = sweepTimer;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m, pnlPoll every ${config.pnl.pollIntervalSec}s, wallet sweep every ${sweepIntervalMs / 1000}s`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

/**
 * Run a single wallet sweep cycle. Used by:
 *  - the periodic cron (every walletSweepIntervalSec)
 *  - the /sweep Telegram command (manual one-off trigger)
 *
 * Returns a summary object: { candidates: [...], swapped: [...], skipped: [...], error: null|string }
 */
export async function runWalletSweepOnce({ source = "manual" } = {}) {
  if (_managementBusy || _screeningBusy || _pnlPollBusy) {
    log("sweep_debug", `[${source}] Sweep skipped: management=${_managementBusy} screening=${_screeningBusy} pnlPoll=${_pnlPollBusy}`);
    return { candidates: [], swapped: [], skipped: ["busy"], error: "busy" };
  }
  if (_sweepBusy) {
    log("sweep_debug", `[${source}] Sweep skipped: another sweep in progress`);
    return { candidates: [], swapped: [], skipped: ["already_running"], error: "already_running" };
  }
  _sweepBusy = true;
  try {
    const balances = await getWalletBalances({});
    const SOL_MINT = config.tokens.SOL;
    const floor = Math.max(0, Number(config.management.autoSwapMinUsdFloor ?? 0.10));
    // Build a set of base mints that have open positions. We can still
    // sweep stray tokens that AREN'T the base of an open position (e.g.
    // Potato leftovers in the wallet don't conflict with a CATWIF LP).
    const openPositions = getTrackedPositions(true);
    const openBaseMints = new Set(
      openPositions
        .map((p) => normalizeMint(p.base_mint || p.baseMint || ""))
        .filter(Boolean)
    );
    const candidates = (balances.tokens || []).filter((t) => {
      if (!t.mint) return false;
      if (normalizeMint(t.mint) === SOL_MINT) return false;
      if (t.usd == null || t.usd < floor) return false;
      if (Number(t.balance) <= 0) return false;
      // Skip tokens that are the base of an open position — swapping
      // them away could affect the position's x_token balance.
      if (openBaseMints.has(normalizeMint(t.mint))) return false;
      return true;
    });
    if (candidates.length === 0) {
      const reason = openPositions.length > 0
        ? `${openPositions.length} open position(s) covering all candidates, or all below floor`
        : `all below floor or SOL`;
      log("sweep_debug", `[${source}] Sweep: no candidates (floor=$${floor.toFixed(2)}, ${(balances.tokens || []).length} tokens in wallet, ${reason})`);
      return { candidates: [], swapped: [], skipped: ["no_candidates"], error: null };
    }
    log("sweep", `[${source}] Wallet sweep: ${candidates.length} token(s) above $${floor.toFixed(2)} floor — ${candidates.map((t) => `${t.symbol} ($${t.usd.toFixed(2)})`).join(", ")}`);
    const { swapToken } = await import("./tools/wallet.js");
    const swapped = [];
    const failed = [];
    for (const t of candidates) {
      try {
        log("sweep", `Sweeping ${t.symbol} ($${t.usd.toFixed(2)}, ${t.balance} tokens) → SOL`);
        const res = await swapToken({ input_mint: t.mint, output_mint: "SOL", amount: t.balance });
        if (res?.success) {
          log("sweep", `✓ ${t.symbol} → SOL: tx ${res.tx}`);
          swapped.push({ symbol: t.symbol, tx: res.tx });
        } else {
          log("sweep_warn", `✗ ${t.symbol} sweep failed: ${res?.error || "no tx"}`);
          failed.push({ symbol: t.symbol, error: res?.error || "no tx" });
        }
      } catch (e) {
        log("sweep_warn", `Sweep error on ${t.symbol}: ${e.message}`);
        failed.push({ symbol: t.symbol, error: e.message });
      }
    }
    return { candidates: candidates.map((t) => ({ symbol: t.symbol, usd: t.usd, balance: t.balance })), swapped, failed, error: null };
  } catch (e) {
    log("sweep_warn", `Sweep cycle error: ${e.message}`);
    return { candidates: [], swapped: [], skipped: [], error: e.message };
  } finally {
    _sweepBusy = false;
  }
}


function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";
  return formatCandidatesListPlain(candidates, { title: "Top candidates" }).text;
}

export function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    // Only suspect if PnL is so extreme (e.g. < -95%) that it likely contradicts tracked USD value
    if (position.pnl_pct <= -95) {
      if (tracked?.amount_sol && (position.total_value_usd ?? 0) > (position.amount_sol * 0.01)) {
        log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
        return true; 
      }
    }
    return false;
  })();

  // Rule 1 acts on the loss-side effective PnL (freshest mark — derived
  // preferred over the provider's lagging precomputed pct, see state.js).
  const lossPnlPct = effectiveLossPnlPct(position);
  if (!pnlSuspect && lossPnlPct != null && lossPnlPct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  // Suspicious-tick override for the stop loss only: a phantom loss shows in
  // one PnL source, a real crash shows in both. If even the more optimistic
  // of reported/derived is past the stop, close — otherwise a fast dump keeps
  // the sanity flag raised for its entire duration and the stop never fires.
  if (
    pnlSuspect &&
    position.pnl_pct != null &&
    position.pnl_pct_derived != null &&
    Math.max(position.pnl_pct, position.pnl_pct_derived) <= managementConfig.stopLossPct
  ) {
    return { action: "CLOSE", rule: 1, reason: "stop loss (both PnL sources agree despite suspicious tick)" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  // ── Rule 4b (trend-aware) — escalate OOR close if PnL is declining ─────
  if (
    position.in_range === false &&
    (position.minutes_out_of_range ?? 0) >= Math.max(5, Math.floor(managementConfig.outOfRangeWaitMinutes * 0.5))
  ) {
    const memory = recallForPool(position.pool);
    if (isRangeDriftAccelerating(memory, position.position)) {
      return { action: "CLOSE", rule: "4b", reason: "OOR + declining PnL" };
    }
  }
  // ── Rule 6 — price fell below the entire range ─────────────────────
  // A single-sided SOL position below its range is fully converted to the
  // base token: zero fee income, pure directional bag while the token dumps.
  // Exit much faster than the generic outOfRangeWaitMinutes (which mainly
  // exists for the harmless pumped-above case where the position sits in SOL).
  if (
    position.active_bin != null &&
    position.lower_bin != null &&
    position.active_bin < position.lower_bin &&
    (position.minutes_out_of_range ?? 0) >= (managementConfig.belowRangeExitMinutes ?? 10)
  ) {
    return { action: "CLOSE", rule: 6, reason: "below range — inventory fully converted" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    const memory = recallForPool(position.pool);
    const snapshots = Array.isArray(memory?.snapshots) ? memory.snapshots : [];
    const recent = snapshots.filter((s) => s.position === position.position).slice(-3);
    const feeGrowthFlat = recent.length >= 2
      ? Math.abs(Number(recent[1].unclaimed_fees_usd || 0) - Number(recent[0].unclaimed_fees_usd || 0)) < 0.02
      : false;
    const valueDriftingDown = recent.length >= 2
      ? Number(recent[1].pnl_pct || 0) <= Number(recent[0].pnl_pct || 0)
      : false;
    if (feeGrowthFlat || valueDriftingDown) {
      return { action: "CLOSE", rule: 5, reason: "low yield" };
    }
  }
  return null;
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;
let _latestCandidatesEnriched = new Map(); // pool_address -> {pool, sw, n, ti, mem, study}
let _lastScreeningResult = null;

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
  // Don't clear _latestCandidatesEnriched unconditionally — runDeterministicScreen
  // calls setLatestCandidates after populating the enriched map. External callers
  // (tests, REPL commands) that go through this helper should also re-enrich if
  // they want consistent deploy checks.
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const tf = _latestCandidates[0]?.discovery_timeframe || config.screening.timeframe;
  return formatCandidatesListPlain(_latestCandidates.slice(0, limit), { title: `Latest candidates (${_latestCandidates.length})`, timeWindow: tf }).text;
}



function formatConfigSnapshot() {
  return formatConfigSnapshotPlain(config).text;
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    trailingRetracePct: config.management.trailingRetracePct,
    belowRangeExitMinutes: config.management.belowRangeExitMinutes,
    outOfRangeWaitMinutes: config.management.outOfRangeWaitMinutes,
    minMcap: config.screening.minMcap,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
    policyEnabled: config.policy.enabled,
    policyMinFeeVolatilityRatio: config.policy.minFeeVolatilityRatio,
    policyMinVolumePersistence: config.policy.minVolumePersistence,
    policyToxicFlowPenalty: config.policy.toxicFlowPenalty,
    policyNeutralMinScore: config.policy.neutralMinScore,
    policyRiskOffMinScore: config.policy.riskOffMinScore,
    policyRiskOnMinScore: config.policy.riskOnMinScore,
    policyShrinkRetryPct: config.policy.shrinkRetryPct,
    mlEnabled: config.ml.enabled,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Strategy: ${config.strategy.strategy} | bins ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | deploy ${config.management.deployAmountSol} SOL`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? `on (trigger ${config.management.trailingTriggerPct}%, drop max(${config.management.trailingDropPct}, peak×${config.management.trailingRetracePct}))` : "off"}`,
    `Exits: below-range ${config.management.belowRangeExitMinutes}m | OOR ${config.management.outOfRangeWaitMinutes}m | min mcap $${config.screening.minMcap}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Policy", "cfg:page:policy"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max pos", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 1, { digits: 0 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL %", 5, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      stepButtons("trailingRetracePct", "Trail retrace", 0.05, { digits: 2 }),
      stepButtons("belowRangeExitMinutes", "Below-range min", 5, { digits: 0 }),
      stepButtons("outOfRangeWaitMinutes", "OOR wait min", 5, { digits: 0 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton(`Strategy: spot`, "cfg:set:strategy:spot"),
        settingButton(`Strategy: curve`, "cfg:set:strategy:curve"),
        settingButton(`Strategy: bid_ask`, "cfg:set:strategy:bid_ask"),
      ],
      stepButtons("minMcap", "Min mcap $", 50000, { digits: 0 }),
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "policy") {
    rows = [
      [toggleButton("policyEnabled", "Policy guard"), toggleButton("mlEnabled", "ML")],
      stepButtons("policyMinFeeVolatilityRatio", "Min fee/vol", 0.002, { digits: 3 }),
      stepButtons("policyMinVolumePersistence", "Vol persist", 0.25, { digits: 2 }),
      stepButtons("policyToxicFlowPenalty", "Toxic penalty", 2, { digits: 0 }),
      stepButtons("policyNeutralMinScore", "Neutral score", 1, { digits: 0 }),
      stepButtons("policyRiskOffMinScore", "Risk-off score", 1, { digits: 0 }),
      stepButtons("policyRiskOnMinScore", "Risk-on score", 1, { digits: 0 }),
      stepButtons("policyShrinkRetryPct", "Retry pct", 0.05, { digits: 2 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: NoDT", "cfg:set:indicatorEntryPreset:no_downtrend"),
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Policy / ML", "cfg:page:policy"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(config.minSafeBinsBelow, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
    if (["policyNeutralMinScore", "policyRiskOffMinScore", "policyRiskOnMinScore"].includes(key)) value = Math.max(0, Math.min(100, Math.round(value)));
    if (["policyMinFeeVolatilityRatio", "policyMinVolumePersistence", "policyToxicFlowPenalty"].includes(key)) value = Math.max(0, value);
    if (key === "policyShrinkRetryPct") value = Math.max(0.4, Math.min(0.95, value));
    if (key === "trailingRetracePct") value = Math.max(0, Math.min(0.9, value));
    if (key === "belowRangeExitMinutes") value = Math.max(1, Math.round(value));
    if (key === "outOfRangeWaitMinutes") value = Math.max(5, Math.round(value));
    if (key === "minMcap") value = Math.max(0, Math.round(value));
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
    ? "indicators"
    : key.startsWith("policy") || key === "mlEnabled"
      ? "policy"
      : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minMcap", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
        ? "screen"
        : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return "📋 Telegram Commands\n\n" + [
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — refresh/show deterministic candidate list",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/learn — study top LPers and save lessons",
    "/lessons — list recent saved lessons",
    "/thresholds — screening thresholds + stats",
    "/evolve — trigger threshold evolution",
    "/thresholdevolve — toggle threshold evolution (TVL/MC/%TP/%SL) on/off",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const { total_positions } = await getMyPositions({ force: true });
  if (total_positions >= config.risk.maxPositions) {
    throw new Error(`Max positions reached (${total_positions}/${config.risk.maxPositions})`);
  }
  // Use the same enrichment + filter pipeline as the cron path, so /screen
  // and the auto screening cycle always see the same surviving pool set.
  const pipeline = await enrichAndFilterCandidates({ limit: 10 });
  if (pipeline?.error) {
    return `Screening failed: ${pipeline.error}`;
  }
  const { passing, filteredOut } = pipeline;
  const display = passing.slice(0, limit);

  // Stash the surviving pools (not the raw unfiltered universe) so /deploy N
  // operates on data that has already passed hard filters.
  setLatestCandidates(display.map(({ pool }) => pool));
  // Also stash the enriched data so deployLatestCandidate can reuse it.
  _latestCandidatesEnriched = new Map(display.map((entry) => [entry.pool.pool, entry]));

  if (display.length > 0) {
    const lines = display.map((entry, i) => {
      const { pool, ti } = entry;
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"} | top10 ${top10Pct}% | bots ${botPct}%`;
    });
    const filteredLine = filteredOut.length > 0
      ? `\n\nFiltered out (${filteredOut.length}):\n${filteredOut.slice(0, 3).map((e) => `- ${e.name}: ${e.reason}`).join("\n")}`
      : "";
    return `Top candidates (${display.length} of ${passing.length} passing, ${filteredOut.length} filtered)${filteredLine}\n\n${lines.join("\n")}`;
  }
  const examples = (filteredOut || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

async function deployLatestCandidate(index) {
  const { total_positions } = await getMyPositions({ force: true });
  if (total_positions >= config.risk.maxPositions) {
    throw new Error(`Max positions reached (${total_positions}/${config.risk.maxPositions})`);
  }
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  // Use the enriched context that /screen stashed, so we don't re-fetch RPC.
  // This is the same data the LLM would have seen if it had picked this candidate.
  const enriched = _latestCandidatesEnriched?.get(candidate.pool);
  const context = enriched
    ? { pool: enriched.pool, sw: enriched.sw, n: enriched.n, ti: enriched.ti, mem: enriched.mem, study: enriched.study }
    : { pool: candidate };

  // Lone-candidate guard. We use the displayed candidate count (after the
  // shared pipeline's hard filters), so the same pool that would be flagged
  // on the auto path is flagged here. The enriched cache is rebuilt by every
  // /screen call, so this is always up to date.
  if (_latestCandidates.length === 1) {
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
        metrics: {
          fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio ?? null,
          volume: candidate.volume_window ?? null,
          organic: candidate.organic_score ?? null,
          holders: candidate.holders ?? null,
          volatility: candidate.volatility ?? null,
          token_age_hours: candidate.token_age_hours ?? null,
        },
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const wallet = await getWalletBalances();
  const deployProfile = chooseAdaptiveDeployProfile(candidate, config.strategy);
  if (deployProfile.overrideReason) {
    log("screening", `Adaptive override: ${candidate.name} config=${deployProfile.configStrategy} → effective=${deployProfile.strategy} (${deployProfile.overrideReason})`);
  }
  if (!deployProfile.deployable) {
    appendDecision({
      type: "no_deploy",
      actor: "SCREENER",
      summary: "Adaptive deploy guard blocked candidate",
      reason: deployProfile.reason,
      pool: candidate.pool,
      pool_name: candidate.name,
      metrics: {
        volatility: candidate.volatility ?? null,
        token_age_hours: candidate.token_age_hours ?? null,
      },
    });
    throw new Error(`NO DEPLOY: ${candidate.name} — ${deployProfile.reason}`);
  }
  const manualPolicy = scoreCandidate(candidate, { audit: enriched?.ti?.audit, smartWallets: enriched?.sw });
  const baseDeployAmount = computeDeployAmount(wallet.sol);
  const deployAmount = Number((baseDeployAmount * (deployProfile.sizeMultiplier || 1) * sizeMultiplierForScore(manualPolicy.score)).toFixed(2));
  const initialValueUsd = wallet.sol_price ? deployAmount * wallet.sol_price : null;
  const binsBelow = Math.max(config.minSafeBinsBelow, Math.round(computeBinsBelow(candidate.volatility) * (deployProfile.binsMultiplier || 1)));
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: deployProfile.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    discovery_timeframe: candidate.discovery_timeframe || config.screening.timeframe,
    initial_value_usd: initialValueUsd,
    entry_score: manualPolicy.score,
    entry_regime: getMarketRegime().regime,
    entry_fee_volatility_ratio: manualPolicy.flow?.feeVolatilityRatio ?? null,
    entry_volume_persistence_ratio: manualPolicy.flow?.volumePersistenceRatio ?? null,
    entry_toxic_flow: manualPolicy.flow?.toxicReasons ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow, deployProfile };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;

  // ── Callback button handlers ──────────────────────────
  if (msg?.isCallback) {
    const data = text;
    // Settings menu
    if (data.startsWith("cfg:")) {
      try { await applySettingsMenuCallback(msg); } catch (e) {
        await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
      }
      return;
    }
    // Forward slash commands from inline buttons
    if (data.startsWith("cmd:")) {
      const cmd = data.slice(4);
      await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
      if (cmd === "/screen" || cmd === "/candidates") {
        try {
          const { ACTION_BUTTONS, esc } = await import("./utils/telegram-formatter.js");
          const sent = await sendHTML("🔍 <i>Scanning pools…</i>").catch(() => null);
          const msgId = sent?.result?.message_id;
          const report = await runDeterministicScreen(5);
          if (msgId) {
            await editMessageWithButtons(esc(report), msgId, ACTION_BUTTONS.screening()).catch(() => {});
          } else {
            await sendMessageWithButtons(esc(report), ACTION_BUTTONS.screening()).catch(() => {});
          }
        } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
        return;
      }
      if (cmd === "/status" || cmd === "/wallet") {
        try {
          const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
          const { getCurrentState } = await import("./ml/emotions.js");
          const { text: cardText, buttons: cardBtns } = formatWalletStatus({
            wallet, positions, ml: getCurrentState(), config,
            runtimeMode: process.env.MERIDIAN_RUNTIME_MODE,
          });
          await sendMessageWithButtons(cardText, cardBtns).catch(() => {});
        } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
        return;
      }
      if (cmd === "/positions") {
        try {
          const { positions, total_positions } = await getMyPositions({ force: true });
          if (total_positions === 0) { await sendMessage("No open positions."); return; }
          for (const p of positions.slice(0, 5)) {
            const { formatPositionCard } = await import("./utils/telegram-formatter.js");
            const { text: cardText, buttons: cardBtns } = formatPositionCard(p);
            await sendMessageWithButtons(cardText, cardBtns).catch(() => {});
          }
        } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
        return;
      }
      if (cmd === "/settings") {
        await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
        return;
      }
      return;
    }
    // Position-level actions
    if (data.startsWith("pnl:")) {
      try {
        const posAddr = data.slice(4);
        const { getPositionPnl, getMyPositions } = await import("./tools/dlmm.js");
        const tracked = getTrackedPosition(posAddr);
        const pnl = await getPositionPnl({ pool_address: tracked?.pool, position_address: posAddr });
        // Fall back to cached live position data for fields getPositionPnl doesn't return
        const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
        const livePos = live?.positions?.find((p) => p.position === posAddr) || {};
        const liveAllTimeFees = Number(livePos?.collected_fees_usd || 0) + Number(livePos?.unclaimed_fees_usd || 0);
        const apiAllTimeFees = Number(pnl?.all_time_fees_usd);
        const allTimeFees = Number.isFinite(apiAllTimeFees) && (apiAllTimeFees > 0 || liveAllTimeFees <= 0)
          ? apiAllTimeFees
          : liveAllTimeFees;
        const initialUsd = tracked?.initial_value_usd
          ?? (pnl?.pnl_usd != null && pnl?.current_value_usd != null
            ? pnl.current_value_usd - pnl.pnl_usd
            : null);
        const positionView = {
          position: posAddr,
          pool: tracked?.pool || livePos?.pool,
          pair: tracked?.pool_name || livePos?.pair,
          pnl_pct: pnl?.pnl_pct,
          pnl_usd: pnl?.pnl_usd,
          initial_value_usd: initialUsd,
          final_value_usd: pnl?.current_value_usd,
          fees_earned_usd: allTimeFees,
          unclaimed_fees_usd: pnl?.unclaimed_fee_usd ?? livePos?.unclaimed_fees_usd,
          range_efficiency: livePos?.range_efficiency,
          in_range: pnl?.in_range ?? livePos?.in_range,
          minutes_out_of_range: livePos?.minutes_out_of_range,
          fee_per_tvl_24h: pnl?.fee_per_tvl_24h ?? livePos?.fee_per_tvl_24h,
          age_minutes: pnl?.age_minutes ?? livePos?.age_minutes,
          peak_pnl_pct: tracked?.peak_pnl_pct,
        };
        const { formatPositionPnLCard } = await import("./utils/telegram-formatter.js");
        const { text: pnlText, buttons: pnlBtns } = formatPositionPnLCard(positionView, {
          solMode: config.management.solMode === true,
        });
        await answerCallbackQuery(msg.callbackQueryId, `PnL: ${pnl?.pnl_pct != null ? `${pnl.pnl_pct.toFixed(2)}%` : "?"}`).catch(() => {});
        await sendMessageWithButtons(pnlText, pnlBtns).catch(() => {});
      } catch (e) { await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {}); }
      return;
    }
    if (data.startsWith("close:")) {
      try {
        const posAddr = data.slice(6);
        await answerCallbackQuery(msg.callbackQueryId, "Closing...").catch(() => {});
        const result = await closePosition({ position_address: posAddr });
        if (result?.success && result.base_mint) {
          const { swapBaseToSolWithRetry } = await import("./tools/executor.js");
          await swapBaseToSolWithRetry(result.base_mint, "after close (button)").catch(() => {});
        }
        const { formatCloseResult } = await import("./utils/telegram-formatter.js");
        const tracked = getTrackedPosition(posAddr);
        const { text, buttons } = formatCloseResult(result, {
          pair: tracked?.pool_name,
          reason: msg.callbackData?.includes("rebalance") ? "rebalance" : "telegram",
        });
        await sendMessageWithButtons(text, buttons).catch(() => {});
      } catch (e) { await sendMessage(`Close failed: ${e.message}`).catch(() => {});
        await answerCallbackQuery(msg.callbackQueryId, "Failed").catch(() => {}); }
      return;
    }
    if (data.startsWith("claim:")) {
      try {
        const posAddr = data.slice(6);
        await answerCallbackQuery(msg.callbackQueryId, "Claiming...").catch(() => {});
        const { claimFees } = await import("./tools/dlmm.js");
        const result = await claimFees({ position_address: posAddr });
        await sendMessage(`💰 Claimed: ${result?.claimed_amount ?? "done"}`).catch(() => {});
      } catch (e) { await sendMessage(`Claim failed: ${e.message}`).catch(() => {});
        await answerCallbackQuery(msg.callbackQueryId, "Failed").catch(() => {}); }
      return;
    }
    return;
  }

  // ── Settings menu shortcuts ──────────────────────────────
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/start") {
    try {
      await syncMlPersonalityFromConfig();
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const { text: startText, buttons: startBtns } = formatStart({ wallet, positions, config });
      await sendMessageWithButtons(startText, startBtns).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendHTML(formatHelp()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const { getCurrentState } = await import("./ml/emotions.js");
      const { text: cardText, buttons: cardBtns } = formatWalletStatus({
        wallet, positions, ml: getCurrentState(), config,
        runtimeMode: process.env.MERIDIAN_RUNTIME_MODE,
      });
      await sendMessageWithButtons(cardText, cardBtns).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    const { text, buttons } = formatConfigSnapshotCard(config, { runtimeMode: process.env.MERIDIAN_RUNTIME_MODE });
    await sendMessageWithButtons(text, buttons).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      for (const p of positions.slice(0, 5)) {
        const { text: cardText, buttons: cardBtns } = formatPositionCard(p, { solMode: config.management.solMode === true });
        await sendMessageWithButtons(cardText, cardBtns).catch(() => {});
      }
      if (positions.length > 5) {
        await sendMessageWithButtons(`... and ${positions.length - 5} more positions. Use /pool <n> for detail.`, ACTION_BUTTONS.screening()).catch(() => {});
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const { text: cardText, buttons: cardBtns } = formatPositionCard(positions[idx], { solMode: config.management.solMode === true });
      await sendMessageWithButtons(cardText, cardBtns).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        if (result.base_mint) {
          const { swapBaseToSolWithRetry } = await import("./tools/executor.js");
          await swapBaseToSolWithRetry(result.base_mint, "after /close").catch(() => {});
        }
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const { formatCloseResult } = await import("./utils/telegram-formatter.js");
        const { text, buttons } = formatCloseResult(result, { pair: pos.pair, reason: "/close" });
        await sendMessageWithButtons(text, buttons).catch(() => {});
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          if (result?.success && result.base_mint) {
            const { swapBaseToSolWithRetry } = await import("./tools/executor.js");
            await swapBaseToSolWithRetry(result.base_mint, "after /closeall").catch(() => {});
          }
          results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (key === "mlPersonality") await syncMlPersonalityFromConfig();
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      const { ACTION_BUTTONS, esc } = await import("./utils/telegram-formatter.js");
      const sent = await sendHTML("🔍 <i>Scanning pools…</i>").catch(() => null);
      const msgId = sent?.result?.message_id;
      const report = await runDeterministicScreen(5);
      if (msgId) {
        await editMessageWithButtons(esc(report), msgId, ACTION_BUTTONS.screening()).catch(() => {});
      } else {
        await sendMessageWithButtons(esc(report), ACTION_BUTTONS.screening()).catch(() => {});
      }
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    const recent = _latestCandidates.slice(0, 5);
    if (!recent.length) {
      const { ACTION_BUTTONS } = await import("./utils/telegram-formatter.js");
      const { text: emptyText, buttons: emptyBtns } = formatCandidatesList([], { title: "Top Candidates" });
      await sendMessageWithButtons(emptyText, emptyBtns).catch(() => {});
      return;
    }
    const discovery_tf = recent[0]?.discovery_timeframe || config.screening.timeframe;
    const { text: cText, buttons: cBtns } = formatCandidatesList(recent, {
      title: "Top Candidates",
      timeWindow: discovery_tf,
    });
    await sendMessageWithButtons(cText, cBtns).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      if (result.dry_run) {
        const wouldDeploy = result.would_deploy || {};
        await sendMessage([
          `⚠️ DRY RUN — would deploy ${candidate.name}`,
          `Pool: ${candidate.pool}`,
          `Amount: ${deployAmount} SOL`,
          `Strategy: ${wouldDeploy.strategy || config.strategy.strategy} | binsBelow: ${wouldDeploy.bins_below ?? binsBelow}`,
          `No transaction sent. Set DRY_RUN=false in .env to go live.`,
        ].join("\n")).catch(() => {});
        return;
      }
      if (!result.success) {
        await sendMessage(`❌ Deploy failed for ${candidate.name}: ${result.error || "unknown error"}`).catch(() => {});
        return;
      }
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/sweep") {
    await sendMessage("🔄 Running wallet sweep…").catch(() => {});
    const result = await runWalletSweepOnce({ source: "telegram" });
    if (result.error === "busy") {
      await sendMessage("Sweep skipped: another cycle (mgmt/screening/pnl poll) is in progress.").catch(() => {});
    } else if (result.error === "open_positions") {
      await sendMessage("Sweep skipped: there are open positions (won't sweep while LP is active).").catch(() => {});
    } else if (result.error === "already_running") {
      await sendMessage("Sweep skipped: a sweep is already running.").catch(() => {});
    } else if (result.error) {
      await sendMessage(`Sweep error: ${result.error}`).catch(() => {});
    } else if (result.candidates.length === 0) {
      await sendMessage("Sweep: no candidates above the dust floor.").catch(() => {});
    } else {
      const lines = result.candidates.map((c) => `• ${c.symbol} ($${Number(c.usd).toFixed(2)})`);
      const ok = result.swapped.map((s) => `✅ ${s.symbol}: tx ${(s.tx || "").slice(0, 12)}…`);
      const ko = result.failed.map((f) => `❌ ${f.symbol}: ${f.error}`);
      await sendMessage(
        `Wallet sweep results\n\nCandidates:\n${lines.join("\n")}\n\n${ok.join("\n")}${ko.length ? "\n\n" + ko.join("\n") : ""}`
      ).catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendHTML([
        "<b>🧠 HiveMind</b>",
        `Agent: <code>${agentId}</code>`,
        `URL: ${config.hiveMind.url}`,
        `Pull: ${pullMode}`,
        `Register: ${registerResult ? "✅ ok" : "⚠️ warn"}`,
        `Lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/thresholds") {
    try {
      const perf = getPerformanceSummary();
      const { text: thresholdsText, buttons: thresholdBtns } = formatThresholds(config);
      const tail = perf
        ? `\n<b>Performance</b>\n${perf.total_positions_closed} closed | ${perf.win_rate_pct}% win | avg PnL ${perf.avg_pnl_pct}%`
        : `\n<i>No closed positions yet.</i>`;
      await sendMessageWithButtons(thresholdsText + tail, thresholdBtns).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/ml-status" || text === "/mlstatus" || text === "/ml") {
    await syncMlPersonalityFromConfig();
    try {
      const { mlStatus } = await import("./ml/cli.js");
      const text = mlStatus(config);
      await sendMessage(text).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/evolve") {
    try {
      const perf = getPerformanceSummary();
      if (!perf || perf.total_positions_closed < 5) {
        const needed = 5 - (perf?.total_positions_closed || 0);
        await sendMessage(`Need ${needed} more closed position(s) to evolve (have ${perf?.total_positions_closed || 0}).`).catch(() => {});
        return;
      }
      const thresholdEnabled = config.management.thresholdEvolveEnabled !== false;
      const { PATHS } = await import("./utils/paths.js");
      const lessonsData = JSON.parse((await import("fs")).readFileSync(PATHS.lessons, "utf8"));

      const lines = ["<b>Evolution Report</b>"];
      lines.push(`  Threshold Evolution: <b>${thresholdEnabled ? "ON" : "OFF"}</b>`);
      lines.push(`  Signal Weights (Darwin): <b>${config.darwin?.enabled ? "ON" : "OFF"}</b>`);
      lines.push(`  ML Training: <b>${config.ml?.enabled ? "ON" : "OFF"}</b>`);

      if (thresholdEnabled) {
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          lines.push("");
          lines.push("No threshold changes needed.");
        } else {
          reloadScreeningThresholds();
          lines.push("");
          lines.push("<b>Thresholds Evolved</b>");
          for (const [k, v] of Object.entries(result.changes)) {
            lines.push(`  • <code>${k}</code>: ${v}`);
          }
          for (const [k, v] of Object.entries(result.rationale || {})) {
            lines.push(`  <i>${k}: ${v}</i>`);
          }
          lines.push("");
          lines.push("Saved to user-config.json and applied.");
        }
      } else {
        lines.push("");
        lines.push("Threshold evolution is paused. Use /thresholdevolve to re-enable.");
      }

      await sendHTML(lines.join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/thresholdevolve" || text === "/threshold-evolve" || text === "/threshold-evolution") {
    const current = config.management.thresholdEvolveEnabled !== false;
    const next = !current;
    await executeTool("update_config", {
      changes: { thresholdEvolveEnabled: next },
      reason: "Telegram slash command /thresholdevolve",
    });
    config.management.thresholdEvolveEnabled = next;
    const status = next
      ? "<b>ON</b> — threshold evolution (TVL/MC/%TP/%SL) is active"
      : "<b>OFF</b> — threshold evolution paused, Darwin + ML still running";
    await sendMessage(`Threshold Evolution: ${status}`).catch(() => {});
    return;
  }

  if (/^\/mlpersonality\s+/i.test(text)) {
    try {
      const desired = text.replace(/^\/mlpersonality\s+/i, "").trim().toLowerCase();
      const { setActive, list } = await import("./ml/personalities.js");
      setActive(desired);
      await executeTool("update_config", {
        changes: { mlPersonality: desired },
        reason: "Telegram slash command /mlpersonality",
      });
      await sendMessage(`✅ ML personality set to ${desired}. Available: ${list().join(", ")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/ml-train" || text === "/mltrain") {
    try {
      const { trainModel, loadTrainingData } = await import("./ml/trainer.js");
      const { getCurrentState } = await import("./ml/emotions.js");
      const mlCfg = config?.ml || {};
      const sampleCount = loadTrainingData().length;
      const result = await trainModel({ config: mlCfg, emotionState: getCurrentState(), force: true });
      if (!result.trained) {
        await sendMessage(`ML training skipped — ${result.reason || "unknown"}\nNeed at least ${mlCfg.minSamples || 10} closed positions (have ${result.sampleCount ?? sampleCount ?? 0}).`).catch(() => {});
        return;
      }
      const finalLossValue = result.finalLoss?.loss ?? result.finalLoss?.total ?? result.finalLoss?.totalLoss ?? result.finalLoss;
      const loss = finalLossValue != null && Number.isFinite(Number(finalLossValue)) ? Number(finalLossValue).toFixed(4) : "N/A";
      const cvAcc = result.cv?.accuracy != null ? `${result.cv.accuracy}%` : "n/a";
      const cvF1 = result.cv?.f1 != null ? result.cv.f1 : "n/a";
      const lines = [
        "<b>🧠 ML Training</b>",
        `Trained on ${result.sampleCount} samples`,
        `Final loss: ${loss}`,
        `K-fold: ${result.folds || result.cv?.foldCount || "n/a"}`,
        `CV accuracy: ${cvAcc}`,
        `CV F1: ${cvF1}`,
        "",
        "Model checkpoint saved to <code>data/ml/ml-model.json</code>.",
      ];
      await sendHTML(lines.join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`ML training failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text.startsWith("/learn")) {
    try {
      const parts = text.split(" ");
      const poolArg = parts[1] || null;
      let poolsToStudy = [];
      if (poolArg) {
        poolsToStudy = [{ pool: poolArg, name: poolArg }];
      } else {
        const { candidates } = await getTopCandidates({ limit: 5 });
        poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
      }
      if (!poolsToStudy.length) {
        await sendMessage("No pools to study. Run /screen first.").catch(() => {});
        return;
      }
      await sendMessage(`Studying top LPers across ${poolsToStudy.length} pools...`).catch(() => {});
      // This is forwarded to the agent loop below — the LLM handles it
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
      return;
    }
    // Fall through to agent loop — don't return
  }

  if (text === "/lessons") {
    try {
      const { listLessons } = await import("./lessons.js");
      const data = listLessons({ limit: 20 });
      if (!data.lessons.length) {
        await sendMessage("No lessons saved yet. Use /learn to generate them.").catch(() => {});
        return;
      }
      const { text: lessonsText, buttons: lessonsBtns } = formatLessons(data.lessons, { limit: 20 });
      await sendMessageWithButtons(lessonsText, lessonsBtns).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/balance") {
    try {
      const wallet = await getWalletBalances();
      const { text: balanceText, buttons: balanceBtns } = formatBalance(wallet, {
        solMode: config.management.solMode === true,
      });
      await sendMessageWithButtons(balanceText, balanceBtns).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/performance") {
    try {
      const { getPerformanceHistory, getPerformanceSummary } = await import("./lessons.js");
      const history = getPerformanceHistory({ hours: 999999, limit: 50 });
      const summary = getPerformanceSummary();
      const { text: perfText, buttons: perfBtns } = formatPerformance(summary, history, { limit: 5 });
      await sendMessageWithButtons(perfText, perfBtns).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screening-stats" || text === "/screeningstats") {
    try {
      const snapshots = readScreeningSnapshots(new Date(), 200);
      const summary = summarizeScreeningSnapshots(snapshots);
      const lines = [
        "<b>📊 Screening Stats (today, UTC)</b>",
        `Cycles: <code>${summary.cycles}</code>`,
        `Total screened: <code>${summary.total_screened}</code>`,
        `Total eligible: <code>${summary.total_eligible}</code>`,
        `Bot-tracked injected: <code>${summary.bot_tracked_injected}</code>`,
      ];
      if (Object.keys(summary.discovery_timeframes).length) {
        lines.push("");
        lines.push("<b>Timeframes used:</b>");
        for (const [tf, count] of Object.entries(summary.discovery_timeframes)) {
          lines.push(`  • ${tf}: ${count}`);
        }
      }
      if (Object.keys(summary.rejection_counts).length) {
        lines.push("");
        lines.push("<b>Top rejections:</b>");
        const top = Object.entries(summary.rejection_counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8);
        for (const [reason, count] of top) {
          lines.push(`  • ${reason}: ${count}`);
        }
      }
      await sendHTML(lines.join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/stop") {
    await sendMessage("🛑 Shutting down...").catch(() => {});
    await shutdown("telegram command");
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

function buildGmgnFunnelReport(stageCounts, allFiltered = [], { fromStage = 1 } = {}) {
  if (!stageCounts) return null;
  const sc = stageCounts;
  const funnel = `GMGN funnel: ranked=${sc.ranked ?? "?"} → S1=${sc.s1 ?? "?"} → S2=${sc.s2 ?? "?"} → S3=${sc.s3 ?? "?"} → S4=${sc.s4 ?? "?"} → final=${sc.s5 ?? "?"}`;
  const byStage = {};
  for (const f of allFiltered) {
    if (f.stage < fromStage) continue;
    const key = `s${f.stage}`;
    if (!byStage[key]) byStage[key] = [];
    byStage[key].push(`${f.name}: ${f.reason}`);
  }
  const stageLabels = { s2: "S2 info", s3: "S3 pool", s4: "S4 indicators", s5: "S5 pick" };
  const details = Object.entries(byStage)
    .map(([key, items]) => `${stageLabels[key] || key}:\n${items.map(r => `  • ${r}`).join("\n")}`)
    .join("\n");
  return details ? `${funnel}\n\n${details}` : funnel;
}

// Data-anchored verdict for a single candidate. Used to surface the real
// hard-filter state alongside the LLM's narrative so the operator can
// spot when the LLM invents a reason that doesn't match the config.
function formatHardFilterVerdict({ pool, sw, n, ti } = {}) {
  if (!pool) return "(no pool data)";
  const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio;
  const feeTvlPass = Number.isFinite(feeTvl) && feeTvl >= config.screening.minFeeActiveTvlRatio;
  const tvl = pool.tvl ?? pool.active_tvl;
  const tvlPass = Number.isFinite(tvl) && tvl >= config.screening.minTvl && tvl <= config.screening.maxTvl;
  const organic = pool.organic_score;
  const organicPass = Number.isFinite(organic) && organic >= config.screening.minOrganic;
  const botPct = ti?.audit?.bot_holders_pct;
  const botPass = botPct == null || botPct <= config.screening.maxBotHoldersPct;
  const top10Pct = ti?.audit?.top_holders_pct;
  const top10Pass = top10Pct == null || top10Pct <= config.screening.maxTop10Pct;
  const swCount = sw?.in_pool?.length ?? pool.gmgn_smart_wallets ?? 0;
  const hasNarrative = !!n?.narrative;
  const launchpad = ti?.launchpad;
  const launchpadPass = launchpad == null
    || (config.screening.allowedLaunchpads?.length === 0 || config.screening.allowedLaunchpads.includes(launchpad))
    || (config.screening.blockedLaunchpads?.length === 0 || !config.screening.blockedLaunchpads.includes(launchpad));
  const rows = [
    ["name", pool.name, true],
    ["fee/aTVL", `${feeTvl ?? "?"}% (min ${config.screening.minFeeActiveTvlRatio}%)`, feeTvlPass],
    ["tvl", `$${tvl ?? "?"} (range $${config.screening.minTvl}-$${config.screening.maxTvl})`, tvlPass],
    ["organic", `${organic ?? "?"} (min ${config.screening.minOrganic})`, organicPass],
    ["bot holders", `${botPct ?? "?"}% (max ${config.screening.maxBotHoldersPct}%)`, botPass],
    ["top10", `${top10Pct ?? "?"}% (max ${config.screening.maxTop10Pct}%)`, top10Pass],
    ["launchpad", launchpad ?? "(none)", launchpadPass],
    ["smart wallets", String(swCount), swCount > 0 || hasNarrative],
    ["narrative", n?.narrative?.slice(0, 80) || "(none)", hasNarrative],
  ];
  return rows.map(([k, v, ok]) => `  ${ok ? "✓" : "✗"} ${k}: ${v}`).join("\n");
}

// Cross-check the LLM's NO DEPLOY narrative against the actual data + config.
// Returns a list of human-readable warnings, e.g.:
//   - "Cited threshold 2% but config minFeeActiveTvlRatio is 0.015%"
//   - "Cited pool fee/aTVL 0% but pool block shows 0.04%"
function checkLlmNarrativeAgainstData(llmText, passing, cfg) {
  const warnings = new Set();
  if (!llmText || !passing?.length) return [];
  const feeTvlCitations = findPercentCitations(llmText, "fee");
  const thresholdCitation = llmText.match(/minimum[^.\n]{0,40}?(\d+(?:\.\d+)?)\s*%/i)
    || llmText.match(/threshold[^.\n]{0,40}?(\d+(?:\.\d+)?)\s*%/i)
    || llmText.match(/required[^.\n]{0,40}?(\d+(?:\.\d+)?)\s*%/i);

  if (thresholdCitation) {
    const cited = Number(thresholdCitation[1]);
    const actual = Number(cfg.screening.minFeeActiveTvlRatio);
    if (Number.isFinite(cited) && Number.isFinite(actual) && Math.abs(cited - actual) > 0.001) {
      warnings.add(`Cited fee/TVL threshold ${cited}% but config minFeeActiveTvlRatio is ${actual}%`);
    }
  }

  for (const { value } of feeTvlCitations) {
    const cited = Number(value);
    if (!Number.isFinite(cited)) continue;
    if (cited === 0) {
      const nonzero = passing.find((e) => {
        const v = e.pool?.fee_active_tvl_ratio ?? e.pool?.fee_tvl_ratio;
        return Number.isFinite(v) && v > 0;
      });
      if (nonzero) {
        warnings.add(`Cited fee/aTVL 0% for ${nonzero.pool.name} but pool block shows ${nonzero.pool.fee_active_tvl_ratio ?? nonzero.pool.fee_tvl_ratio}%`);
      }
    }
  }

  return [...warnings];
}

// Find percent citations in the LLM text. Looks for "field context ... 0.04%" patterns.
function findPercentCitations(text, fieldRegex) {
  const citations = [];
  const re = new RegExp(`(${fieldRegex})[^.\n]{0,60}?(\\d+(?:\\.\\d+)?)\\s*%`, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    citations.push({ value: m[2], fieldContext: m[1] });
  }
  return citations;
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const smartWalletCount = Math.max(sw?.in_pool?.length ?? 0, Number(pool.gmgn_smart_wallets ?? 0) || 0);
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);
  if (pool.is_wash) return "wash trading was flagged";
  if (pool.is_rugpull && smartWalletCount === 0) return "rugpull risk was flagged and no smart wallets offset it";
  if (pool.is_pvp && smartWalletCount === 0) return "PVP symbol conflict and no smart-wallet confirmation";
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }
  if (!hasNarrative && smartWalletCount === 0) return "only candidate has no narrative and no smart-wallet confirmation";
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  const defaultBins = config.strategy.defaultBinsBelow ?? Math.round((lo + hi) / 2);
  // When volatility is missing (e.g. 30m+ timeframe data, or token too new),
  // use the user's defaultBinsBelow as a reasonable fallback. This is safer
  // than throwing — it lets the deploy proceed with a middle-of-range bin
  // count, and the position can be re-tuned if volatility becomes available
  // on a later refresh.
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    return Math.max(lo, Math.min(hi, defaultBins));
  }
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

async function syncMlPersonalityFromConfig() {
  try {
    const desired = config?.ml?.personality;
    if (!desired) return false;
    const { getActive, setActive } = await import("./ml/personalities.js");
    const active = getActive();
    if (active?.name !== desired) {
      setActive(desired);
      return true;
    }
  } catch {}
  return false;
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// Shared candidate enrichment + filter pipeline. Used by:
//  - runScreeningCycle() (cron path, builds LLM context)
//  - runDeterministicScreen() (manual /screen, fills latestCandidates cache)
// Returns { passing, filteredOut, gmgnStageCounts, gmgnAllFiltered, topCandidates, candidates, allCandidates }.
// `passing` is the list of {pool, sw, n, ti, mem, study} blocks that survived all hard filters.
async function enrichAndFilterCandidates({ limit = 10, liveMessage = null } = {}) {
  await liveStage(liveMessage, "filtering");
  const topCandidates = await getTopCandidates({ limit }).catch((e) => ({ _error: e.message }));
  if (topCandidates?._error) {
    return { error: topCandidates._error };
  }
  const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, limit);
  const gmgnStageCounts = topCandidates?.stage_counts ?? null;
  const gmgnAllFiltered = topCandidates?.all_filtered ?? [];

  await liveStage(liveMessage, "enriching");
  const allCandidates = [];
  const BATCH_SIZE = 2;
  const STAGGER_MS = 120;
  const BATCH_PAUSE_MS = 120;
  // Agent Meridian study endpoint now responds in ~3s on average with occasional
  // 5-6s spikes. The old 3000ms cap caused every study to time out by 11ms and
  // log a fallback warning per pool. Bump to 8000ms (safety margin 2-3x) so the
  // study data is actually used.
  const SMART_WALLET_TIMEOUT_MS = 3500;
  const NARRATIVE_TIMEOUT_MS = 1500;
  const TOKEN_INFO_TIMEOUT_MS = 2000;
  const STUDY_TIMEOUT_MS = 8000;
  const studySkipped = _studySkipUntil > Date.now();
  if (studySkipped) {
    log("screening", `LP study circuit open (${Math.round((_studySkipUntil - Date.now()) / 1000)}s left) — skipping studies this cycle`);
  }
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (pool, j) => {
        if (j > 0) await sleep(STAGGER_MS);
        const mint = pool.base?.mint;
        const [smartWallets, narrative, tokenInfo, study] = await Promise.allSettled([
          withTimeout(
            checkSmartWalletsOnPool({ pool_address: pool.pool }).catch(() => null),
            SMART_WALLET_TIMEOUT_MS,
          ),
          mint
            ? withTimeout(getTokenNarrative({ mint }).catch(() => null), NARRATIVE_TIMEOUT_MS)
            : Promise.resolve(null),
          mint
            ? withTimeout(getTokenInfo({ query: mint }).catch(() => null), TOKEN_INFO_TIMEOUT_MS)
            : Promise.resolve(null),
          studySkipped
            ? Promise.resolve(null)
            : withTimeout(
                studyTopLPers({ pool_address: pool.pool, limit: 3 }).catch(() => null),
                STUDY_TIMEOUT_MS,
              ),
        ]);

        const swValue = smartWallets.status === "fulfilled" ? smartWallets.value : null;
        const narrativeValue = narrative.status === "fulfilled" ? narrative.value : null;
        const tokenInfoValue = tokenInfo.status === "fulfilled" ? tokenInfo.value : null;
        const studyValue = study.status === "fulfilled" ? study.value : null;

        if (!studySkipped && study.status === "fulfilled" && study.value == null) {
          log("screening", `Study timeout: ${pool.name} exceeded ${STUDY_TIMEOUT_MS}ms — continuing without LP study`);
          _studyFailStreak += 1;
          // Two consecutive timeouts = the study API is slow/down, not a blip.
          // Open the circuit for 10 min instead of eating 8s per candidate.
          if (_studyFailStreak >= 2 && _studySkipUntil <= Date.now()) {
            _studySkipUntil = Date.now() + 10 * 60 * 1000;
            log("screening", "LP study circuit opened for 10 min after consecutive timeouts");
          }
        } else if (!studySkipped && study.status === "fulfilled" && study.value != null) {
          _studyFailStreak = 0;
        }
        if (tokenInfo.status === "fulfilled" && tokenInfo.value == null) {
          log("screening", `Token info timeout: ${pool.name} exceeded ${TOKEN_INFO_TIMEOUT_MS}ms — continuing with partial data`);
        }
        if (narrative.status === "fulfilled" && narrative.value == null) {
          log("screening", `Narrative timeout: ${pool.name} exceeded ${NARRATIVE_TIMEOUT_MS}ms — continuing without narrative`);
        }
        if (smartWallets.status === "fulfilled" && smartWallets.value == null) {
          log("screening", `Smart-wallet timeout: ${pool.name} exceeded ${SMART_WALLET_TIMEOUT_MS}ms — continuing without smart-wallet signal`);
        }

        return {
          pool,
          sw: swValue,
          n: narrativeValue,
          ti: tokenInfoValue?.results?.[0] || null,
          mem: recallForPool(pool.pool),
          study: studyValue,
        };
      })
    );
    allCandidates.push(...batchResults);
    if (i + BATCH_SIZE < candidates.length) {
      await sleep(BATCH_PAUSE_MS);
    }
  }

  // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
  const filteredOut = [];
  const passing = allCandidates.filter(({ pool, ti }) => {
    if (pool.gmgn) return true;
    const launchpad = ti?.launchpad ?? null;
    if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
      log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
      filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
      return false;
    }
    if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
      log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
      filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
      return false;
    }
    const botPct = ti?.audit?.bot_holders_pct;
    const maxBotHoldersPct = config.screening.maxBotHoldersPct;
    if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
      log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
      filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
      return false;
    }
    return true;
  });

  return { passing, filteredOut, gmgnStageCounts, gmgnAllFiltered, topCandidates, candidates, allCandidates };
}

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds (REPL only)
  safeSetInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${getDeployAmount()} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /screen        Refresh deterministic candidate list
  /candidates    Refresh deterministic candidate list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /thresholdevolve Toggle threshold evolution (TVL/MC/%TP/%SL) on/off
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${getDeployAmount()} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${getDeployAmount()} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates and deploy only if a candidate is clearly worth it. If there is only one weak candidate, report NO DEPLOY. For a valid deploy, use amount_y=${getDeployAmount()}, amount_x=0, bins_above=0, and bins_below from positive volatility. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const { formatWalletStatusPlain } = await import("./utils/telegram-formatter.js");
        const { getCurrentState } = await import("./ml/emotions.js");
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        const out = formatWalletStatusPlain({ wallet, positions, ml: getCurrentState(), config, runtimeMode: "repl" });
        console.log("\n" + out.text);
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const { PATHS } = await import("./utils/paths.js");
        const lessonsData = JSON.parse(fs.default.readFileSync(PATHS.lessons, "utf8"));
        const thresholdEnabled = config.management.thresholdEvolveEnabled !== false;

        console.log(`\nEvolution Report:`);
        console.log(`  Threshold Evolution (TVL/MC/%TP/%SL): ${thresholdEnabled ? "ON" : "OFF"}`);
        console.log(`  Signal Weights (Darwin): ${config.darwin?.enabled ? "ON" : "OFF"}`);
        console.log(`  ML Training: ${config.ml?.enabled ? "ON" : "OFF"}`);

        if (!thresholdEnabled) {
          console.log(`\nThreshold evolution is paused. Use /thresholdevolve to re-enable.\n`);
          return;
        }

        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    if (input === "/thresholdevolve" || input === "/threshold-evolve") {
      const current = config.management.thresholdEvolveEnabled !== false;
      const next = !current;
      await executeTool("update_config", {
        changes: { thresholdEvolveEnabled: next },
        reason: "CLI /thresholdevolve",
      });
      config.management.thresholdEvolveEnabled = next;
      const status = next
        ? "ON — threshold evolution (TVL/MC/%TP/%SL) is active"
        : "OFF — threshold evolution paused, Darwin + ML still running";
      console.log(`\nThreshold Evolution: ${status}\n`);
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
