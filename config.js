import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PATHS } from "./utils/paths.js";

const USER_CONFIG_PATH = PATHS.userConfig;
const GMGN_CONFIG_PATH = path.join(PATHS.data, "gmgn-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : {};
}

const u = readJsonIfExists(USER_CONFIG_PATH);
const gmgnUserConfig = readJsonIfExists(GMGN_CONFIG_PATH);

// Floor for bins_below on deploy. Default 35 (matches the documented
// safety guardrail for typical meme-coin volatility + 80-125 bin_step).
// Overridable via user-config.json → "minSafeBinsBelow" (or the legacy
// "binsFloor" alias). Lower values are allowed (e.g. 25) but increase
// the chance of going OOR during normal price wicks — tune with care.
export const MIN_SAFE_BINS_BELOW = numericConfig(u.minSafeBinsBelow ?? u.binsFloor) ?? 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

const indicatorUserConfig = u.chartIndicators ?? {};

function gmgnValue(key, legacyKey, fallback) {
  return gmgnUserConfig[key] ?? u[legacyKey] ?? fallback;
}

function gmgnArray(key, legacyKey, fallback) {
  if (Array.isArray(gmgnUserConfig[key])) return gmgnUserConfig[key];
  if (Array.isArray(u[legacyKey])) return u[legacyKey];
  return fallback;
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // Mutable runtime view of MIN_SAFE_BINS_BELOW. The const below
  // captures the module-load default; this property gets refreshed
  // by reloadScreeningThresholds() when the user changes the override.
  // Deploy code reads config.minSafeBinsBelow (dynamic) not the const.
  minSafeBinsBelow: numericConfig(u.minSafeBinsBelow ?? u.binsFloor) ?? 35,
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    source:            u.screeningSource    ?? "meteora", // meteora | gmgn
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? true,   // default ON: swap base token portion of claimed fees to SOL
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    autoSwapMinUsdFloor:   u.autoSwapMinUsdFloor   ?? 0.10, // skip swap when base token USD value is below this
    walletSweepIntervalSec: u.walletSweepIntervalSec ?? 180, // 3min: how often to scan the wallet for stray base tokens to sweep
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // minimum drop from peak to close
    // Ratchet: effective drop = max(trailingDropPct, peak_pnl_pct * trailingRetracePct).
    // Small winners lock tight; big winners get room to keep compounding fees.
    trailingRetracePct:    u.trailingRetracePct    ?? 0.3,
    // Price below the entire range = position fully converted to base token with
    // zero fee income — pure directional bag. Exit much faster than the generic
    // outOfRangeWaitMinutes (which mainly handles the pumped-above case).
    belowRangeExitMinutes: u.belowRangeExitMinutes ?? 10,
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    // Auto-threshold evolution (takeProfitPct, stopLossPct, etc. from perf data)
    evolveEnabled:         u.evolveEnabled         ?? true,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
    // Adaptive override: for young volatile tokens (2-12h old, vol >= 5),
    // the screening auto-deploy flips the strategy to "spot" for safer
    // price discovery. Default OFF (true) — always use the configured
    // strategy. Set disableAdaptiveOverride: false in user-config.json
    // to re-enable the override, or tune the thresholds below.
    disableAdaptiveOverride: u.disableAdaptiveOverride ?? true,
    adaptiveMinAgeHours:  u.adaptiveMinAgeHours  ?? 2,
    adaptiveMaxAgeHours:  u.adaptiveMaxAgeHours  ?? 12,
    adaptiveMinVolatility: u.adaptiveMinVolatility ?? 5,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── Degen Score Targets ─────────────────
  // Used by the new geometric-mean pool scoring in tools/screening.js.
  // Inputs are normalized to a fixed 30m reference window inside the scorer,
  // so these targets are timeframe-independent.
  opportunity: {
    targetVolRatio:    Number(u.degenTargetVolRatio    ?? 20),    // (30m) volume/active_tvl for full trading sub-score
    targetLpCount:     Number(u.degenTargetLpCount     ?? 40),    // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio:    Number(u.degenTargetFeeRatio    ?? 0.20),  // (30m) fee/active_tvl for full fee sub-score
    targetLiquidity:   Number(u.degenTargetLiquidity   ?? 20000), // active_tvl ($) floor for full liquidity sub-score (not timeframe-scaled)
  },

  // ─── GMGN Configuration ────────────────
  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    interval: gmgnValue("interval", "gmgnInterval", "5m"),
    orderBy: gmgnValue("orderBy", "gmgnOrderBy", "default"),
    direction: gmgnValue("direction", "gmgnDirection", "desc"),
    limit: gmgnValue("limit", "gmgnLimit", 100),
    enrichLimit: gmgnValue("enrichLimit", "gmgnEnrichLimit", 20),
    requestDelayMs: gmgnValue("requestDelayMs", "gmgnRequestDelayMs", 350),
    maxRetries: gmgnValue("maxRetries", "gmgnMaxRetries", 2),
    holdersLimit: gmgnValue("holdersLimit", "gmgnHoldersLimit", 100),
    klineResolution: gmgnValue("klineResolution", "gmgnKlineResolution", "5m"),
    klineLookbackMinutes: gmgnValue("klineLookbackMinutes", "gmgnKlineLookbackMinutes", 60),
    filters: gmgnArray("filters", "gmgnFilters", ["renounced", "frozen", "not_wash_trading"]),
    platforms: gmgnArray("platforms", "gmgnPlatforms", ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
    minMcap: gmgnValue("minMcap", "gmgnMinMcap", u.minMcap ?? 150_000),
    maxMcap: gmgnValue("maxMcap", "gmgnMaxMcap", u.maxMcap ?? 10_000_000),
    minTvl: gmgnValue("minTvl", "gmgnMinTvl", u.minTvl ?? 10_000),
    minVolume: gmgnValue("minVolume", "gmgnMinVolume", 1000),
    minHolders: gmgnValue("minHolders", "gmgnMinHolders", u.minHolders ?? 500),
    minTokenAgeHours: gmgnValue("minTokenAgeHours", "gmgnMinTokenAgeHours", 2),
    maxTokenAgeHours: gmgnValue("maxTokenAgeHours", "gmgnMaxTokenAgeHours", 24 * 7),
    minSmartDegenCount: gmgnValue("minSmartDegenCount", "gmgnMinSmartDegenCount", 1),
    requireKol: gmgnValue("requireKol", "gmgnRequireKol", true),
    minKolCount: gmgnValue("minKolCount", "gmgnMinKolCount", 1),
    maxRugRatio: gmgnValue("maxRugRatio", "gmgnMaxRugRatio", 0.3),
    maxTop10HolderRate: gmgnValue("maxTop10HolderRate", "gmgnMaxTop10HolderRate", 0.5),
    maxBundlerRate: gmgnValue("maxBundlerRate", "gmgnMaxBundlerRate", 0.5),
    maxRatTraderRate: gmgnValue("maxRatTraderRate", "gmgnMaxRatTraderRate", 0.2),
    maxFreshWalletRate: gmgnValue("maxFreshWalletRate", "gmgnMaxFreshWalletRate", 0.2),
    maxDevTeamHoldRate: gmgnValue("maxDevTeamHoldRate", "gmgnMaxDevTeamHoldRate", 0.02),
    // KOL filtering
    preferredKolNames: gmgnArray("preferredKolNames", "gmgnPreferredKolNames", []),
    dumpKolNames: gmgnArray("dumpKolNames", "gmgnDumpKolNames", []),
    dumpKolMinHoldPct: gmgnValue("dumpKolMinHoldPct", "gmgnDumpKolMinHoldPct", 0.5),
    // Indicators
    indicatorFilter: gmgnValue("indicatorFilter", "gmgnIndicatorFilter", false),
    indicatorInterval: gmgnValue("indicatorInterval", "gmgnIndicatorInterval", "15_MINUTE"),
    indicatorRules: gmgnValue("indicatorRules", "gmgnIndicatorRules", {}),
    // Additional risk filters
    maxSniperCount: gmgnValue("maxSniperCount", "gmgnMaxSniperCount", 20),
    maxSniperHoldRate: gmgnValue("maxSniperHoldRate", "gmgnMaxSniperHoldRate", 0.3),
    minTotalFeeSol: gmgnValue("minTotalFeeSol", "gmgnMinTotalFeeSol", 30),
    maxBotDegenRate: gmgnValue("maxBotDegenRate", "gmgnMaxBotDegenRate", 0.4),
    athFilterPct: gmgnValue("athFilterPct", "gmgnAthFilterPct", null),
    // gmgn = use GMGN total_fee for global_fees_sol; jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Automated policy / flow-quality guardrails ────────────────
  policy: {
    enabled:                 u.policyEnabled                 ?? true,
    minFeeVolatilityRatio:   u.policyMinFeeVolatilityRatio   ?? 0.01,
    minVolumePersistence:    u.policyMinVolumePersistence    ?? 1.5,
    toxicFlowPenalty:        u.policyToxicFlowPenalty        ?? 22,
    neutralMinScore:         u.policyNeutralMinScore         ?? 66,
    riskOffMinScore:         u.policyRiskOffMinScore         ?? 76,
    riskOnMinScore:          u.policyRiskOnMinScore          ?? 60,
    shrinkRetryPct:          u.policyShrinkRetryPct          ?? 0.8,
  },

  // ─── Deep Learning / ML ────────────────
  ml: {
    enabled:            u.mlEnabled            ?? false,
    trainEvery:         u.mlTrainEvery         ?? 5,     // retrain every N closes
    minSamples:         u.mlMinSamples         ?? 10,    // min positions before training
    batchSize:          u.mlBatchSize          ?? 16,
    // 5 epochs with patience 5 never converged on ~1k samples; early
    // stopping still cuts training short once validation loss flattens.
    epochs:             u.mlEpochs             ?? 30,
    learningRate:       u.mlLearningRate       ?? 0.001,
    entropyBeta:        u.mlEntropyBeta        ?? 0.02,
    validationSplit:    u.mlValidationSplit    ?? 0.2,
    rewardScale:        u.mlRewardScale        ?? 1.0,
    emotionInfluence:   u.mlEmotionInfluence   ?? 0.3,
    blendLambdaStart:   u.mlBlendLambdaStart   ?? 0.1,
    blendLambdaMax:     u.mlBlendLambdaMax     ?? 0.7,
    blendLambdaGrowth:  u.mlBlendLambdaGrowth  ?? 0.05,
    saveCheckpoints:    u.mlSaveCheckpoints    ?? true,
    personality:        u.mlPersonality        ?? "balanced",
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── PnL fetcher / poller (public infra: RPC + Meteora deposits + Jupiter) ──
  pnl: {
    // Live position value comes from on-chain reads on this RPC.
    // Defaults to the public pump.helius endpoint so the aggressive poller
    // never burns the main RPC_URL or the LPAgent sponsor budget.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://pump.helius-rpc.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    // 10s base — the emergency close cooldown is 90s, so polling faster than
    // ~10s burns CPU (full RPC position decode per tick) without acting faster.
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 10),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const configuredFloor = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const floor    = Math.min(configuredFloor, ceil);
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Centralized threshold schema used by `evolveThresholds()`.
 * Each entry maps a persisted user-config key to:
 *  - section: where the live value lives
 *  - field:   the actual property on that section
 *  - min/max: hard clamp the evolution must respect
 *  - step:    max fractional change per evolution step
 *
 * Only keys listed here can be auto-evolved. The legacy `maxVolatility` /
 * `minFeeTvlRatio` keys are intentionally omitted because the live config
 * uses `minFeeActiveTvlRatio` (and no `maxVolatility` key exists).
 */
export const THRESHOLD_SCHEMA = {
  minFeeActiveTvlRatio: {
    section: "screening",
    field: "minFeeActiveTvlRatio",
    min: 0.01,
    max: 5.0,
    step: 0.2,
    decimals: 3,
  },
  minTvl: {
    section: "screening",
    field: "minTvl",
    min: 1000,
    max: 100_000,
    step: 0.2,
    decimals: 0,
  },
  maxTvl: {
    section: "screening",
    field: "maxTvl",
    min: 50_000,
    max: 2_000_000,
    step: 0.2,
    decimals: 0,
  },
  minVolume: {
    section: "screening",
    field: "minVolume",
    min: 100,
    max: 100_000,
    step: 0.2,
    decimals: 0,
  },
  minOrganic: {
    section: "screening",
    field: "minOrganic",
    min: 30,
    max: 95,
    step: 0.2,
    decimals: 0,
  },
  minQuoteOrganic: {
    section: "screening",
    field: "minQuoteOrganic",
    min: 30,
    max: 95,
    step: 0.2,
    decimals: 0,
  },
  minHolders: {
    section: "screening",
    field: "minHolders",
    min: 100,
    max: 5_000,
    step: 0.2,
    decimals: 0,
  },
  minMcap: {
    section: "screening",
    field: "minMcap",
    min: 50_000,
    max: 1_000_000,
    step: 0.2,
    decimals: 0,
  },
  maxMcap: {
    section: "screening",
    field: "maxMcap",
    min: 1_000_000,
    max: 50_000_000,
    step: 0.2,
    decimals: 0,
  },
  maxBundlePct: {
    section: "screening",
    field: "maxBundlePct",
    min: 5,
    max: 90,
    step: 0.2,
    decimals: 0,
  },
  maxBotHoldersPct: {
    section: "screening",
    field: "maxBotHoldersPct",
    min: 5,
    max: 90,
    step: 0.2,
    decimals: 0,
  },
  maxTop10Pct: {
    section: "screening",
    field: "maxTop10Pct",
    min: 10,
    max: 95,
    step: 0.2,
    decimals: 0,
  },
  takeProfitPct: {
    section: "management",
    field: "takeProfitPct",
    // Floor 6: with trailing TP on, realized winner PnL is censored by the
    // trailing exit, so evolution pushing TP toward the observed winner
    // cluster (~1-2%) is a self-reinforcing collapse, not learning.
    min: 6,
    max: 100,
    step: 0.2,
    decimals: 1,
  },
  stopLossPct: {
    section: "management",
    field: "stopLossPct",
    // Sane band for a fee-harvesting LP book: tighter than -5 whipsaws on
    // normal in-range variance, wider than -20 stops protecting the tail.
    min: -20,
    max: -5,
    step: 0.2,
    decimals: 1,
  },
  outOfRangeWaitMinutes: {
    section: "management",
    field: "outOfRangeWaitMinutes",
    min: 5,
    max: 180,
    step: 0.2,
    decimals: 0,
  },
  minFeePerTvl24h: {
    section: "management",
    field: "minFeePerTvl24h",
    min: 1,
    max: 50,
    step: 0.2,
    decimals: 1,
  },
};

export function getThresholdSpec(persistedKey) {
  return THRESHOLD_SCHEMA[persistedKey] || null;
}

export function listThresholdKeys() {
  return Object.keys(THRESHOLD_SCHEMA);
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    // Refresh the bin floor if the user changed it. Defaults to 35 if absent.
    if (fresh.minSafeBinsBelow != null || fresh.binsFloor != null) {
      const v = numericConfig(fresh.minSafeBinsBelow ?? fresh.binsFloor);
      if (v != null) config.minSafeBinsBelow = v;
    }
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    // Clamp against the MUTABLE floor (config.minSafeBinsBelow, refreshed just
    // above), not the boot-time const — otherwise lowering minSafeBinsBelow at
    // runtime gets silently reverted on the next evolve/reload.
    config.strategy.minBinsBelow = Math.max(config.minSafeBinsBelow ?? MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
