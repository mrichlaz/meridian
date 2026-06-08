# How to check if ML is running

ML is **off by default** in this codebase (since the last config overhaul).
The decision was: keep experimental subsystems opt-in until you have
enough closed-position data to train on (≥10 records by default).

## Quick check

```bash
node cli.js config get | python3 -c "import json,sys; d=json.load(sys.stdin); print('mlEnabled:', d['ml']['enabled'])"
```

If you see `mlEnabled: False`, the screening pipeline is **not** using ML for:
- scoring candidates (pure heuristic)
- emotional context in the screener prompt
- feature staging for future training
- online weight updates after close

## How to enable

```bash
node cli.js config set mlEnabled true
```

Or via the LLM:
```js
update_config({ changes: { mlEnabled: true } })
```

Or by editing `user-config.json`:
```json
{
  "mlEnabled": true
}
```

## What changes when you enable it

1. **Screening prompt** — `getEmotionalPromptContext()` is added with ML
   emotion state (confidence, risk appetite, boredom, curiosity, satisfaction,
   streak). The screener LLM sees this context.

2. **Feature staging** — at the end of every screening cycle, ML features are
   extracted and stored for every candidate that made it through the funnel.
   These features become the training data for future model runs.

3. **After every close** (line in `index.js`):
   - `recordPerformance()` saves the close PnL record
   - if `data.performance.length % trainEvery (5) === 0`, an **online ML update**
     fires via `onlineUpdate()`
   - if `data.performance.length >= minSamples (10)`, a **full retrain** fires
     via `trainModel()` with k-fold cross-validation

4. **Darwin weights** — if `darwinEnabled: true` is also set, Darwinian
   signal weights are recalculated from recent performance.

## What you need to enable ML effectively

ML training needs **enough closed-position data** to be useful. With:
- `< 5` closed positions → training skipped (`MIN_EVOLVE_POSITIONS`)
- `< 10` closed positions → training skipped (`minSamples`)
- `≥ 10` positions → model trained, but quality is still noisy
- `≥ 30` positions → reliable enough to act on Darwinian weight adjustments

If you have very few closed positions, the LLM will see ML context, but the
predictions will be noise. In that state, set:

```json
"mlEnabled": false,
"darwinEnabled": true
```

…or just keep both off until you have data.

## Status command

```bash
node cli.js ml status
```

Shows:
- model generation + sample count
- training data size
- blend λ (how much the screener trusts ML vs heuristic)
- emotion state (confidence, risk appetite, boredom, curiosity, satisfaction)
- personality (active + available)
- config (enabled, trainEvery, minSamples)

## Files involved

- `config.js` — `ml.*` config schema, `THRESHOLD_SCHEMA` keys for ML/Darwin
- `ml/cli.js` — CLI status/train/score/features/emotion/personality/reset
- `ml/features.js` — feature extraction
- `ml/trainer.js` — training loop
- `ml/emotions.js` — emotion state machine
- `ml/personalities.js` — personality presets
- `ml/model.js` — LogisticRegression model
- `ml/inference.js` — scoring + prompt context
- `tools/screening.js` — gates feature staging + scoring on `config.ml.enabled`
- `index.js` — gates training + online update on `config.ml.enabled`

## Telegram wiring (recommended)

For now, the cleanest operator workflow is:

```bash
# Quick state check
node cli.js ml status

# Enable when ready
node cli.js config set mlEnabled true

# Force a training run (if you have enough data)
node cli.js ml train

# Disable again if results are noisy
node cli.js config set mlEnabled false
```

I have not yet wired a Telegram `/ml-status` command — it would mirror
`node cli.js ml status` and is straightforward to add.
