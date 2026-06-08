# Agent improvement areas — study note

Source: Meridian repo post-audit on `telegram-rich-formatting` branch.
Status: **discussion only, not implemented**. Use this to decide what to actually build.

---

## TL;DR

These 5 areas all look reasonable on paper, but each has a real failure mode.
The scariest ones are the ones that look "obviously better" but can quietly:

- make the screener too strict → never trade
- make the learning system trust bad data → tune to noise
- make the manager over-engineer exits → close winners early

If you only have time to do a few things, do the ones that **protect** the system, not the ones that **change** the policy.

---

## Read the current code first

Before trusting any of these suggestions, look at the actual files:

- `tools/screening.js` — screener with hard filters, score, conviction floor, volume persistence, adaptive deploy profile
- `tools/dlmm.js` — deploy / claim / close paths, RPC retry, PnL fallback
- `tools/okx.js` — OKX enrichment (advanced-info is 402 paywalled, risk/new is free)
- `index.js` — REPL + cron + Telegram, with `getDeterministicCloseRule()` and `runScreeningCycle()`
- `lessons.js` — performance recording with two existing guards
- `tools/executor.js` — `update_config` map, `executeTool` dispatcher, side-effect handlers
- `pool-memory.js` — per-pool history with cooldowns
- `config.js` — runtime config + `reloadScreeningThresholds()`

The "improvement" suggestions below assume those files behave as the
`AGENTS.md` says. Read the current code first.

---

## Current state summary

What we already did in this session:

- tightened score formula
- added conviction floor
- added volume persistence gate
- added adaptive deploy profile (token age × volatility)
- richer no-deploy decision logs
- RPC 429 retry/backoff for tx submission
- close PnL fallback fix
- staggered timeframe fallback (5m → 15m → 30m → 1h → 2h → 4h → 12h → 24h)
- Jupiter free enrichment for bundle/sniper/top10/bot/dev when OKX 402s
- structured screening output: `discovery_timeframe`, `bot_tracked_injected`, etc.
- `CONFIG_MAP` extended for ML/Darwin toggles
- `unref()` on the cache intervals so CLI exits cleanly

Current screening still produces `total_eligible: 0` often because:
- Meteora 5m endpoint is empty (now fixed via fallback to 1h)
- 15m endpoint is currently 400 (now handled via try/catch)
- bot-tracked tokens have very low TVL → dropped by `minTvl: 10000`
- many pools have `volatility: 0` (newly listed) → unusable

So the funnel is genuinely thin right now. Be careful about adding **more** filters on top of this.

---

## 1. Screening quality

### 1A. Risk bucket / reject reasons

**What it is:**
Tag every pool with `risk_bucket: "hard_reject" | "high_risk" | "preferred"`
and a `rejection_reasons: [...]` list.

**Current state:**
- Hard reject already has reasons pushed to `filteredOut` (see
  `pushFilteredReason()` in `tools/screening.js`).
- The LLM only sees the first 3 reasons in `filtered_examples`.

**What it would actually change:**
- More structured decision logs.
- LLM could theoretically see "high risk but allowed" pools.

**Failure modes:**
- **Slop risk: low.** This is mostly cosmetic and logging.
- **Too strict risk: low.** It's a label, not a filter.

**Cost:** small. ~50 lines in `tools/screening.js` + a bit in
`tools/executor.js` for decision logging.

**Verdict:** **safe**. Worth doing for debugging. Not worth doing for
"win rate improvement" because the screener already filters them out — the
label only changes *what gets logged*, not *what gets through*.

---

### 1B. Volume profile classification

**What it is:**
Add `pool.volume_profile = "burst" | "persistent" | "cooling" | "dead"`
based on 5m/15m/30m/1h comparisons.

**Current state:**
- `hasVolumePersistence()` already does a binary check.
- The bot-tracker path injects 15 pools but they have no `volume_5m` field,
  so persistence check is partially skipped.

**What it would actually change:**
- LLM could see volume profile in the candidate block.
- Could gate the conviction floor on profile (e.g. `burst + low organic → reject`).

**Failure modes:**
- **Slop risk: medium.** If you make "burst" auto-reject without checking
  other signals, you'll kill profitable micro-cap momentum.
- **Too strict risk: medium-high.** Solana meme tokens are inherently
  burst-y. If you reject "burst" categorically, you trade almost nothing.
  The user's recent pools (`Bountywork/SOL`, `SLAB/SOL`, `GACHA/SOL`) would
  have been "burst" at deploy.

**Cost:** small. The label is cheap. The policy on the label is not.

**Verdict:** **only the label, no enforcement**. Do not auto-reject
based on profile. Use as an advisory field the LLM can react to.

---

### 1C. Survivability score

**What it is:**
A second score `survivability_score` combined as:
`final = fee_capture * 0.55 + survivability * 0.45`

**Current state:**
- Single weighted score in `scoreCandidate()`.
- Survivability-adjacent factors are already in the score:
  - volatility penalty
  - PVP penalty
  - ATH penalty
  - concentration penalties

**What it would actually change:**
- Slight reshuffling of the same signals.
- More complex to tune.

**Failure modes:**
- **Slop risk: high.** Adding a "smart" weighted combination to the score
  rarely helps. The current single score is already a heuristic; layering
  another heuristic on top of it makes it harder to debug.
- **Too strict risk: medium.** The combined score will be harsher on
  borderline pools. The conviction floor + basic filters already catch
  bad ones.
- **Real risk:** introducing the 0.55/0.45 weights hardcodes a policy
  decision that should be tunable. If you pick the wrong ratio, you'll
  silently filter out all the small-cap momentum plays.

**Cost:** medium. ~80 lines, plus unit tests for the score function.

**Verdict:** **defer**. The current single score is fine for now. If you
want this later, do it as a configurable `survivabilityWeight` knob in
`user-config.json`, not a hardcoded 0.55.

---

## 2. Management logic

### 2A. Trend-aware exits

**What it is:**
Helpers like `isFeeGrowthDecelerating`, `isRecoveryImproving`,
`isRangeDriftAccelerating` that use pool-memory snapshots.

**Current state:**
- The low-yield close rule already uses two-snapshot fee/PnL trend
  check (this session).
- OOR wait is fixed-time (`outOfRangeWaitMinutes`).
- No fee-growth slope tracking.
- No PnL trend slope tracking.

**What it would actually change:**
- The low-yield close would wait longer if recovery is improving.
- The OOR close would fire faster if range drift is accelerating.
- Both are micro-improvements on the existing close path.

**Failure modes:**
- **Slop risk: low.** Helpers are local and don't change rules.
- **Too strict risk: low.** They only **delay** closes, not force them.

**Cost:** small to medium. ~30 lines per helper + 50 lines integration.

**Verdict:** **worth doing**. Low risk, modest win. Would tighten the
"don't close winners too early" failure mode.

---

### 2B. OOR regime classes

**What it is:**
Classify OOR as `upside_fast | upside_slow | downside_shallow | downside_deep`,
with different wait times per class.

**Current state:**
- OOR upside + bins above `outOfRangeBinsToClose` → close immediately
- OOR + minutes ≥ `outOfRangeWaitMinutes` → close
- No regime distinction.

**What it would actually change:**
- Downside OOR could get a longer wait (re-entry opportunity).
- Upside fast could close faster (don't miss the pump).

**Failure modes:**
- **Slop risk: medium.** Naming four regimes is fine. Actually
  classifying correctly from one bin number and one PnL is not.
- **Too strict risk: medium.** If you make downside OOR wait longer, you
  also keep the position open in a losing trade. That costs gas and
  misses reallocation.

**Cost:** medium. Need snapshot-based bin history (only "current" is
available right now).

**Verdict:** **defer or do minimal version**. The upside/downside split
is genuinely useful. The 4-way split is overkill for current snapshot
granularity.

---

### 2C. Smarter claim logic

**What it is:**
Claim based on `fee amount + position health + close probability + gas`
instead of just `fee >= minClaimAmount`.

**Current state:**
- Simple threshold: `unclaimed_fees_usd >= minClaimAmount`.
- Claim is called by the deterministic close path automatically.
- No close-probability signal.

**What it would actually change:**
- Could claim earlier on positions about to close.
- Could skip claims on positions still going strong.

**Failure modes:**
- **Slop risk: medium.** "Close probability" is not a number we can
  reliably compute. The position is either going to close soon (low yield
  or OOR) or not.
- **Too strict risk: low.** Skipping a claim just means you wait for the
  close path to claim, which is fine.

**Cost:** small. ~40 lines in `getDeterministicCloseRule()`.

**Verdict:** **minimal change only**. Add a "claim before close" hook,
not a full rebalancing of the claim logic.

---

## 3. Learning / performance

### 3A. Performance record validator

**What it is:**
A `validatePerformanceRecord(record)` that rejects obviously bad records
and quarantines them to `performance_rejects.json`.

**Current state:**
- `recordPerformance()` has two existing guards:
  - `suspiciousUnitMix` (e.g. `final_value_usd = 2` for a 2 SOL position)
  - `suspiciousAbsurdClosedPnl` (`pnl_pct <= -90` without stop loss)
- These return early without saving.

**What it would actually change:**
- More rejected records get logged instead of silently dropped.
- A `performance_rejects.json` for debugging.

**Failure modes:**
- **Slop risk: very low.** This is pure validation, no policy change.
- **Too strict risk: low.** Quarantining is non-destructive.

**Cost:** small. ~40 lines, plus a unit test.

**Verdict:** **do it**. This is the safest highest-ROI item. It
protects all future learning.

---

### 3B. Lesson clustering

**What it is:**
Add aggregates by `strategy × volatility_bucket × age_bucket × close_reason`.

**Current state:**
- `lessons.json` is flat: `{ lessons: [...], performance: [...] }`.
- No aggregates.

**What it would actually change:**
- LLM prompt can include "what works in vol 5-8" etc.
- Easier to debug strategies.

**Failure modes:**
- **Slop risk: medium.** Aggregation code paths are easy to over-engineer.
- **Too strict risk: low.** Aggregates are read-only.

**Cost:** small. ~50 lines in `lessons.js`.

**Verdict:** **defer** until you have 20+ closed positions. Aggregates over
small N are noise.

---

### 3C. Safer threshold evolution

**What it is:**
Fix the `evolveThresholds()` function. Currently it references:
- `maxVolatility` (doesn't exist in current `config.screening`)
- `minFeeTvlRatio` (legacy name; current is `minFeeActiveTvlRatio`)

These are silent no-ops. The function pretends to evolve but doesn't.

**Current state:**
- Auto-evolution is enabled but the affected keys are stale.
- User would need to manually set `maxVolatility` / `minFeeTvlRatio` in
  `user-config.json` for the evolution to do anything. They don't exist,
  so the `s.minFeeTvlRatio ?? undefined` line always produces `undefined`.

**What it would actually change:**
- Evolution would actually adjust live config keys.
- BUT — the existing guards in `recordPerformance` already require 5+
  closed positions and a 20% step cap. With current zero performance,
  evolution never runs anyway.

**Failure modes:**
- **Slop risk: low.** It's a real bug fix.
- **Too strict risk: low.** Same step cap (20%) as before.

**Cost:** small. ~30 lines to centralize the schema.

**Verdict:** **do it**. It's a real bug, not a feature. Fix is small and
isolated. Don't pretend auto-evolution works until it does.

---

## 4. Reliability / runtime

### 4A. CLI mode guard

**What it is:**
Set `process.env.MERIDIAN_RUNTIME_MODE` and have all background timers
respect it.

**Current state:**
- I already `unref()`-ed the cache intervals in `tools/dlmm.js`.
- The CLI exits cleanly now.
- Other modules may still have stray `setInterval` calls.

**What it would actually change:**
- Hard guarantee that CLI doesn't hang.
- Better testability of CLI commands.

**Failure modes:**
- **Slop risk: low.** It's a guard rail.
- **Too strict risk: low.**

**Cost:** small. Audit + env var.

**Verdict:** **do it**. Cleanly prevents the "CLI hangs" failure mode we
just fixed.

---

### 4B. Shared fetch/retry helper

**What it is:**
`utils/fetch-json.js` with `fetchJsonWithRetry(url, options)`:
- timeout
- 429 retry
- 5xx retry
- jitter
- structured logging

**Current state:**
- `tools/bot-tracker.js` has its own 429 retry
- `tools/agent-meridian.js` has its own
- `tools/gmgn.js` has its own
- `tools/dlmm.js` has its own
- `tools/okx.js` has minimal handling (throws on `!res.ok`)

**What it would actually change:**
- Uniform 429/5xx behavior.
- Easier to tune timeouts globally.

**Failure modes:**
- **Slop risk: low.**
- **Too strict risk: low.** Defaults should be permissive.

**Cost:** medium. ~80 lines helper + migrate the major callers.

**Verdict:** **do it for screening + management paths first**. Don't
migrate everything at once.

---

### 4C. Structured screening snapshot logs

**What it is:**
`data/screening-snapshots/<date>.jsonl` for per-cycle screening data.

**Current state:**
- `decision-log.json` is mixed (deploy, close, skip, no_deploy).
- No separate "what screening saw" log.

**What it would actually change:**
- Easy to graph screening funnel over time.
- Can analyze "we filtered 90% on TVL this week" without parsing prose.

**Failure modes:**
- **Slop risk: low.** Read-only.
- **Too strict risk: low.**

**Cost:** small. ~30 lines.

**Verdict:** **do it**. Useful for tuning, not for win rate.

---

## 5. Strategy layer

### 5A. Playbook-based strategy selection

**What it is:**
Define `stable_fee_capture`, `momentum_catch`, `avoid` playbooks. Pick one
based on candidate signals, then derive params from playbook.

**Current state:**
- `chooseAdaptiveDeployProfile()` is a small helper that returns
  `binsMultiplier`, `sizeMultiplier`, `strategy` for one pool.
- `strategies/strategy-library.json` has saved strategies.

**What it would actually change:**
- Bigger architectural shift.
- Each deploy gets a "playbook" tag in the decision log.

**Failure modes:**
- **Slop risk: high.** This is the classic "let's be smart about strategy"
  trap. It's easy to add, hard to debug, and the policy it implements is
  implicit.
- **Too strict risk: medium.** If your playbooks don't match the actual
  pool universe, you trade nothing.

**Cost:** high. ~200 lines + config schema.

**Verdict:** **defer**. The current `chooseAdaptiveDeployProfile()` is a
mini version of this and is enough. Full playbooks add complexity without
clear ROI.

---

### 5B. Dynamic size policy

**What it is:**
`size_multiplier = f(conviction, survivability, drawdown, streak)`

**Current state:**
- `computeDeployAmount(walletSol)` uses fixed `positionSizePct`.
- Only adapts to wallet size.

**What it would actually change:**
- Slightly smaller sizes on weak signals.
- Slightly larger sizes on strong signals.

**Failure modes:**
- **Slop risk: medium.** The compounding effect over many trades is
  small; the implementation risk is non-trivial.
- **Too strict risk: medium.** A "drawdown" signal could shrink positions
  after a few bad trades, which would reduce the recovery rate.

**Cost:** medium. ~50 lines + tracking drawdown state.

**Verdict:** **defer**. The current `computeDeployAmount` is fine.

---

### 5C. Regret-aware close review

**What it is:**
After close, look up the pool N hours later. Compute "would have held"
counterfactual. Append to performance record.

**Current state:**
- Performance records close PnL only.
- No "what would have happened" signal.

**What it would actually change:**
- Lessons would include "regret" (over/under close).
- Future evolution could weight by regret.

**Failure modes:**
- **Slop risk: medium.** The counterfactual is "what if I held" — but
  you didn't hold, so the post-close price is a hypothetical.
- **Too strict risk: low.** It only adds data, doesn't change rules.
- **Real risk:** you need a state machine for "this position closed 1h
  ago, fetch current price, append". Errors in that state machine can
  spam your logs.

**Cost:** high. New cron job or queue.

**Verdict:** **defer until you have 30+ closes**. Without enough
performance data, the regret signal is noise.

---

## Strictness vs slop: how to avoid the worst failure modes

The user's concern (paraphrased): "Don't make it so strict it never
trades, and don't make it slop that doesn't help."

### The "never trade" trap

Easy ways to make the screener trade nothing:

1. **Auto-reject "burst" volume profiles** — most meme tokens are burst-y
2. **Combine multiple strict signals** in the conviction floor
3. **Hard-reject on missing data** (e.g. require `bundle_pct` even when OKX 402s)
4. **Survivability score with 0.45 weight** combined with a tight fee/TVL
   floor
5. **OOR regimes with longer wait times** for downside (you keep losing
   positions open)

Each of these looks "defensible" in isolation. Together, they kill
trading.

**Safe rule:** every new filter should have a metric that shows how many
pools it would have rejected in the last 30 days, compared to current.

### The "slop" trap

Easy ways to add slop:

1. **Aggregation by strategy/volume/age** without enough N to be meaningful
2. **Lesson clustering** that adds 200 lines of code but never gets used
3. **Playbook-based strategy** that just renames the current logic
4. **Regret-aware review** that runs but no one looks at the output
5. **Risk bucket labels** that exist but no decision logic uses them

Each of these feels productive. None of them improve win rate on their
own.

**Safe rule:** every new piece of code should be tied to a measurable
behavior change. If you can't point to "this changes what gets traded",
it's slop.

---

## Recommended priority if you do any of this

| # | Item | Verdict | Effort | Why |
|---|---|---|---|---|
| 3A | Performance record validator | **do it** | small | protects all learning |
| 3C | Safer threshold evolution | **do it** | small | fixes a real bug |
| 4A | CLI mode guard | **do it** | small | prevents hang regression |
| 4B | Shared fetch/retry helper | **do partially** | medium | helps screening + management |
| 4C | Structured screening logs | **do it** | small | useful for tuning |
| 2A | Trend-aware exits | **do it** | small/medium | low risk, modest win |
| 1A | Risk bucket labels | **do it** | small | cosmetic, debugging |
| 1B | Volume profile (label only) | **do label only** | small | don't enforce |
| 2C | Claim logic refinement | **minimal change** | small | don't over-engineer |
| 1C | Survivability score | **defer** | medium | slop risk |
| 2B | OOR regime classes | **defer** | medium | snapshot granularity too coarse |
| 3B | Lesson clustering | **defer until N≥30** | small | noise before that |
| 5A | Playbook-based strategy | **defer** | high | architecture change, slop risk |
| 5B | Dynamic size policy | **defer** | medium | small compounding effect |
| 5C | Regret-aware close review | **defer until N≥30** | high | needs enough data |

If you do only 3 things: **3A, 3C, 4A** — they all protect the system
from doing the wrong thing, and they have no policy impact, so no
"never trade" risk.

If you do 5 more, add **2A, 4B, 4C, 1A, 1B (label only)**.

Skip everything else until you have 30+ closed positions and real
performance data. Until then, threshold tuning is just noise.
