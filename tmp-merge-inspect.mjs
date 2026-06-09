import 'dotenv/config';
import { config } from './config.js';
import { getTopCandidates } from './tools/screening.js';

config.screening.source = 'merge';

const result = await getTopCandidates({ limit: 20 });
console.log(JSON.stringify({
  discovery_timeframe: result.discovery_timeframe,
  total_screened: result.total_screened,
  total_eligible: result.total_eligible,
  bot_tracked_injected: result.bot_tracked_injected,
  candidates: (result.candidates || []).slice(0, 10).map((c) => ({
    name: c.name,
    pool: c.pool,
    base_mint: c.base?.mint,
    fee_active_tvl_ratio: c.fee_active_tvl_ratio,
    volume_window: c.volume_window,
    tvl: c.tvl,
    sources: c.sources || null,
    source_tags: c.source_tags || null,
    bot_traded: c.bot_traded || false,
    gmgn: !!c.gmgn,
  })),
  filtered_examples: result.filtered_examples,
}, null, 2));
