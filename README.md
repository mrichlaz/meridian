# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

**Links:** [Website](https://agentmeridian.xyz) | [Telegram](https://t.me/agentmeridian) | [X](https://x.com/meridian_agent)

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. Every close teaches it something.

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step) and surfaces high-quality opportunities
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously; decides to STAY, CLAIM, or CLOSE based on live data
- **Learns from performance** — studies top LPers in target pools, saves structured lessons, and evolves screening thresholds based on closed position history
- **Optional Discord signals** — listens to LP Army channels for Solana token calls and queues them for screening
- **Telegram control** — full agent chat via Telegram, plus cycle reports, OOR alerts, and inline action buttons
- **Claude Code integration** — run AI-powered screening and management directly from your terminal using Claude Code slash commands

---

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup](#setup)
- [Operating modes](#operating-modes)
  - [Autonomous agent (daemon)](#autonomous-agent-daemon)
  - [Telegram bot](#telegram-bot)
  - [Claude Code terminal](#claude-code-terminal)
  - [CLI (one-shot commands)](#cli-one-shot-commands)
- [Discord listener](#discord-listener)
- [Telegram commands reference](#telegram-commands-reference)
- [CLI command reference](#cli-command-reference)
- [Configuration](#configuration)
- [How it learns](#how-it-learns)
- [HiveMind (cross-agent lessons)](#hivemind-cross-agent-lessons)
- [Architecture](#architecture)
- [Disclaimer](#disclaimer)

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle, the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 30 min | Pool screening — finds and deploys into the best candidate |
| **Management Agent** | Every 10 min | Position management — evaluates each open position and acts |

The agent harness is the runtime wrapper around every autonomous cycle. It gives both main and experimental agents the same control loop: load live state, inject relevant memory, expose only role-appropriate tools, execute tool calls, and return a readable cycle report. Recent decisions are injected back into the system prompt so the agent can answer "why did you deploy?" or "why did you close?" without guessing.

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- OKX Web3 — smart money signals, token risk scoring (free tier; advanced tier requires API key)
- Jupiter API — token audit, mcap, launchpad, price stats (free, used as OKX-free-tier fallback)
- Meteora Pool Discovery API — fee/TVL ratios, volume, organic scores, holder counts

Agents are powered via **OpenRouter** and can be swapped for any compatible model.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/mrichlaz/meridian
cd meridian
npm install
```

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard walks you through creating `.env` (API keys, wallet, RPC, Telegram) and `user-config.json` (risk preset, deploy size, thresholds, models). Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or...
HELIUS_API_KEY=your_helius_key
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional
TELEGRAM_CHAT_ID=                       # auto-filled on first message
DRY_RUN=true                            # set false for live trading
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

Copy config and edit as needed:

```bash
cp user-config.example.json user-config.json
```

See [Configuration](#configuration) for all options.

### 3. Run

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

### Run with PM2

PM2 is the recommended way to keep Meridian alive on a VPS:

```bash
npm install
npm run pm2:start
pm2 save
```

To update an existing PM2 install:

```bash
git pull
npm install
npm run pm2:restart
```

If the process restarts repeatedly after an update, inspect the app error first:

```bash
npm run pm2:logs
```

Most post-update PM2 crashes are app startup errors, commonly from skipping `npm install` after `package-lock.json` changed, starting PM2 from the wrong directory, or missing `.env` / `user-config.json` values. Avoid `nohup`; it runs outside PM2 and can leave Telegram polling in a duplicate unmanaged process.

---

## Operating modes

### Autonomous agent (daemon)

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Show latest cached candidates |
| `/learn` | Study top LPers across all current candidate pools |
| `/learn <pool_address>` | Study top LPers for a specific pool |
| `/thresholds` | Show current screening thresholds + performance stats |
| `/evolve` | Trigger threshold evolution from performance data (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |

You can also chat freely with the agent.

### Telegram bot

The Telegram bot is the main operator interface. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and (for groups) `TELEGRAM_ALLOWED_USER_IDS` in `.env`. Notifications fire automatically for management/screening cycles, deploys, closes, and OOR alerts. The bot also accepts chat-style commands and has inline action buttons for one-tap position management.

Inline security: if `TELEGRAM_CHAT_ID` is unset, inbound Telegram control is ignored. If the chat is a group/supergroup and `TELEGRAM_ALLOWED_USER_IDS` is empty, inbound control is ignored.

See the [Telegram commands reference](#telegram-commands-reference) for the full list.

### Claude Code terminal

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

Available slash commands:

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, reads config, fetches candidates, runs deep research, deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with PnL |
| `/candidates` | Fetch and analyse top pool candidates with smart money signals |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

There are also two specialized Claude Code agents:

- **screener** — pool screening specialist. Invoke when evaluating candidates, analysing token risk, or deciding whether to deploy.
- **manager** — position management specialist. Invoke when reviewing open positions, assessing PnL, claiming fees, or closing positions.

Loop mode runs screening or management on a timer:

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

### CLI (one-shot commands)

The `meridian` CLI gives you direct access to every tool with JSON output — useful for scripting, debugging, or piping into other tools.

```bash
npm install -g .   # install globally (once)
meridian <command> [flags]
```

Or run without installing:

```bash
node cli.js <command> [flags]
```

Top-level commands include `balance`, `positions`, `pnl`, `candidates`, `deploy`, `claim`, `close`, `swap`, `screen`, `manage`, `start`, `lessons`, `pool-memory`, `evolve`, `blacklist`, `performance`, `ml`, and many more. See the [CLI command reference](#cli-command-reference).

**Useful flags:**

| Flag | Effect |
|---|---|
| `--dry-run` | Skip all on-chain transactions |
| `--silent` | Suppress Telegram notifications for this run |

---

## Discord listener

The Discord listener watches configured channels (e.g. LP Army) for Solana token calls and queues them as signals for the screener.

### Setup

```bash
cd discord-listener
npm install
```

Add to your root `.env`:

```env
DISCORD_USER_TOKEN=your_discord_account_token
DISCORD_GUILD_ID=the_server_id
DISCORD_CHANNEL_IDS=channel1,channel2
DISCORD_MIN_FEES_SOL=5
```

> This uses a selfbot (personal account automation, not a bot token). Use responsibly.

### Run

```bash
cd discord-listener
npm start
```

Or in a separate terminal alongside the main agent. Signals are written to `discord-signals.json` and picked up automatically by `/screen` and `node cli.js screen`.

### Signal pipeline

Each incoming token address passes through a pre-check pipeline before being queued:

1. **Dedup** — ignores addresses seen in the last 10 minutes
2. **Blacklist** — rejects blacklisted token mints
3. **Pool resolution** — resolves the address to a Meteora DLMM pool
4. **Rug check** — checks deployer against `deployer-blacklist.json`
5. **Fees check** — rejects pools below `DISCORD_MIN_FEES_SOL`

Signals that pass all checks are queued with status `pending`. The screener picks up pending signals and processes them as priority candidates before running the normal screening cycle.

### Deployer blacklist

Add known rug/farm deployer wallet addresses to `deployer-blacklist.json`:

```json
{
  "_note": "Known farm/rug deployers — add addresses to auto-reject their pools",
  "addresses": [
    "WaLLeTaDDressHere"
  ]
}
```

---

## Telegram commands reference

The bot supports a wide range of commands grouped by category. The help text auto-generated by `/help` is the source of truth, but the highlights are:

### Wallet & portfolio

| Command | Action |
|---|---|
| `/help` | Show grouped help (wallet, screening, config, learning, lifecycle) |
| `/status`, `/wallet` | Wallet + portfolio + risk summary |
| `/balance` | Detailed balance including SPL tokens |
| `/positions` | List open DLMM positions (one card per position with action buttons) |
| `/pool <n>` | Detail card for one position |

### Screening & deploy

| Command | Action |
|---|---|
| `/screen`, `/candidates` | Refresh deterministic candidate list (no deploy) |
| `/autoscreen` | Run full AI screening cycle (may deploy) |
| `/deploy <n>` | Deploy into cached candidate N |

### Position management

| Command | Action |
|---|---|
| `/close <n>` | Close position by index |
| `/closeall` | Close all open positions |
| `/set <n> <note>` | Attach a note to a position |

### Configuration

| Command | Action |
|---|---|
| `/config` | Full config snapshot |
| `/thresholds` | Show current screening thresholds + performance summary |
| `/settings` | Button-driven config menu |
| `/setcfg <key> <value>` | Update persisted config |

### Learning & adaptation

| Command | Action |
|---|---|
| `/learn` | Study top LPers from current pool |
| `/lessons` | Recent saved lessons |
| `/performance` | Win rate / avg PnL / total fees / recent closes |
| `/screening-stats` | Today's screening funnel: cycles, screened, eligible, timeframes, top rejections |
| `/ml-status` | Model generation, blend λ, emotion state, personality |
| `/ml-train` | Force an immediate ML training pass |
| `/evolve` | Manually run threshold evolution |

### HiveMind & lifecycle

| Command | Action |
|---|---|
| `/hive`, `/hive pull` | HiveMind sync status / manual pull |
| `/briefing` | Morning briefing (HTML) |
| `/pause`, `/resume` | Pause / resume cron cycles |
| `/stop` | Shut down the agent |

### Inline buttons

Every Telegram reply has inline buttons where useful. Position cards show `🔗 Pool` (Solscan), `📊 PnL`, `💰 Claim`, `🔒 Close`. Screening reports show `👥 Refresh Candidates`, `📊 Status`, `⚙️ Settings`, `🔄 Force Screen`. The settings menu is fully button-driven.

---

## CLI command reference

Top-level subcommands include:

| Command | What it does |
|---|---|
| `balance` | Wallet SOL and token balances |
| `positions` | All open DLMM positions with range status |
| `pnl <addr>` | Detailed PnL for one position |
| `candidates` | Top pool candidates with full enrichment |
| `pool-detail <addr>` | Detailed pool metrics |
| `active-bin <addr>` | Current active bin and price |
| `search-pools <query>` | Search pools by symbol/name |
| `token-info <mint-or-symbol>` | Token audit, mcap, launchpad, stats |
| `token-holders <mint>` | Holder distribution |
| `deploy <pool> <amount>` | Deploy new position |
| `claim <position>` | Claim fees for a position |
| `close <position>` | Close a position (auto-swaps base to SOL) |
| `swap <from> <to> <amount>` | Swap tokens via Jupiter |
| `screen` | Run one AI screening cycle |
| `manage` | Run one AI management cycle |
| `start` | Start autonomous agent with cron jobs |
| `lessons` | Show all learned lessons and rules |
| `lessons add <text>` | Add a manual lesson |
| `pool-memory <pool>` | Per-pool deploy history and cooldowns |
| `evolve` | Trigger threshold evolution |
| `blacklist list` | List blacklisted tokens |
| `blacklist add --mint <addr> --reason <text>` | Block a token |
| `performance` | Closed position history with PnL |
| `discord-signals` | Pending Discord signals |
| `ml status` / `ml train` / `ml score` | ML inspection/training/scoring |
| `config get` | Dump current config as JSON |
| `config set <key> <value>` | Update a config key |

Every command supports `--dry-run` to skip on-chain transactions.

---

## Configuration

All fields are optional — defaults shown. Edit `user-config.json`.

### Wallet & risk

| Field | Default | Description |
|---|---|---|
| `maxPositions` | `3` | Max simultaneous open positions |
| `maxDeployAmount` | `0.2` | Max SOL per single position (hard cap) |
| `deployAmountSol` | `0.3` | Base deploy size (auto-scaled by `positionSizePct`) |
| `positionSizePct` | `0.4` | Fraction of deployable balance to use per position |
| `gasReserve` | `0.1` | Min SOL kept in wallet for gas |
| `minSolToOpen` | `0.55` | Min wallet SOL required before opening new positions |
| `solMode` | `false` | If true, PnL/balances are reported in SOL instead of USD |

### Screening

| Field | Default | Description |
|---|---|---|
| `screeningSource` | `meteora` | `meteora` (free) or `gmgn` (paid, more fields) |
| `timeframe` | `5m` | Window for fee/TVL and volume. The 5m endpoint often returns 0 pools, so the agent automatically steps up to 15m → 30m → 1h → 4h → 24h if needed. |
| `category` | `trending` | Meteora pool category filter |
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio (in percent) |
| `minTvl` | `10000` | Minimum pool TVL in USD |
| `maxTvl` | `150000` | Maximum pool TVL in USD (filters mega-pools) |
| `minVolume` | `500` | Minimum volume in USD within the timeframe |
| `minOrganic` | `60` | Minimum organic score (0–100) for the base token |
| `minQuoteOrganic` | `60` | Same for the quote token |
| `minHolders` | `500` | Minimum holder count for the base token |
| `minMcap` | `150000` | Minimum market cap in USD |
| `maxMcap` | `10000000` | Maximum market cap in USD |
| `minBinStep` | `80` | Minimum DLMM bin step |
| `maxBinStep` | `125` | Maximum DLMM bin step |
| `minTokenFeesSol` | `30` | Minimum all-time fees paid in SOL (filters bundled/scam tokens) |
| `maxBundlePct` | `30` | Max bundle holding % (OKX advanced-info) |
| `maxBotHoldersPct` | `30` | Max bot holder % |
| `maxTop10Pct` | `60` | Max top-10 holder concentration % |
| `allowedLaunchpads` | `[]` | Allow-list of launchpads (empty = no allow-list) |
| `blockedLaunchpads` | `[]` | Block-list of launchpads (e.g. `["letsbonk.fun", "pump.fun"]`) |
| `minTokenAgeHours` | `null` | Minimum token age in hours (null = no minimum) |
| `maxTokenAgeHours` | `null` | Maximum token age in hours (null = no maximum) |
| `athFilterPct` | `null` | Reject pools where price is above `(100 + value)%` of ATH (e.g. `-20` rejects above 80% of ATH) |
| `excludeHighSupplyConcentration` | `true` | Reject tokens with high single-owner supply |
| `useDiscordSignals` | `false` | Pick up queued Discord signals as priority candidates |
| `discordSignalMode` | `merge` | `merge` (with normal) or `only` (ignore other sources) |
| `avoidPvpSymbols` | `true` | Soft-penalize tokens with rival pools of the same symbol |
| `blockPvpSymbols` | `false` | Hard-filter rival-symbol tokens |

### Management

| Field | Default | Description |
|---|---|---|
| `takeProfitPct` | `5` | Close when PnL ≥ this % |
| `stopLossPct` | `-50` | Close when PnL ≤ this % (set to a smaller magnitude like `-18` for tighter risk) |
| `minFeePerTvl24h` | `7` | Floor for 24h fee/TVL — below this and the position may be closed for low yield |
| `minAgeBeforeYieldCheck` | `60` | Minutes before low-yield close rule is evaluated |
| `outOfRangeBinsToClose` | `10` | Close immediately if active bin is this many bins above upper bin |
| `outOfRangeWaitMinutes` | `30` | Otherwise wait this many minutes OOR before closing |
| `oorCooldownTriggerCount` | `3` | After this many consecutive OOR closes on the same pool, add a cooldown |
| `oorCooldownHours` | `12` | How long the OOR cooldown lasts |
| `repeatDeployCooldownEnabled` | `true` | Cooldown repeated deploys on pools/tokens that just closed unprofitably |
| `repeatDeployCooldownTriggerCount` | `3` | Threshold closes before cooldown kicks in |
| `repeatDeployCooldownHours` | `12` | Cooldown duration |
| `repeatDeployCooldownScope` | `token` | `pool` / `token` / `both` |
| `repeatDeployCooldownMinFeeEarnedPct` | `0` | Don't apply cooldown if the position earned at least this % in fees |
| `minClaimAmount` | `5` | Auto-claim fees when unclaimed amount exceeds this |
| `autoSwapAfterClaim` | `false` | After claim, auto-swap the base token to SOL |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | Activate trailing at this % PnL |
| `trailingDropPct` | `1.5` | Close when PnL drops this much from the peak |
| `pnlSanityMaxDiffPct` | `5` | Reject reported PnL that diverges from derived by more than this |

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `10` | Management cycle frequency in minutes |
| `screeningIntervalMin` | `30` | Screening cycle frequency in minutes |
| `healthCheckIntervalMin` | `60` | Health check frequency in minutes |

### Models

| Field | Default | Description |
|---|---|---|
| `screeningModel` | `openrouter/healer-alpha` | LLM for screening cycles |
| `managementModel` | `openrouter/healer-alpha` | LLM for management cycles |
| `generalModel` | `openrouter/healer-alpha` | LLM for REPL/Telegram chat |
| `temperature` | `0.373` | LLM sampling temperature |
| `maxTokens` | `4096` | LLM max output tokens |
| `maxSteps` | `20` | LLM max ReAct steps per cycle |

### Strategy

| Field | Default | Description |
|---|---|---|
| `strategy` | `bid_ask` | LP strategy: `bid_ask` / `spot` / `curve` |
| `minBinsBelow` | `35` | Min bins below the active bin for deploy range |
| `maxBinsBelow` | `69` | Max bins below the active bin for deploy range |
| `defaultBinsBelow` | `69` | Default bins below when not adjusted for volatility |

### Machine learning (opt-in)

ML is **off by default** because it requires closed-position data to be useful. With fewer than 5 closed positions, training is skipped. With 10+ it runs a k-fold cross-validated training pass. With 30+ it starts to be reliable.

| Field | Default | Description |
|---|---|---|
| `mlEnabled` | `false` | Master switch for ML scoring + emotion context + training |
| `mlTrainEvery` | `5` | Run a full training pass every N closes |
| `mlMinSamples` | `10` | Minimum samples required to train |
| `mlBatchSize` | `16` | Mini-batch size |
| `mlEpochs` | `5` | Training epochs per pass |
| `mlLearningRate` | `0.001` | Optimizer learning rate |
| `mlPersonality` | `balanced` | `conservador` / `balanzed` / `aggressive` / `explorador` / `momentumum` / `survivor` |

### Darwin signal weighting (opt-in)

Darwinian weights adjust each screening signal's influence based on whether winners or losers tend to show that signal.

| Field | Default | Description |
|---|---|---|
| `darwinEnabled` | `true` | Master switch for Darwinian weight adjustment |
| `darwinWindowDays` | `60` | Rolling window in days for performance data |
| `darwinRecalcEvery` | `5` | Recalculate every N closes |
| `darwinBoost` | `1.05` | Multiplier for top-quartile signals |
| `darwinDecay` | `0.95` | Multiplier for bottom-quartile signals |
| `darwinFloor` | `0.3` | Min allowed weight |
| `darwinCeiling` | `2.5` | Max allowed weight |
| `darwinMinSamples` | `10` | Min samples before adjustment |

### HiveMind (cross-agent lessons)

| Field | Default | Description |
|---|---|---|
| `hiveMindUrl` | `https://api.agentmeridian.xyz` | HiveMind server |
| `hiveMindApiKey` | embedded default | Auth key (you can override with your own) |
| `agentId` | auto-generated | Unique agent identifier |
| `hiveMindPullMode` | `auto` | `auto` (pull on cron) or `manual` (only via `/hive pull`) |

### Chart indicators (opt-in)

| Field | Default | Description |
|---|---|---|
| `chartIndicatorsEnabled` | `false` | Master switch |
| `indicatorEntryPreset` | `supertrend_break` | Indicator preset for entry signals |
| `indicatorExitPreset` | `supertrend_break` | Indicator preset for exit signals |
| `rsiLength` | `2` | RSI period |
| `indicatorIntervals` | `["5_MINUTE"]` | Timeframes to check |
| `indicatorCandles` | `298` | Number of candles to load |
| `rsiOversold` | `30` | RSI oversold threshold |
| `rsiOverbought` | `80` | RSI overbought threshold |
| `requireAllIntervals` | `false` | Require all intervals to agree before entry |

### Agent Meridian API (optional)

| Field | Default | Description |
|---|---|---|
| `publicApiKey` | embedded default | Public API key for Agent Meridian's enrichment endpoints |
| `agentMeridianApiUrl` | `https://api.agentmeridian.xyz/api` | Endpoint for server-side enrichment (token risk, clusters) |
| `lpAgentRelayEnabled` | `false` | Use the LP Agent relay for deploy/close transactions (paid service) |

---

## How it learns

Meridian has three learning systems, each at a different timescale:

### Lessons

After every closed position the agent runs `studyTopLPers` on the candidate pools, analyzes on-chain behavior of top performers (hold duration, entry/exit timing, win rates), and saves concrete lessons. Lessons are injected into the system prompt so the agent avoids repeating mistakes and doubles down on what works.

Add a lesson manually:

```bash
node cli.js lessons add "Never deploy into pump.fun tokens under 2h old"
```

### Threshold evolution

After 5+ positions have been closed, run:

```bash
node cli.js evolve
```

This analyzes closed position performance (win rate, avg PnL, fee yields) and automatically adjusts screening thresholds in `user-config.json`. Each change is capped at 20% per step and persisted immediately. Darwinian signal weights are recalculated alongside.

### Structured screening logs

Every screening cycle writes a JSONL line to `data/screening-snapshots/YYYY-MM-DD.jsonl` capturing the funnel state. Use `/screening-stats` in Telegram or `node cli.js config get` to see today's metrics.

---

## HiveMind (cross-agent lessons)

HiveMind sync uses Agent Meridian at `https://api.agentmeridian.xyz` by default. Agents can register, pull shared lessons/presets, and push learning events without a separate registration flow.

### What you get

- Shared lessons from other Meridian agents
- Strategy presets and crowd performance context
- Role-aware lessons injected into future screener/manager prompts when `hiveMindPullMode` is `auto`

### What you share

- Lessons from `lessons.json`
- Closed-position performance events: pool, pool name, base mint, strategy, close reason, PnL, fees, and hold time
- Agent heartbeat metadata: agent ID, version, timestamp, and basic capability flags
- **Private keys and wallet balances are never sent**

### Disable

Set `hiveMindPullMode` to `manual` if you don't want shared lessons and presets pulled automatically. To turn off completely, edit `hivemind.js` to skip `startHiveMindBackgroundSync()`.

---

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info, audit, holders, narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
  chart-indicators.js   Chart indicator preset engine
  bot-tracker.js     Local bot-wallet tracker
  crypto-signals.js   Bot-watched tokens (top trade activity)
  gmgn.js            Optional GMGN source with KOL / smart-degen enrichment
  okx.js             OKX public enrichment endpoints
  agent-meridian.js  Agent Meridian enrichment API helpers

utils/
  paths.js           Resolves data paths (DATA_DIR, /data, repo root fallback)
  runtime-mode.js    CLI/REPL/daemon/telegram runtime guard
  number.js          Number parsing helpers
  telegram-formatter.js   Rich output for both Telegram (HTML) and REPL (plain)
  fetch-json.js      Shared fetch/retry helper with timeout + 429/5xx backoff
  rpc-pool.js         Round-robin Solana RPC connection pool
  position-trend.js   Trend-aware management helpers (fee growth, recovery, drift)
```

### Deploy safety checks

Before `deploy_position` executes, the engine runs:
- Pool threshold validation against fresh pool detail
- TVL min/max checks
- Fee/active-TVL threshold checks (with DLMM API fallback for missing data)
- Positive finite volatility requirement (at least 30m timeframe)
- Bin step range checks
- Minimum safe range width (≥ 35 bins)
- Position count limit + duplicate pool/base-token prevention
- Single-sided SOL deploy enforcement (`amount_x > 0` is rejected)
- SOL balance + gas reserve check
- Launchpad/blacklist filtering upstream

These checks are not weakened without explicit operator instruction.

### Runtime modes

Meridian has a `MERIDIAN_RUNTIME_MODE` env var (`cli` / `repl` / `telegram` / `daemon`) set automatically based on the entry point. Long-lived background timers (cron poller, HIVEMind heartbeat, cache invalidators) are wrapped in `safeSetInterval` which calls `unref()` in CLI mode so one-shot commands exit cleanly. See `utils/runtime-mode.js`.

---

## Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
