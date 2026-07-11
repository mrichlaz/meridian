---
description: Refresh pool-memory enrichment snapshots for every currently open wallet position.
---

For each open position:

1. Pull current positions + PnL:
```
!`node cli.js positions`
```

2. For each unique pool address (and its base mint), run enrichment:
```
!`node cli.js enrich <pool_address> --persist`
```

3. Then summarize:
- Which open positions have the **highest holder concentration** in their enrichment?
- Which have the **oldest enrichment** (most stale intel)?
- Which have **user_flags** the operator added that should change the management plan?

If the user supplies tags/flags in their request, propagate them to each enrichment call:

```
!`node cli.js enrich <pool_address> --persist --flags "..." --tags "..."`
```

This makes wallet-side intelligence visible to the screener and ML on the next deploy cycle.