import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "get_crypto_bot_tokens", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note", "enrich_pool_record"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_crypto_bot_tokens", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools", "enrich_pool_record"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist", "enrich_pool_record"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange|sweep|sweep wallet|consolidate|dust)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set\s|change|trailingTrigger|trailingDrop|trailing\b|stopLoss|takeProfit|deployAmount|gasReserve|maxTvl|minTvl|maxMcap|minMcap|positionSize|minBin|maxBin|minFee|maxPositions|cooldown|oor|solMode|pnl)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember|tag this|flag this|annotate)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
// The SDK constructor throws when apiKey is undefined, which would kill the
// whole daemon at import time (cron, Telegram, deterministic close rules —
// none of which need the LLM). Pass a placeholder instead: the first actual
// LLM call fails with a 401 and a message that names the missing env var.
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "MISSING-set-OPENROUTER_API_KEY-or-LLM_API_KEY",
  timeout: 5 * 60 * 1000,
  // Retry transient connection errors (e.g. "Premature close" from MiniMax via
  // OpenRouter) at the SDK level before the app loop ever sees them. The SDK
  // only retries on a narrow set of status codes, so app-level handling below
  // still covers the rest.
  maxRetries: 3,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

function isThinkingModeToolChoiceError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /thinking mode does not support/i.test(message) && /tool_choice/i.test(message);
}

// Detect Claude models by name. Used to apply Claude-specific request quirks:
//   - Anthropic deprecated `temperature` on Sonnet 4.5+, so we must omit it
//   - Anthropic does not accept tool_choice: "required", so we must stay on "auto"
// Model names that flow through an OpenAI-compat proxy are matched as-is,
// e.g. "claude-sonnet-4-5", "anthropic/claude-3-5-sonnet", "claude-opus-4".
function isClaudeModel(model) {
  return /(^|\/)claude/i.test(String(model || ""));
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null, candidatesPreloaded = false, candidateCount = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  // Tools that mutate wallet/state/policy. When `mustUseRealTool` is set, the
  // model must invoke at least one of these before being allowed to emit a
  // final answer — even if other (research) tools were called first. This closes
  // the gap where the model calls only research tools (e.g. get_wallet_balance)
  // and then returns a textual "decision" without ever invoking the action tool.
  const ACTION_TOOL_NAMES = new Set([
    // LP positions
    "deploy_position", "close_position", "claim_fees", "swap_token",
    // Wallet & config
    "update_config", "self_update",
    // Smart wallets
    "add_smart_wallet", "remove_smart_wallet",
    // Lessons
    "add_lesson", "pin_lesson", "unpin_lesson", "clear_lessons",
    // Strategy
    "add_strategy", "remove_strategy", "set_active_strategy",
    // Notes
    "set_position_note", "add_pool_note",
    // Blocklists
    "add_to_blacklist", "remove_from_blacklist",
    "block_deployer", "unblock_deployer",
  ]);
  const firedOnce = new Set();
  // Reversible central guard: block exact duplicate tool calls in the same
  // agent run unless the tool is explicitly allowed to repeat. This does NOT
  // remove tools or change strategy logic; it only prevents wasted turns from
  // re-asking the exact same question or re-attempting the exact same action.
  // Delete/trim this block if you want the old behavior back.
  const repeatedToolCalls = new Set();
  const lastToolCallByName = new Map();
  const REPEATABLE_BUT_NOT_IDENTICAL = new Set([
    "get_top_candidates",
    "search_pools",
    "get_my_positions",
    "get_wallet_balance",
    "get_position_pnl",
    "get_wallet_positions",
  ]);
  // Screener run-state: this is explicit session discipline layered on top of
  // the raw message history. It does not change strategy logic; it only helps
  // the loop understand when enough evidence already exists and when it should
  // stop wandering and produce a final decision.
  const SCREENER_RESEARCH_TOOLS = new Set([
    "check_smart_wallets_on_pool",
    "get_token_holders",
    "get_token_narrative",
    "get_token_info",
    "get_pool_memory",
    "search_pools",
    "get_crypto_bot_tokens",
    "get_active_bin",
  ]);
  // Screening cycles pre-load the candidate set into the goal text, so a
  // no-tool "NO DEPLOY" final answer is legitimate — without this flag the
  // no-tool guard rejects it twice and the cycle fails with a retry message.
  let screenerTopCandidatesLoaded = agentType === "SCREENER" && candidatesPreloaded;
  let screenerCandidateCount = screenerTopCandidatesLoaded ? candidateCount : null;
  const screenerDistinctResearchCalls = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  // Tracks whether ANY mutating (action) tool was invoked this cycle. Distinct
  // from sawToolCall so research-only tool calls don't satisfy an action intent.
  let sawActionToolCall = false;
  let noToolRetryCount = 0;
  // Stays true for the whole run once a thinking-mode provider rejects tool_choice
  let omitToolChoice = false;

  let emptyStreak = 0;
  let lastUsefulToolSummary = null;
  let forcedModel = null;
  let disableToolsForRetry = false;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = forcedModel || model || DEFAULT_MODEL;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      const EMPTY_RESPONSE_FALLBACK = "nvidia/openai/gpt-oss-120b";
      let response;
      let usedModel = activeModel;
      // ACTION_INTENTS captures the LP-action vocabulary; used to drive the
      // step-0 "required" tool forcing when config.llm.toolChoice === "required".
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      // Claude doesn't accept tool_choice="required"; stay on "auto" so we don't
      // trigger an avoidable 400 from the proxy. Fallback models (stepfun,
      // nvidia/gpt-oss) are not Claude so this check is safe for them.
      const claudeMode = isClaudeModel(activeModel);
      // Default: "auto". The model freely chooses tools vs final answers. The
      // `sawActionToolCall` guard + reminder ladder below still enforces that
      // action intents produce a real tool call before a final answer. Set
      // `toolChoice: "required"` in user-config.json → llm to opt back into the
      // strict step-0 tool-forcing behavior for non-Claude models.
      const baseToolChoice = config.llm.toolChoice ?? "auto";
      const strictStep0 = baseToolChoice === "required"
        && step === 0
        && (ACTION_INTENTS.test(goal) || mustUseRealTool);
      let toolChoice = claudeMode ? "auto" : (strictStep0 ? "required" : "auto");
      // Tracks whether the active provider supports tool_choice: "required".
      // First attempt that hits a "required" rejection flips this false and
      // avoids re-logging the same fallback on every subsequent attempt.
      let providerSupportsRequired = true;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Recompute per attempt because `usedModel` can flip to FALLBACK_MODEL
          // after a 502/503/529, and we must keep the request shape consistent
          // with the model family currently in use.
          const requestIsClaude = isClaudeModel(usedModel);
          const reqParams = {
            model: usedModel,
            messages,
            tools: disableToolsForRetry ? undefined : getToolsForRole(agentType, goal),
            // Anthropic deprecated `temperature` on Sonnet 4.5+. Omit it for
            // Claude rather than letting the proxy forward a rejected field.
            ...(requestIsClaude ? {} : { temperature: config.llm.temperature }),
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          };
          if (requestIsClaude && toolChoice === "required") toolChoice = "auto";
          if (disableToolsForRetry) delete reqParams.tools;
          if (!omitToolChoice && !disableToolsForRetry) reqParams.tool_choice = toolChoice;
          // Stream the response so long-running reasoning models (e.g. MiniMax
          // m2.5/m2.7 via OpenRouter) keep the connection alive with continuous
          // bytes. This avoids "Invalid response body ... Premature close"
          // failures where the upstream proxy drops an idle long-generation
          // socket before the full non-streamed body arrives.
          //
          // We use the beta.chat.completions.stream() helper (not
          // create({stream:true})) because it returns a ChatCompletionStream
          // runner whose finalChatCompletion() resolves to a full ChatCompletion
          // object with the same shape as a non-streamed response — so all
          // downstream logic (tool-call parsing, JSON repair, reasoning_content
          // mapping, empty-response handling) is unchanged.
          const stream = client.beta.chat.completions.stream(reqParams);
          // finalChatCompletion() resolves to a full ChatCompletion, or rejects
          // if the stream ended without producing one (surfaced as a normal
          // error to the catch block below).
          response = await stream.finalChatCompletion();
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            // The provider doesn't support tool_choice: "required". Switch
            // to "auto" for the rest of this cycle and remember the fact so
            // we don't log the same fallback on every subsequent attempt.
            toolChoice = "auto";
            if (!providerSupportsRequired) {
              providerSupportsRequired = false;
              log("agent_warn", "Provider does not support tool_choice=required — using tool_choice=auto for this cycle (forcing the LLM to make a tool call on action intents will be best-effort; if the LLM produces text instead, the system rejects the text answer and retries up to 2x)");
            }
            attempt -= 1;
            continue;
          }
          if (!omitToolChoice && isThinkingModeToolChoiceError(error)) {
            omitToolChoice = true;
            log("agent", "Provider thinking mode does not support tool_choice — retrying without it");
            attempt -= 1;
            continue;
          }
          // A model the provider doesn't recognize fails identically on every
          // attempt AND every cycle (e.g. a misconfigured screeningModel →
          // 403 "Model/provider not recognized" → every screening/management
          // cycle dies at step 0 and no deploys/closes ever run). Swap to the
          // fallback model for the rest of this run instead of throwing.
          const rejectionText = String(error?.message || error?.error?.message || "");
          if (
            usedModel !== FALLBACK_MODEL &&
            (error?.status === 400 || error?.status === 403 || error?.status === 404) &&
            /not recognized|not found|does not exist|invalid model|unknown model|no such model|not a valid model|no endpoints found/i.test(rejectionText)
          ) {
            log("agent_warn", `Provider rejected model '${usedModel}' (${error.status}) — switching to fallback ${FALLBACK_MODEL} for this run. Fix llm.*Model in user-config.json (or LLM_MODEL in .env).`);
            usedModel = FALLBACK_MODEL;
            forcedModel = FALLBACK_MODEL;
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      const invalidToolArgErrors = new Map();
      // Keep tool-call history API-valid, but never execute unrecoverable args.
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                const error = `Invalid tool arguments for ${tc.function.name}`;
                invalidToolArgErrors.set(tc.id, error);
                log("error", `${error}: could not repair JSON`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If model output is reasoning-only (content: null, reasoning_content present),
      // use reasoning_content as content so the agent doesn't spin forever.
      if (!msg.content && msg.reasoning_content) {
        // Tool calls need a non-null content for API compatibility
        msg.content = msg.tool_calls?.length ? "Analyzing..." : msg.reasoning_content;
        if (!msg.tool_calls?.length) log("agent", "Mapped reasoning_content → content for final response");
      }

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes / reasoning models sometimes return null content
        if (!msg.content) {
          messages.pop();
          emptyStreak += 1;
          log("agent", `Empty response (${emptyStreak}/3), retrying...`);

          // Screening decisions matter. Do not accept a blank model answer.
          // Retry ladder:
          // 1) empty #1: retry with tools still enabled + stronger reminder
          // 2) empty #2: retry with tools still enabled + fallback model
          // 3) empty #3: retry once without tools, asking for a textual decision
          // 4) empty #4: fail fast so runScreeningCycle uses deterministic fallback
          if (agentType === "SCREENER") {
            if (emptyStreak <= 3 && step < maxSteps - 1) {
              if (emptyStreak === 2) forcedModel = EMPTY_RESPONSE_FALLBACK;
              if (emptyStreak === 3) {
                forcedModel = EMPTY_RESPONSE_FALLBACK;
                omitToolChoice = true;
                disableToolsForRetry = true;
              }
              const stillUseTools = emptyStreak < 3;
              messages.push({
                role: providerMode === "system" ? "system" : "user",
                content: providerMode === "system"
                  ? [
                      `The previous screener response was empty (attempt ${emptyStreak}). Never return blank content.`,
                      stillUseTools
                        ? "Tools are still available and required if deploying: call deploy_position for the best survivor, or return a compact NO DEPLOY report with specific data-grounded reasons."
                        : "Tool calling is being disabled for this retry because prior responses were empty. Return a compact textual DEPLOY recommendation or NO DEPLOY report using the candidate data already in context. Do not call tools. Do not return blank content.",
                    ].join("\n")
                  : [
                      `[SYSTEM REMINDER] Previous screener response was empty (attempt ${emptyStreak}). Never return blank content.`,
                      stillUseTools
                        ? "Tools are still available and required if deploying: call deploy_position for the best survivor, or return a compact NO DEPLOY report with specific data-grounded reasons."
                        : "Tool calling is being disabled for this retry because prior responses were empty. Return a compact textual DEPLOY recommendation or NO DEPLOY report using the candidate data already in context. Do not call tools. Do not return blank content.",
                    ].join("\n"),
              });
              log("agent", `Empty screener response — retry ${emptyStreak}/3 (${stillUseTools ? "tools enabled" : "tools disabled"}${forcedModel ? `, model ${forcedModel}` : ""})`);
              continue;
            }
            throw new Error("LLM empty response after nudged retries");
          }

          if (emptyStreak >= 2 && usedModel !== EMPTY_RESPONSE_FALLBACK) {
            usedModel = EMPTY_RESPONSE_FALLBACK;
            log("agent", `Switching to empty-response fallback model ${EMPTY_RESPONSE_FALLBACK}`);
          }

          // Do not return an empty/max-steps answer on the last allowed step.
          // Some fast providers occasionally return null content for trivial
          // one-step prompts; surface a useful deterministic fallback instead.
          if (emptyStreak >= 3 || step >= maxSteps - 1) {
            const fallback = lastUsefulToolSummary
              ? `The model returned an empty final response, but tool execution completed. Latest tool result:\n${lastUsefulToolSummary}`
              : "The model returned an empty response. No final answer was produced by the provider, but the agent remained responsive. Try again or use a different model if this repeats.";
            log("agent", fallback);
            return { content: fallback, userMessage: goal };
          }
          continue;
        }
        if (
          agentType === "SCREENER" &&
          screenerTopCandidatesLoaded &&
          /\bNO DEPLOY\b/i.test(String(msg.content || ""))
        ) {
          log("agent", "Accepted screener NO DEPLOY final answer after candidate review");
          log("agent", msg.content);
          return { content: msg.content, userMessage: goal };
        }
        if (mustUseRealTool && !sawActionToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          // Bumped cap from 2 to 3: weaker models sometimes need an extra
          // reminder before they convert a textual answer into a real tool call.
          const NO_TOOL_RETRY_CAP = 3;
          // Reminder text enumerates the LP/mutating tools so the model can
          // match the goal to a tool name without guessing. Research-only
          // tools (get_*, list_*, search_*, *_memory, performance, top_lpers,
          // study_*) intentionally do NOT appear here — they cannot satisfy an
          // action intent.
          const LP_ACTION_TOOLS_HINT = "deploy_position, close_position, claim_fees, swap_token, update_config, self_update, add_smart_wallet, remove_smart_wallet, add_lesson, pin_lesson, unpin_lesson, clear_lessons, add_strategy, remove_strategy, set_active_strategy, set_position_note, add_pool_note, add_to_blacklist, remove_from_blacklist, block_deployer, unblock_deployer";
          log("agent", `Rejected no-action-tool final answer (${noToolRetryCount}/${NO_TOOL_RETRY_CAP}) for tool-required request`);
          if (noToolRetryCount >= NO_TOOL_RETRY_CAP) {
            return {
              content: `I couldn't complete that reliably because no mutating tool was called after ${NO_TOOL_RETRY_CAP} nudges. Available LP/mutating tools: ${LP_ACTION_TOOLS_HINT}. Try again or use a different model if this repeats.`,
              userMessage: goal,
            };
          }
          const reminder = providerMode === "system"
            ? (agentType === "SCREENER" && screenerTopCandidatesLoaded
                ? `Reminder: you already have the screened candidate set${screenerCandidateCount != null ? ` (${screenerCandidateCount} candidate(s))` : ""}. You must not answer this from memory or inference. Do exactly one of the following NOW: (1) call deploy_position for the best survivor, (2) return a final NO DEPLOY decision with specific evidence from the candidate data, or (3) call one new distinct research tool only if it will directly change DEPLOY vs NO DEPLOY.`
                : `Reminder: this is an action request that requires real on-chain tool execution or live tool-backed data. You must not answer from memory or inference. Call the matching action tool before producing a final answer. Available LP/mutating tools: ${LP_ACTION_TOOLS_HINT}. Research-only tools (get_*, list_*, search_*) cannot satisfy this request.`)
            : (agentType === "SCREENER" && screenerTopCandidatesLoaded
                ? `[SYSTEM REMINDER]\nYou already have the screened candidate set${screenerCandidateCount != null ? ` (${screenerCandidateCount} candidate(s))` : ""}. You must not answer this from memory or inference. Do exactly one of the following NOW: (1) call deploy_position for the best survivor, (2) return a final NO DEPLOY decision with specific evidence from the candidate data, or (3) call one new distinct research tool only if it will directly change DEPLOY vs NO DEPLOY.`
                : `[SYSTEM REMINDER]\nThis is an action request that requires real on-chain tool execution or live tool-backed data. You must not answer this from memory or inference. Call the matching action tool before producing a final answer. Available LP/mutating tools: ${LP_ACTION_TOOLS_HINT}. Research-only tools (get_*, list_*, search_*) cannot satisfy this request.`);
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: reminder,
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        if (invalidToolArgErrors.has(toolCall.id)) {
          const result = {
            success: false,
            error: invalidToolArgErrors.get(toolCall.id),
            blocked: true,
          };
          await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        }

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            const result = {
              success: false,
              error: `Invalid tool arguments for ${functionName}`,
              blocked: true,
            };
            await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
        }

        const toolSignature = `${functionName}:${JSON.stringify(functionArgs || {})}`;
        const previousSignatureForName = lastToolCallByName.get(functionName);

        // Screener closure guard: once get_top_candidates has already loaded
        // the candidate set, allow at most two distinct follow-up research
        // tools before forcing a decision. This preserves the same logic and
        // toolset, but stops indefinite exploration loops.
        if (
          agentType === "SCREENER" &&
          screenerTopCandidatesLoaded &&
          SCREENER_RESEARCH_TOOLS.has(functionName) &&
          !screenerDistinctResearchCalls.has(toolSignature) &&
          screenerDistinctResearchCalls.size >= 2
        ) {
          const reason = `Candidate set is already loaded and ${screenerDistinctResearchCalls.size} distinct follow-up research call(s) have already been used. Make a final DEPLOY/NO DEPLOY decision now instead of requesting more research.`;
          log("agent", `Blocked extra screener research call: ${toolSignature}`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason }),
          };
        }

        // Reversible central guard: block exact duplicate tool calls across all
        // agent roles unless the tool is explicitly allowed to repeat.
        // Role-specific feedback helps the model recover without changing logic.
        if (
          !ONCE_PER_SESSION.has(functionName) &&
          !REPEATABLE_BUT_NOT_IDENTICAL.has(functionName) &&
          (repeatedToolCalls.has(toolSignature) || previousSignatureForName === toolSignature)
        ) {
          const repeatReason = agentType === "SCREENER"
            ? `${functionName} with the same arguments was already called in this screening run. Use the existing result, choose a different tool, or make a final decision now.`
            : agentType === "MANAGER"
              ? `${functionName} with the same arguments was already called in this management run. Use the existing result and decide the next action instead of repeating the same check.`
              : `${functionName} with the same arguments was already called in this agent run. Use the existing result or choose a different next step.`;
          log("agent", `Blocked duplicate tool call: ${toolSignature}`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: repeatReason },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: repeatReason }),
          };
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        repeatedToolCalls.add(toolSignature);
        lastToolCallByName.set(functionName, toolSignature);
        if (agentType === "SCREENER" && functionName === "get_top_candidates" && result) {
          const candidates = result.candidates || result.pools || [];
          screenerTopCandidatesLoaded = true;
          screenerCandidateCount = Array.isArray(candidates) ? candidates.length : null;
        }
        if (agentType === "SCREENER" && screenerTopCandidatesLoaded && SCREENER_RESEARCH_TOOLS.has(functionName)) {
          screenerDistinctResearchCalls.add(toolSignature);
        }
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);
        // Mark any mutating tool call so the action-intent no-tool guard above
        // can distinguish "researched then answered" from "actually took action".
        // Set on call (not on success) so a safety-blocked deploy still counts
        // as an attempt and prevents an indefinite no-tool retry loop.
        if (ACTION_TOOL_NAMES.has(functionName)) {
          sawActionToolCall = true;
        }

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      const successfulTool = toolResults.find((entry) => {
        try {
          const parsed = JSON.parse(entry.content || "{}");
          return parsed?.ok !== false && parsed?.result != null;
        } catch {
          return false;
        }
      });
      if (successfulTool) {
        try {
          const parsed = JSON.parse(successfulTool.content);
          lastUsefulToolSummary = JSON.stringify(parsed.result).slice(0, 1200);
        } catch {}
      }

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  const fallback = lastUsefulToolSummary
    ? `Max steps reached before a final model answer, but tool execution completed. Latest tool result:\n${lastUsefulToolSummary}`
    : "Max steps reached before a final model answer. No tool result was available.";
  return { content: fallback, userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
