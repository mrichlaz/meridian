---
description: Pull on-chain intelligence (holders, narrative, risk) for a pool or token, persist to pool-memory, and explain whether the enrichment profile is bullish/bearish.
argument-hint: [pool_address_or_mint]
---

Fetch and persist enrichment data:

```
!`node cli.js enrich $ARGUMENTS --persist`
```

If the user gave you a token symbol/name instead of an address, look up the mint with `node cli.js token-info "<symbol>"` first and pass the resolved mint.

After getting the result, write a short structured verdict:

- **Holder concentration**: top 10 holders hold X% — flag if >40%
- **Organic score**: X — flag if <30
- **Risk signals**: bundle/sniper/dev-hold percentages — flag any >10%
- **Narrative tags**: list the tags the API returned
- **User flags** I should add based on this data: e.g. `rugpull-suspect` if bundle_pct > 20, `high-concentration` if holders_top10_pct > 50
- **Final verdict**: bullish / neutral / bearish, and whether to deploy

Re-run with `--flags <comma-separated>` and `--tags <comma-separated>` to persist your flags/tags:

```
!`node cli.js enrich $ARGUMENTS --persist --flags "your,flags,here" --tags "watchlist"`
```

Always run the persist command (not `--dry-run`) when the user wants the data saved.