# AGENTS.md — Meridian Repository Guide

## Project Overview
Meridian is an autonomous Meteora DLMM liquidity-management agent for Solana. It screens pools, deploys single-sided SOL liquidity, manages/claims/closes positions, records decisions, and learns from closed-position performance.

Primary runtime:
- `index.js` — main entrypoint: REPL, cron orchestration, Telegram polling, screening/management cycles
- `agent.js` — OpenAI/OpenRouter-compatible ReAct loop and role-based tool filtering
- `prompt.js` — dynamic system prompts for `SCREENER`, `MANAGER`, and `GENERAL`
- `config.js` — runtime config from `user-config.json`, `.env`, and defaults
- `tools/executor.js` — tool dispatcher plus safety checks and side effects
- `tools/definitions.js` — OpenAI-format tool schemas exposed to the LLM
- `tools/dlmm.js` — Meteora DLMM SDK wrapper for positions, deploy, close, claim, PnL
- `tools/screening.js` — Meteora/GMGN pool discovery and candidate enrichment
- `tools/token.js` — token info, audit, holders, and narrative lookups
- `state.js` — position registry and lifecycle state
- `lessons.js` — learning/performance history and threshold evolution
- `decision-log.js` — structured rationale log for deploy/close/skip/no-deploy outcomes
- `pool-memory.js` — per-pool history, snapshots, and notes
- `telegram.js` — Telegram bot polling, command/control, and notifications
- `hivemind.js` — Agent Meridian shared lesson/preset sync
- `signal-tracker.js` / `signal-weights.js` — staged deploy signals and Darwinian signal-weight recalculation
- `ml/` — optional ML scoring/training, emotion state, and personality tuning for candidate ranking

Data/config persistence uses `utils/paths.js`:
- `DATA_DIR` if set
- `/data` when present, for deployed persistent volume
- otherwise the local repo root

## Package / Commands
This is a Node.js ESM project (`"type": "module"`) requiring Node 18+ and npm.

Important scripts:
- `npm install` — install deps and run `postinstall` patch script
- `npm run setup` — interactive setup wizard
- `npm run dev` — start in dry-run mode (`DRY_RUN=true node index.js`)
- `npm start` — start the live/autonomous agent (`node index.js`)
- `npm test` or `npm run test:syntax` — syntax-check every JS file with `node --check`
- `npm run test:screen` — run screening test
- `npm run test:agent` — run dry-run agent test
- `npm run pm2:start|pm2:restart|pm2:logs` — PM2 workflows
- `npm run env:encrypt` — encrypt `.env` via `scripts/envrypt.js`

Direct CLI:
- Prefer `node cli.js <command>` from repo root for tool-level checks.
- Examples: `node cli.js balance`, `node cli.js positions`, `node cli.js candidates --limit 5`, `node cli.js screen --dry-run`, `node cli.js manage --dry-run`.
- Supported subcommands include `balance`, `positions`, `pnl`, `candidates`, `token-info`, `token-holders`, `token-narrative`, `pool-detail`, `search-pools`, `crypto-bot-tokens`, `active-bin`, `wallet-positions`, `deploy`, `claim`, `close`, `swap`, `screen`, `manage`, `config`, `study`, `start`, `lessons`, `pool-memory`, `evolve`, `blacklist`, `performance`, `discord-signals`, `withdraw-liquidity`, `add-liquidity`, and `ml`.

## Safety and Secrets
- Never read, print, edit, or commit `.env`, `.env.*`, private keys, API keys, or wallet secrets unless the user explicitly asks for a safe redacted operation.
- Never run live trading commands casually. Use dry-run (`DRY_RUN=true` or `--dry-run`) unless the user explicitly authorizes live action.
- Treat deploy/close/claim/swap/add-liquidity/withdraw-liquidity as financially sensitive operations.
- Avoid background shelling for runtime processes. Use the Pi `process` tool for long-running dev servers, watchers, or logs.
- Check `git status` before editing; this repo may contain user changes. Do not overwrite user modifications without confirmation.

## Code Style Guidelines
- Use descriptive variable names.
- Follow existing ESM import/export style.
- Follow existing patterns in the touched file; avoid broad rewrites.
- Extract complex conditions into meaningful boolean variables.
- Keep operational/safety logic explicit and easy to audit.
- Preserve JSON output compatibility for CLI commands.
- Keep Telegram formatting compatible with existing formatter helpers in `utils/telegram-formatter.js`.

## Architecture Notes

### Agent Roles and Tool Access
`agent.js` defines role-restricted tool sets:
- `SCREENER` — screening/deploy-focused tools
- `MANAGER` — position/PnL/claim/close-focused tools
- `GENERAL` — intent-routed subset of tools for chat/manual commands

When adding a new LLM tool, update all relevant places:
1. `tools/definitions.js` — add the OpenAI-format schema
2. `tools/executor.js` — add implementation to the tool map
3. `agent.js` — add the tool to `SCREENER_TOOLS`, `MANAGER_TOOLS`, or `INTENT_TOOLS` as appropriate
4. If it can mutate on-chain state or config, add/verify safety gating in `tools/executor.js`
5. Add/update CLI support in `cli.js` if the tool should be directly invokable
6. Update README/CLAUDE docs when user-facing behavior changes

### Deploy Safety Checks
Deploy safety is centralized in `tools/executor.js` around `deploy_position`. Existing checks include:
- pool threshold validation against fresh pool detail
- TVL min/max checks
- fee/active-TVL threshold checks, with DLMM fallback for missing discovery API data
- positive, finite volatility requirement using at least a `30m` volatility timeframe
- bin step range checks
- minimum safe range width (`MIN_SAFE_BINS_BELOW`, default 35, overridable via `user-config.json → minSafeBinsBelow` or `binsFloor`)
- max position count and duplicate pool/base-token prevention
- single-sided SOL deploy enforcement (`amount_x > 0` rejected)
- SOL balance plus gas reserve check
- launchpad/blocklist-related filtering upstream

Do not weaken these checks without explicit user instruction.

### Config System
`config.js` reads `user-config.json` and defaults at module load. It also maps selected config fields into environment variables if env vars are absent.

Important sections:
- `risk` — `maxPositions`, `maxDeployAmount`
- `screening` — source, fee/TVL, TVL, volume, organic, holder, market-cap, bin-step, launchpad, age, concentration filters
- `management` — claim, OOR, cooldowns, stop/take profit, trailing take-profit, SOL mode
- `strategy` — strategy plus min/max/default bins below
- `schedule` — management/screening/health intervals
- `gmgn`, `llm`, `api`, `hivemind` — external integrations and model/provider options

Runtime config changes should go through the existing `update_config` tool/CLI path so live config is updated and persisted consistently.

### Runtime Flow
- Startup in `index.js` initializes logging, HiveMind, bot tracking, Telegram, and cron jobs.
- Screening cycles find/enrich candidates, apply memory/lessons/decision context, and may deploy.
- Management cycles inspect positions, PnL, range state, instructions, trailing logic, and may claim/close/redeploy.
- Closing positions records performance in `lessons.js`; decisions are appended to `decision-log.js`; pool snapshots/notes go to `pool-memory.js`.
- `executeTool()` logs each tool call through `logger.js` / `logAction()` and handles post-success side effects such as Telegram notifications, close auto-swaps, and optional claim auto-swaps.

### Learning, Darwin, and ML
- `lessons.js` derives lessons and performance records after closes, guards against suspicious unit-mixed records, and updates pool memory.
- `signal-tracker.js` stages deploy-time signal snapshots in memory so they can be attached to the eventual tracked position.
- `signal-weights.js` recalculates Darwinian weights from recent performance when enough win/loss samples exist; weights are injected into the screener prompt.
- `ml/` provides model training, inference, emotion state, personality modes, and `node cli.js ml ...` commands. ML artifacts live under `PATHS.data/ml`; ML is opt-in by default (`mlEnabled: true` enables it).

### Claude Code Integration
`.claude/` contains project agents and slash commands:
- `.claude/agents/screener.md`
- `.claude/agents/manager.md`
- `.claude/commands/*.md`

If CLI names or workflows change, update these command/agent docs too.

## Common Workflows

### Learn the repo quickly
1. Read `README.md` for product behavior and CLI commands.
2. Read `CLAUDE.md` for architecture details and known issues.
3. Inspect `package.json` for scripts.
4. For tool changes, inspect `tools/definitions.js`, `tools/executor.js`, `agent.js`, and `cli.js`.
5. For runtime changes, inspect `index.js`, `config.js`, `state.js`, and relevant domain module.

### Validate code changes
Run at minimum:
```bash
npm run test:syntax
```
For relevant areas, also run:
```bash
npm run test:screen
npm run test:agent
```
Prefer dry-run modes for anything that could touch trading behavior:
```bash
DRY_RUN=true node index.js
node cli.js screen --dry-run
node cli.js manage --dry-run
```

### PM2 deployment workflow
```bash
git pull
npm install
npm run pm2:restart
npm run pm2:logs
```
If PM2 restarts repeatedly after updates, inspect app logs first. Common causes: skipped `npm install`, wrong working directory, missing `.env`, missing/invalid `user-config.json`, or changed `package-lock.json`.

### Adding a CLI command
1. Add or expose the domain function if needed.
2. Add command parsing/dispatch in `cli.js`.
3. Return stable JSON via the existing `out()` helper.
4. Add help text/SKILL generation entry if user-facing.
5. Add/update README and `.claude/commands` if appropriate.
6. Run `npm run test:syntax`.

## Known Issues / Cautions
- `lessons.js` threshold evolution has historically referenced keys that may not exist or may be named differently in `config.js` (e.g. `maxVolatility`, `minFeeTvlRatio` vs `minFeeActiveTvlRatio`). Verify before relying on evolution changes.
- `utils/paths.js` writes to `DATA_DIR` first, `/data` second, and repo root locally. Be explicit with `DATA_DIR` when testing persistence-sensitive behavior.
- Telegram command/control is security-sensitive. README documents that `TELEGRAM_CHAT_ID` and `TELEGRAM_ALLOWED_USER_IDS` should be set for inbound control.
- User-local files such as `user-config.json`, `state.json`, logs, and data JSON files may represent live trading state. Treat edits as high-risk.
- Some `.claude/commands` docs may drift from actual CLI names over time. Verify against `cli.js` before following them exactly.
