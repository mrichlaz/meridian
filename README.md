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
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

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

The wizard writes **both** files at the repo root:

| Goes in `.env` | Goes in `user-config.json` |
|---|---|
| `WALLET_PRIVATE_KEY`, `OPENROUTER_API_KEY`, `RPC_URL`, `HELIUS_API_KEY` | Risk preset, deploy size, max positions |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | Strategy, screening filters, exit rules, trailing TP |
| `DRY_RUN` | Position sizing, cycle intervals, per-role LLM models, `solMode` |

`TELEGRAM_CHAT_ID` only needs to live in `.env` — setup also copies it to `user-config.json` when provided. Takes about 2 minutes.

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

### Run with PM2 (VPS / always-on)

PM2 is the recommended way to keep Telegram control online on a VPS. **Always start via the ecosystem file** so the working directory and script path stay pinned to the repo:

```bash
npm install
npm run pm2:start    # uses ecosystem.config.cjs — do NOT use "pm2 start index.js"
pm2 save
```

After `.env`, `user-config.json`, or code changes:

```bash
npm run pm2:restart  # re-reads .env on each restart
npm run pm2:logs
```

To update an existing PM2 install:

```bash
git pull
npm install
npm run pm2:restart
pm2 save
```

If a previous PM2 run was started incorrectly, reset it once:

```bash
pm2 delete meridian
npm run pm2:start
pm2 save
```

**PM2 vs `npm start`**

| | `npm start` | PM2 |
|---|---|---|
| Terminal | Interactive REPL | Headless daemon |
| Cron / Telegram | Starts after REPL banner | Starts immediately on boot |
| First screening | On cron schedule | May run one cycle right at startup |
| Best for | Local dev / testing | VPS / 24-7 operation |

On startup, logs show `Repo: ... | cwd: ... | PM2 id: ...`. **Repo and cwd must match.** If they differ, delete the process and use `npm run pm2:start` again.

**Common PM2 issues**

| Symptom | Likely cause | Fix |
|---|---|---|
| Crash loop after `git pull` | `npm install` skipped | `npm install && npm run pm2:restart` |
| Missing wallet / API keys | Started with `pm2 start index.js` from wrong directory | `pm2 delete meridian && npm run pm2:start` |
| `.env` changes ignored | Old PM2 env snapshot | `npm run pm2:restart` (`.env` now overrides stale PM2 env) |
| Telegram `401 Unauthorized` | Invalid `TELEGRAM_BOT_TOKEN` (not chat ID) | Fix token in `.env`; if encrypted, ensure `.envrypt` exists |
| Telegram commands ignored | Missing/wrong `TELEGRAM_CHAT_ID` | Set in `.env` (or `telegramChatId` in `user-config.json`) |
| Duplicate polling / 409 errors | `nohup node index.js` or second PM2 instance running | Kill stray processes; run only one PM2 app |
| Encrypted env crash at boot | `# encrypted` lines without `.envrypt` key | Add `.envrypt` or use plain `.env` values |

Avoid `nohup node index.js` — it runs outside PM2 and can leave a duplicate Telegram poller fighting the managed process.

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

**`screener`** — pool screening specialist. Invoke when you want to evaluate candidates, analyse token risk, or deploy a position. Has access to Jupiter token audit, smart-wallet checks, and all strategy logic.

**`manager`** — position management specialist. Invoke when reviewing open positions, assessing PnL, claiming fees, or closing positions.

To trigger an agent directly, just describe what you want:
```
> screen for new pools and deploy if you find something good
> review all my positions and close anything out of range
> what do you think of the SOL/BONK pool?
```

#### Loop mode

Run screening or management on a timer inside Claude Code:

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

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add to `.env`:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<your chat id>          # .env alone is enough; also saved to user-config by setup
TELEGRAM_ALLOWED_USER_IDS=<user id>    # required for group/supergroup control
```

Meridian does **not** auto-register the first chat for safety — you must set `TELEGRAM_CHAT_ID` explicitly. For groups, also set `TELEGRAM_ALLOWED_USER_IDS` or inbound commands are ignored.

`401 Unauthorized` in logs means a bad `TELEGRAM_BOT_TOKEN` (invalid, revoked, or encrypted without a working `.envrypt` key) — not a chat ID problem.

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Telegram commands

| Command | Action |
|---|---|
| `/help` | Show grouped help (wallet, screening, config, learning, lifecycle) |
| `/status`, `/wallet` | Wallet + portfolio + risk summary |
| `/balance` | Detailed balance including SPL tokens |
| `/positions` | List open DLMM positions (one card per position with action buttons) |
| `/pool <n>` | Detail card for one position |

You can also chat freely via Telegram using the same interface as the REPL. Only allowed user IDs can issue commands in groups.

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
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBotHoldersPct` | `30` | Maximum bot holder % (Jupiter audit) |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per new position |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `stopLossPct` | `-15` | Close position if price drops by this % |
| `takeProfitPct` | `5` | Close when fees earned reach this % of capital |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | Activate trailing TP at this PnL % |
| `trailingDropPct` | `1.5` | Close when PnL drops this % from peak |
| `strategy` | `bid_ask` | LP strategy: `spot`, `bid_ask`, or `curve` |

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

### Jupiter swap fee (referral)

Every token swap the agent makes (auto-swap base→SOL after a close/claim, manual `swap_token`) goes through **Jupiter Ultra**. Jupiter's referral program lets a referral wallet collect a small fee, expressed in **basis points (bps)** — `1 bps = 0.01%`, so `50 bps = 0.5%`. Meridian ships with this enabled by default.

**Settings** (env only — *not* in `user-config.json`):

| Env var | Default | Description |
|---|---|---|
| `JUPITER_REFERRAL_ACCOUNT` | built-in account | A **Jupiter referral account** (not just any wallet). Create one on the Jupiter referral dashboard (`referral.jup.ag`) — it generates a referral account and the per-token fee accounts that actually collect the fee. Paste that referral account address here to collect the fee yourself. |
| `JUPITER_REFERRAL_FEE_BPS` | `50` | Fee in basis points. **Jupiter Ultra requires 50–255 bps** — values outside that range (or `0`) are ignored and the swap runs with no referral fee. |

```bash
# .env — collect the referral fee on your own Jupiter referral account
JUPITER_REFERRAL_ACCOUNT=<your-jupiter-referral-account>
JUPITER_REFERRAL_FEE_BPS=50
```

**To turn the referral off**, just remove/blank it — set `JUPITER_REFERRAL_ACCOUNT=` (empty) **or** `JUPITER_REFERRAL_FEE_BPS=0`. Either one drops the referral and the swap proceeds at Jupiter's normal rate. The referral is also silently dropped if the fee is below `50`, above `255`, or the account isn't a valid Solana address (`tools/wallet.js#getJupiterReferralParams`). **`50` is the minimum Jupiter allows and the Meridian default.**

> If you leave the referral enabled on the **built-in default account**, the fee goes toward **Meridian server maintenance** (HiveMind, Agent Meridian API, hosting). Override `JUPITER_REFERRAL_ACCOUNT` with your own Jupiter referral account to collect it yourself instead, or disable it entirely as above. Either way, on new tokens (<24h) it's the same 0.5% Jupiter charges regardless — so leaving the default on costs you nothing extra there.

> **Why 50 bps is effectively free on new tokens.** Jupiter's own platform fee already varies by pair — and for **new tokens (within 24h of token age) Jupiter charges 50 bps (0.5%)** on its UI regardless. So on those tokens the swap costs the same 0.5% **whether or not you attach a referral** — adding the referral just redirects that fee to your wallet instead of leaving it at Jupiter's default. (Jupiter's full platform-fee schedule: `0` bps buying Jupiter tokens / pegged LST-LST & stable-stable, `2` SOL-stable, `5` LST-stable, `10` everything else, `50` new tokens <24h.)

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

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env (repo-root paths)
repo-root.js        Stable absolute repo path — used by PM2, state files, and .env loading
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js            Position registry (state.json)
decision-log.js     Structured decision log for deploy, close, skip, and no-deploy rationale
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots
strategy-library.js Saved LP strategies
telegram.js         Telegram bot: polling + notifications
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
cli.js              Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper
  screening.js      Pool discovery
  wallet.js         SOL/token balances + Jupiter swap
  token.js          Token info, holders, narrative
  study.js          Top LPer study via LPAgent API

discord-listener/
  index.js          Selfbot Discord listener
  pre-checks.js     Signal pre-check pipeline

.claude/
  agents/
    screener.md     Claude Code screener sub-agent
    manager.md      Claude Code manager sub-agent
  commands/
    screen.md       /screen slash command
    manage.md       /manage slash command
    balance.md      /balance slash command
    positions.md    /positions slash command
    candidates.md   /candidates slash command
    study-pool.md   /study-pool slash command
    pool-ohlcv.md   /pool-ohlcv slash command
    pool-compare.md /pool-compare slash command
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
