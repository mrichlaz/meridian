/**
 * Telegram Rich Formatter
 *
 * Converts agent reports into HTML-formatted messages with inline
 * action buttons. The LLM still generates the text — this module wraps
 * it into structured, readable Telegram messages.
 *
 * Exports:
 *   - formatWalletStatus({...})         → { text, buttons }
 *   - formatPositionCard(position)      → { text, buttons }
 *   - formatPositionPnLCard(position)   → { text, buttons }  (for pnl: callback)
 *   - formatCandidatesList(...)         → string
 *   - formatScreeningReport(...)        → { text, buttons }
 *   - formatManagementReport(...)        → { text, buttons }
 *   - formatDeployResult(...)           → { text, buttons }
 *   - formatCloseResult(...)            → { text, buttons }
 *   - formatClaimResult(...)            → { text, buttons }
 *   - formatPoolDetail(...)             → { text, buttons }
 *   - formatBalance(...)                → { text, buttons }
 *   - formatConfigSnapshot(...)         → { text, buttons }
 *   - formatThresholds(...)             → { text, buttons }
 *   - formatLessons(...)                → { text, buttons }
 *   - formatPerformance(...)             → { text, buttons }
 *   - formatError(...)                  → { text, buttons }
 *   - formatHelp(...)                   → string
 *   - ACTION_BUTTONS                    → reusable button presets
 *   - SOLSCAN_URL                       → "https://solscan.io"
 */

const SOLSCAN_URL = "https://solscan.io";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// ─── HTML escape ─────────────────────────────────────────────────

function esc(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatSol(amount, decimals = 4) {
  if (amount == null || !Number.isFinite(Number(amount))) return "—";
  return `◎${Number(amount).toFixed(decimals)}`;
}

function formatUsd(amount, decimals = 2) {
  if (amount == null || !Number.isFinite(Number(amount))) return "—";
  return `$${Number(amount).toFixed(decimals)}`;
}

function formatPct(pct, signed = true) {
  if (pct == null || !Number.isFinite(Number(pct))) return "—";
  const n = Number(pct);
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function formatRange(n) {
  if (n == null) return "—";
  return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function timeAgo(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function solscanAccountLink(address, label) {
  if (!address) return esc(label || "—");
  return `<a href="${SOLSCAN_URL}/account/${address}">${esc(label || address)}</a>`;
}

// ─── Reusable button presets ─────────────────────────────────────

const ACTION_BUTTONS = {
  /** Position-level actions */
  position(poolAddress, positionAddress) {
    return [
      [
        { text: "🔗 Pool", url: `${SOLSCAN_URL}/account/${poolAddress}` },
        { text: "📊 PnL", callback_data: `pnl:${positionAddress}` },
      ],
      [
        { text: "💰 Claim", callback_data: `claim:${positionAddress}` },
        { text: "🔒 Close", callback_data: `close:${positionAddress}` },
      ],
    ];
  },

  /** PnL detail view (replaces position card) */
  pnlDetail(positionAddress) {
    return [
      [
        { text: "← Back", callback_data: `refresh_positions` },
        { text: "💰 Claim", callback_data: `claim:${positionAddress}` },
        { text: "🔒 Close", callback_data: `close:${positionAddress}` },
      ],
    ];
  },

  /** Screening cycle actions */
  screening() {
    return [
      [
        { text: "👥 Refresh Candidates", callback_data: "cmd:/candidates" },
        { text: "📊 Status", callback_data: "cmd:/status" },
      ],
      [
        { text: "⚙️ Settings", callback_data: "cmd:/settings" },
        { text: "🔄 Force Screen", callback_data: "cmd:/autoscreen" },
      ],
    ];
  },

  /** Management cycle actions */
  management() {
    return [
      [
        { text: "📊 Status", callback_data: "cmd:/status" },
        { text: "📋 Positions", callback_data: "cmd:/positions" },
      ],
      [
        { text: "👥 Candidates", callback_data: "cmd:/candidates" },
        { text: "⚙️ Settings", callback_data: "cmd:/settings" },
      ],
    ];
  },

  /** General / status footer */
  status() {
    return [
      [
        { text: "🔄 Screen", callback_data: "cmd:/screen" },
        { text: "📋 Positions", callback_data: "cmd:/positions" },
        { text: "⚙️ Settings", callback_data: "cmd:/settings" },
      ],
    ];
  },

  /** Deploy confirm */
  deploy(poolAddress) {
    return [
      [
        { text: "🔗 Pool", url: `${SOLSCAN_URL}/account/${poolAddress}` },
        { text: "📊 Status", callback_data: "cmd:/status" },
      ],
    ];
  },

  /** Close confirm */
  close(poolAddress) {
    return [
      [
        { text: "🔗 Pool", url: `${SOLSCAN_URL}/account/${poolAddress}` },
        { text: "📊 Status", callback_data: "cmd:/status" },
      ],
    ];
  },

  /** Candidates / pool picker */
  candidatesPicked() {
    return [
      [
        { text: "👥 Refresh", callback_data: "cmd:/candidates" },
        { text: "📊 Status", callback_data: "cmd:/status" },
      ],
    ];
  },
};

// ─── Text formatting ─────────────────────────────────────────────

function b(text) { return `<b>${esc(text)}</b>`; }
function code(text) { return `<code>${esc(text)}</code>`; }
function link(text, url) { return `<a href="${esc(url)}">${esc(text)}</a>`; }

function truncAddr(addr, head = 6, tail = 4) {
  if (!addr) return "—";
  const s = String(addr);
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function progressBar(value, max = 100, width = 12) {
  if (value == null || max == null || max <= 0) return "░".repeat(width);
  const pct = Math.max(0, Math.min(1, Number(value) / Number(max)));
  const filled = Math.round(pct * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

// ─── Top-level screens ────────────────────────────────────────────

/**
 * Wallet / status / portfolio snapshot. Used for /status, /wallet,
 * the startup card, and the daemon's silent cycle reports.
 */
export function formatWalletStatus({ wallet, positions, ml, config, dryRun, runtimeMode, extra }) {
  const solMode = config?.management?.solMode === true;
  const max = config?.risk?.maxPositions ?? 3;
  const open = positions?.total_positions ?? positions?.positions?.length ?? 0;
  const totalValue = (positions?.positions || []).reduce(
    (s, p) => s + (Number(p.total_value_usd) || 0),
    0,
  );
  const totalFees = (positions?.positions || []).reduce(
    (s, p) => s + (Number(p.unclaimed_fees_usd) || 0),
    0,
  );

  const lines = [];
  lines.push(b("💼 Wallet & Portfolio"));
  lines.push("");

  // Wallet line
  if (wallet) {
    const sol = solMode ? `${wallet.sol} SOL` : `${wallet.sol} SOL ($${wallet.sol_usd ?? "?"})`;
    lines.push(`${b("Balance:")} ${sol}`);
    if (wallet.total_usd != null) lines.push(`${b("Total est.:")} $${Number(wallet.total_usd).toFixed(2)}`);
    if (wallet.tokens?.length) {
      const top = wallet.tokens
        .filter((t) => Number(t.usd) > 1)
        .sort((a, b) => Number(b.usd || 0) - Number(a.usd || 0))
        .slice(0, 3);
      if (top.length) {
        lines.push("");
        lines.push(b("Top token holdings"));
        for (const t of top) {
          lines.push(`  • ${esc(t.symbol || t.mint?.slice(0, 6) || "?")} — $${Number(t.usd).toFixed(2)} (${Number(t.balance).toFixed(2)})`);
        }
      }
    }
  }

  // Positions line
  lines.push("");
  lines.push(b("Open Positions"));
  lines.push(`${progressBar(open, max)} ${open}/${max}`);
  if (open > 0) {
    lines.push(`  ${b("Total value:")} ${solMode ? formatSol(totalValue) : formatUsd(totalValue)}`);
    lines.push(`  ${b("Unclaimed fees:")} ${solMode ? formatSol(totalFees) : formatUsd(totalFees, 4)}`);
  }
  for (const p of (positions?.positions || []).slice(0, 5)) {
    const range = p.in_range ? "🟢" : "🔴";
    const pnl = formatPct(p.pnl_pct);
    const val = solMode ? formatSol(p.total_value_usd) : formatUsd(p.total_value_usd);
    const fees = solMode ? formatSol(p.unclaimed_fees_usd) : formatUsd(p.unclaimed_fees_usd, 4);
    lines.push(`  ${range} ${esc(p.pair || "?")} — ${pnl} • ${val} • fees ${fees}`);
  }
  if (open > 5) lines.push(`  … and ${open - 5} more`);

  // Strategy / risk
  if (config?.strategy) {
    lines.push("");
    const s = config.strategy;
    lines.push(`${b("Strategy:")} ${esc(s.strategy)} • bins ${s.minBinsBelow}–${s.maxBinsBelow} (default ${s.defaultBinsBelow})`);
  }
  if (config?.management) {
    const m = config.management;
    lines.push(`${b("Risk:")} TP ${m.takeProfitPct}% • SL ${m.stopLossPct}% • max ${config.risk?.maxDeployAmount ?? "?"} SOL`);
  }

  // ML / Darwin
  if (ml) {
    lines.push("");
    const conf = Number(ml.confidence ?? 0.5);
    const risk = Number(ml.riskAppetite ?? 0.5);
    const mood = conf > 0.6 ? "😊 confident" : risk < 0.3 ? "😰 cautious" : "😐 neutral";
    lines.push(`${b("ML:")} ${mood} (conf ${conf.toFixed(2)} / risk ${risk.toFixed(2)})`);
  }

  // Runtime info
  if (runtimeMode || dryRun != null) {
    lines.push("");
    const tags = [];
    if (dryRun) tags.push(b("DRY RUN"));
    if (runtimeMode) tags.push(`runtime: ${esc(runtimeMode)}`);
    if (tags.length) lines.push(tags.join(" • "));
  }

  if (extra) {
    lines.push("");
    lines.push(extra);
  }

  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.status() };
}

/**
 * Single position card for /positions listing (each row).
 */
export function formatPositionCard(position, options = {}) {
  const { solMode = false, showActions = true } = options;
  const inRange = position.in_range ? "🟢 IN RANGE" : `🔴 OOR ${position.minutes_out_of_range ?? 0}m`;
  const bins = position.lower_bin != null
    ? `${position.lower_bin} → ${position.upper_bin}`
    : "?";
  const active = position.active_bin != null ? `active=${position.active_bin}` : "";
  const age = position.age_minutes != null
    ? `${position.age_minutes}m${position.minutes_out_of_range ? ` (OOR ${position.minutes_out_of_range}m)` : ""}`
    : "?";

  const pnl = formatPct(position.pnl_pct);
  const val = solMode ? formatSol(position.total_value_usd) : formatUsd(position.total_value_usd);
  const fees = solMode ? formatSol(position.unclaimed_fees_usd) : formatUsd(position.unclaimed_fees_usd, 4);
  const yield_ = position.fee_per_tvl_24h != null ? `${position.fee_per_tvl_24h}%` : "—";

  const lines = [];
  lines.push(b(`📊 ${position.pair || "Position"}`) + `  ${inRange}`);
  lines.push(`${solscanAccountLink(position.pool, truncAddr(position.pool, 8, 4))}  •  pos ${solscanAccountLink(position.position, truncAddr(position.position, 8, 4))}`);
  lines.push(`Bins: ${bins}  ${active}  |  Age: ${age}`);
  lines.push(`PnL: ${pnl}  •  Value: ${val}  •  Fees: ${fees}  •  Yield: ${yield_}`);
  if (position.instruction) lines.push(`Note: "${esc(position.instruction)}"`);
  if (position.peak_pnl_pct != null) lines.push(`Peak PnL: ${formatPct(position.peak_pnl_pct)}`);

  const buttons = showActions && position.pool && position.position
    ? ACTION_BUTTONS.position(position.pool, position.position)
    : [];

  return { text: lines.join("\n").slice(0, 3900), buttons };
}

/**
 * Detailed PnL card used by the `pnl:<addr>` callback button. This
 * replaces the old "answerCallbackQuery" toast which only showed a
 * truncated "PnL: ?%" line.
 */
export function formatPositionPnLCard(position, options = {}) {
  const { solMode = false } = options;
  const pnlPct = Number(position?.pnl_pct ?? position?.pnlPct);
  const pnlUsd = Number(position?.pnl_usd ?? position?.pnlUsd);
  const initial = Number(position?.initial_value_usd);
  const final = Number(position?.final_value_usd);
  const fees = Number(position?.fees_earned_usd ?? position?.unclaimed_fees_usd);
  const inRange = position?.in_range === true
    ? "🟢 IN RANGE"
    : position?.in_range === false
      ? `🔴 OOR ${position?.minutes_out_of_range ?? 0}m`
      : "—";
  const rangePct = position?.range_efficiency != null ? `${position.range_efficiency.toFixed(1)}%` : "—";
  const age = position?.age_minutes != null ? `${position.age_minutes}m` : "?";

  const pnlSign = Number.isFinite(pnlPct) ? (pnlPct >= 0 ? "🟢" : "🔴") : "⚪";
  const pnlText = formatPct(pnlPct);

  const lines = [];
  lines.push(b(`📈 PnL — ${position?.pair || "Position"}`));
  lines.push(inRange);
  lines.push("");
  lines.push(`${b("Realized PnL:")} ${pnlSign} ${pnlText}  •  ${solMode ? formatSol(pnlUsd) : formatUsd(pnlUsd)}`);
  if (Number.isFinite(initial) && Number.isFinite(final)) {
    lines.push(`${b("Initial → Final:")} ${solMode ? formatSol(initial) : formatUsd(initial)} → ${solMode ? formatSol(final) : formatUsd(final)}`);
  }
  lines.push(`${b("Fees earned:")} ${solMode ? formatSol(fees) : formatUsd(fees, 4)}`);
  lines.push(`${b("Range efficiency:")} ${rangePct}  •  ${b("Age:")} ${age}`);

  if (position?.peak_pnl_pct != null) {
    lines.push("");
    lines.push(`${b("Peak PnL:")} ${formatPct(position.peak_pnl_pct)}`);
  }
  if (position?.fee_per_tvl_24h != null) {
    lines.push(`${b("Fee/TVL 24h:")} ${position.fee_per_tvl_24h}%`);
  }
  if (position?.close_reason) {
    lines.push(`${b("Close reason:")} ${esc(position.close_reason)}`);
  }

  return {
    text: lines.join("\n").slice(0, 3900),
    buttons: ACTION_BUTTONS.pnlDetail(position?.position),
  };
}

// ─── Candidates / screening ──────────────────────────────────────

export function formatCandidatesList(candidates, { title = "Top Candidates", timeWindow } = {}) {
  if (!candidates?.length) {
    return { text: `${b(title)}\n\n⚠️ No eligible pools. Try relaxing thresholds or switching the timeframe.`, buttons: ACTION_BUTTONS.candidatesPicked() };
  }
  const lines = [];
  lines.push(b(title));
  if (timeWindow) lines.push(`<i>Time window: ${esc(timeWindow)}</i>`);
  lines.push("");
  candidates.forEach((p, i) => {
    const feeTvl = p.fee_active_tvl_ratio != null ? `${Number(p.fee_active_tvl_ratio).toFixed(3)}%` : "—";
    const vol = p.volume_window != null ? `$${(Number(p.volume_window) / 1000).toFixed(1)}k` : "—";
    const tvl = p.tvl != null ? `$${(Number(p.tvl) / 1000).toFixed(1)}k` : "—";
    const organic = p.organic_score != null ? `${p.organic_score}` : "—";
    const vola = p.volatility != null ? `${Number(p.volatility).toFixed(2)}` : "—";
    const botTag = p.bot_traded ? " 🛰️" : "";
    lines.push(`${b(`${i + 1}. ${esc(p.name || "?")}${botTag}`)}`);
    lines.push(`   <code>${truncAddr(p.pool, 8, 4)}</code>  •  fee/TVL ${feeTvl}  •  vol ${vol}  •  TVL ${tvl}`);
    lines.push(`   organic ${organic}  •  volatility ${vola}  •  bin_step ${p.bin_step ?? "—"}`);
    if (p.gmgn_kol_names?.length || p.gmgn_preferred_kol_holders?.length) {
      const kols = (p.gmgn_kol_names || []).slice(0, 2).join(", ");
      const pref = (p.gmgn_preferred_kol_holders || []).slice(0, 1).map((k) => k.name).join(", ");
      lines.push(`   🧠 KOL: ${esc(kols || "—")}${pref ? `  ⭐ Preferred: ${esc(pref)}` : ""}`);
    }
  });
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.candidatesPicked() };
}

// ─── Lifecycle events ────────────────────────────────────────────

export function formatDeployResult(result, options = {}) {
  const { pair, amount, position, tx, range, pnlPct } = options;
  const lines = [];
  lines.push("🚀 " + b("DEPLOYED"));
  lines.push("");
  if (pair) lines.push(`${b("Pair:")} ${esc(pair)}`);
  if (amount != null) lines.push(`${b("Amount:")} ${formatSol(amount)}`);
  if (position) lines.push(`${b("Position:")} <code>${truncAddr(position, 8, 4)}</code>`);
  if (tx) lines.push(`${b("Tx:")} <code>${truncAddr(tx, 6, 4)}</code>`);
  if (range) {
    if (range.downside_pct != null) lines.push(`${b("Range downside:")} ${range.downside_pct.toFixed(2)}%`);
    if (range.upside_pct != null) lines.push(`${b("Range upside:")} ${range.upside_pct.toFixed(2)}%`);
    if (range.width_pct != null) lines.push(`${b("Range width:")} ${range.width_pct.toFixed(2)}%`);
  }
  if (pnlPct != null) lines.push(`${b("Initial PnL:")} ${formatPct(pnlPct)}`);
  const buttons = result?.pool
    ? ACTION_BUTTONS.deploy(result.pool)
    : ACTION_BUTTONS.status();
  return { text: lines.join("\n").slice(0, 3900), buttons };
}

// Maps close reason → human-readable explanation
const CLOSE_REASON_HINTS = {
  "stop loss": "price hit the stop-loss floor",
  "take profit": "price reached the take-profit target",
  "OOR": "position went out of range and stayed there past the wait window",
  "pumped far above range": "active bin moved well above the upper bin",
  "low yield": "fee/TVL stayed below the yield floor and trends weakened",
  "trailing TP": "trailing take-profit triggered after a peak pullback",
  "agent decision": "the management cycle decided to close (no specific rule fired)",
  "rebalance": "manual rebalance via /close N",
  "already closed": "the position was already closed on-chain (state was cleaned up)",
  "4b": "out of range + PnL was still declining (Rule 4b)",
};

function closeReasonHint(reason) {
  if (!reason) return null;
  if (CLOSE_REASON_HINTS[reason]) return CLOSE_REASON_HINTS[reason];
  const lower = String(reason).toLowerCase();
  for (const [key, hint] of Object.entries(CLOSE_REASON_HINTS)) {
    if (lower.includes(key.toLowerCase())) return hint;
  }
  return null;
}

export function formatCloseResult(result, options = {}) {
  const { pair, reason, explanation } = options;
  const closeReason = result?.close_reason || reason;
  const lines = [];
  const header = result?.already_closed ? "🟡 " + b("Already closed") : "🔒 " + b("Closed");
  lines.push(header);
  lines.push("");
  if (pair) lines.push(`${b("Pair:")} ${esc(pair)}`);
  if (result?.pnl_pct != null) {
    const sign = result.pnl_pct >= 0 ? "🟢" : "🔴";
    lines.push(`${b("PnL:")} ${sign} ${formatPct(result.pnl_pct)} • ${formatUsd(result.pnl_usd)}`);
  } else {
    lines.push(`${b("PnL:")} <i>awaiting settlement (recently closed)</i>`);
  }
  if (closeReason) {
    lines.push(`${b("Reason:")} ${esc(closeReason)}`);
    const hint = closeReasonHint(closeReason) || closeReasonHint(explanation);
    if (hint) lines.push(`<i>→ ${esc(hint)}</i>`);
  }
  if (result?.txs?.length) lines.push(`${b("Txs:")} <code>${result.txs.map((t) => truncAddr(t, 6, 4)).join(", ")}</code>`);
  if (result?.auto_swapped) lines.push(`🔁 Auto-swapped base token to SOL`);
  const buttons = ACTION_BUTTONS.status();
  return { text: lines.join("\n").slice(0, 3900), buttons };
}

export function formatClaimResult(result, options = {}) {
  const { pair, claimedAmount, symbol } = options;
  const lines = [];
  lines.push("💰 " + b("Claimed"));
  lines.push("");
  if (pair) lines.push(`${b("Pair:")} ${esc(pair)}`);
  if (claimedAmount != null) lines.push(`${b("Claimed:")} ${formatSol(claimedAmount)} ${symbol ? `(${symbol})` : ""}`);
  if (result?.txs?.length) lines.push(`${b("Txs:")} <code>${result.txs.map((t) => truncAddr(t, 6, 4)).join(", ")}</code>`);
  if (result?.auto_swapped) lines.push(`🔁 Auto-swapped base to SOL`);
  const buttons = ACTION_BUTTONS.status();
  return { text: lines.join("\n").slice(0, 3900), buttons };
}

// ─── Pool detail ─────────────────────────────────────────────────

export function formatPoolDetail(pool, options = {}) {
  if (!pool) return { text: "Pool not found.", buttons: ACTION_BUTTONS.status() };
  const { solMode = false } = options;
  const lines = [];
  lines.push(b(`🏊 ${pool.name || "Pool"}`));
  lines.push(`<code>${esc(pool.pool || "")}</code>`);
  lines.push("");
  if (pool.bin_step) lines.push(`${b("Bin step:")} ${pool.bin_step}`);
  if (pool.fee_pct != null) lines.push(`${b("Base fee:")} ${pool.fee_pct}%`);
  if (pool.fee_active_tvl_ratio != null) lines.push(`${b("Fee/active TVL:")} ${pool.fee_active_tvl_ratio.toFixed(3)}%`);
  if (pool.tvl != null) lines.push(`${b("TVL:")} ${formatUsd(pool.tvl)}`);
  if (pool.active_tvl != null) lines.push(`${b("Active TVL:")} ${formatUsd(pool.active_tvl)}`);
  if (pool.volume_window != null) lines.push(`${b("Volume (window):")} ${formatUsd(pool.volume_window)}`);
  if (pool.volatility != null) lines.push(`${b("Volatility:")} ${pool.volatility.toFixed(2)}`);
  if (pool.organic_score != null) lines.push(`${b("Organic:")} ${pool.organic_score}`);
  if (pool.holders != null) lines.push(`${b("Holders:")} ${pool.holders.toLocaleString()}`);
  if (pool.mcap != null) lines.push(`${b("Mcap:")} ${formatUsd(pool.mcap)}`);
  if (pool.token_age_hours != null) lines.push(`${b("Token age:")} ${pool.token_age_hours}h`);
  if (pool.launchpad) lines.push(`${b("Launchpad:")} ${esc(pool.launchpad)}`);
  if (pool.bot_traded) lines.push(`🛰️ ${b("Bot-traded:")} ${pool.bot_trade_count ?? "?"} trades`);
  if (pool.is_pvp) lines.push(`⚠️ ${b("PVP risk:")} rival ${esc(pool.pvp_rival_name || pool.pvp_symbol || "?")}`);
  if (pool.smart_wallets?.length) lines.push(`🧠 Smart wallets: ${esc(pool.smart_wallets.join(", "))}`);
  const buttons = pool.pool
    ? [
        [
          { text: "🔗 Solscan", url: `${SOLSCAN_URL}/account/${pool.pool}` },
          { text: "📊 Status", callback_data: "cmd:/status" },
        ],
      ]
    : ACTION_BUTTONS.status();
  return { text: lines.join("\n").slice(0, 3900), buttons };
}

// ─── Wallet balance card ─────────────────────────────────────────

export function formatBalance(wallet, options = {}) {
  const { solMode = false } = options;
  if (!wallet) return { text: "Wallet not loaded.", buttons: ACTION_BUTTONS.status() };
  const lines = [];
  lines.push(b("💰 Balance"));
  lines.push("");
  lines.push(`${b("SOL:")} ${wallet.sol} SOL (${formatUsd(wallet.sol_usd)})`);
  if (wallet.sol_price) lines.push(`${b("SOL price:")} ${formatUsd(wallet.sol_price)}`);
  if (wallet.usdc) lines.push(`${b("USDC:")} ${wallet.usdc}`);
  if (wallet.total_usd != null) lines.push(`${b("Total est.:")} ${formatUsd(wallet.total_usd)}`);
  if (wallet.tokens?.length) {
    const nonZero = wallet.tokens
      .filter((t) => Number(t.usd) > 0.01)
      .sort((a, b) => Number(b.usd || 0) - Number(a.usd || 0));
    if (nonZero.length) {
      lines.push("");
      lines.push(b("Tokens"));
      for (const t of nonZero.slice(0, 10)) {
        lines.push(`  • ${esc(t.symbol || t.mint?.slice(0, 6) || "?")} — ${formatUsd(t.usd, 2)} (${Number(t.balance).toFixed(4)})`);
      }
      if (nonZero.length > 10) lines.push(`  … and ${nonZero.length - 10} more`);
    }
  }
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.status() };
}

// ─── Config / thresholds / lessons / performance ─────────────────

export function formatConfigSnapshot(config, options = {}) {
  if (!config) return { text: "Config not loaded.", buttons: ACTION_BUTTONS.status() };
  const s = config.screening || {};
  const m = config.management || {};
  const lines = [];
  lines.push(b("⚙️ Config Snapshot"));
  lines.push("");
  lines.push(b("Risk"));
  lines.push(`  • maxPositions: ${config.risk?.maxPositions}`);
  lines.push(`  • maxDeployAmount: ${config.risk?.maxDeployAmount} SOL`);
  lines.push("");
  lines.push(b("Screening"));
  lines.push(`  • source: ${s.source}`);
  lines.push(`  • timeframe: ${s.timeframe} • category: ${s.category}`);
  lines.push(`  • minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
  lines.push(`  • minTvl: ${formatUsd(s.minTvl)} • maxTvl: ${formatUsd(s.maxTvl)}`);
  lines.push(`  • minVolume: ${formatUsd(s.minVolume)}`);
  lines.push(`  • minOrganic: ${s.minOrganic} • minQuoteOrganic: ${s.minQuoteOrganic}`);
  lines.push(`  • minHolders: ${s.minHolders} • minMcap: ${formatUsd(s.minMcap)} • maxMcap: ${formatUsd(s.maxMcap)}`);
  lines.push(`  • binStep: ${s.minBinStep}–${s.maxBinStep}`);
  if (s.minTokenAgeHours != null || s.maxTokenAgeHours != null) {
    lines.push(`  • tokenAge: ${s.minTokenAgeHours ?? "any"}–${s.maxTokenAgeHours ?? "any"}h`);
  }
  if (s.athFilterPct != null) lines.push(`  • athFilterPct: ${s.athFilterPct}`);
  lines.push("");
  lines.push(b("Management"));
  lines.push(`  • deployAmountSol: ${m.deployAmountSol} • positionSizePct: ${m.positionSizePct}`);
  lines.push(`  • gasReserve: ${m.gasReserve} • minSolToOpen: ${m.minSolToOpen}`);
  lines.push(`  • TP: ${m.takeProfitPct}% • SL: ${m.stopLossPct}%`);
  if (m.trailingTakeProfit) lines.push(`  • trailing: trigger ${m.trailingTriggerPct}% • drop ${m.trailingDropPct}%`);
  lines.push(`  • OOR wait: ${m.outOfRangeWaitMinutes}m (${m.outOfRangeBinsToClose} bins)`);
  lines.push(`  • low yield: fee/TVL 24h ≥ ${m.minFeePerTvl24h}%, age ≥ ${m.minAgeBeforeYieldCheck}m`);
  lines.push(`  • claim threshold: ${formatUsd(m.minClaimAmount, 2)}`);
  if (m.solMode) lines.push(`  • solMode: ON (PnL/values reported in SOL)`);
  lines.push("");
  lines.push(b("Schedule"));
  lines.push(`  • management: every ${config.schedule?.managementIntervalMin}m`);
  lines.push(`  • screening: every ${config.schedule?.screeningIntervalMin}m`);
  lines.push(`  • health: every ${config.schedule?.healthCheckIntervalMin}m`);
  lines.push("");
  lines.push(b("Strategy"));
  lines.push(`  • strategy: ${config.strategy?.strategy}`);
  lines.push(`  • bins: ${config.strategy?.minBinsBelow}–${config.strategy?.maxBinsBelow} (default ${config.strategy?.defaultBinsBelow})`);
  lines.push("");
  lines.push(b("Models"));
  lines.push(`  • screening: ${esc(config.llm?.screeningModel || "—")}`);
  lines.push(`  • management: ${esc(config.llm?.managementModel || "—")}`);
  lines.push(`  • general: ${esc(config.llm?.generalModel || "—")}`);
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.status() };
}

export function formatThresholds(config, options = {}) {
  if (!config) return { text: "Config not loaded.", buttons: ACTION_BUTTONS.status() };
  const s = config.screening || {};
  const m = config.management || {};
  const lines = [];
  lines.push(b("🎯 Screening Thresholds"));
  lines.push("");
  lines.push(`${b("Fee/active TVL:")} ≥ ${s.minFeeActiveTvlRatio}%`);
  lines.push(`${b("TVL:")} ${formatUsd(s.minTvl)} ≤ TVL ≤ ${formatUsd(s.maxTvl)}`);
  lines.push(`${b("Volume:")} ≥ ${formatUsd(s.minVolume)}`);
  lines.push(`${b("Organic:")} base ≥ ${s.minOrganic} • quote ≥ ${s.minQuoteOrganic}`);
  lines.push(`${b("Holders:")} ≥ ${s.minHolders ?? "—"}`);
  lines.push(`${b("Mcap:")} ${formatUsd(s.minMcap)} ≤ ${formatUsd(s.maxMcap)}`);
  lines.push(`${b("Bin step:")} ${s.minBinStep ?? "—"}–${s.maxBinStep ?? "—"}`);
  if (s.minTokenAgeHours != null || s.maxTokenAgeHours != null) {
    lines.push(`${b("Token age:")} ${s.minTokenAgeHours ?? "any"}–${s.maxTokenAgeHours ?? "any"}h`);
  }
  if (s.athFilterPct != null) lines.push(`${b("ATH filter:")} ≤ ${(100 + s.athFilterPct)}% of ATH`);
  lines.push("");
  lines.push(b("🛡 Risk"));
  lines.push(`${b("TP / SL:")} ${m.takeProfitPct}% / ${m.stopLossPct}%`);
  if (m.trailingTakeProfit) lines.push(`${b("Trailing TP:")} trigger ${m.trailingTriggerPct}%, drop ${m.trailingDropPct}%`);
  lines.push(`${b("OOR wait:")} ${m.outOfRangeWaitMinutes}m, close when > ${m.outOfRangeBinsToClose} bins above range`);
  lines.push(`${b("Low yield close:")} fee/TVL 24h < ${m.minFeePerTvl24h}% after ${m.minAgeBeforeYieldCheck}m`);
  lines.push(`${b("Claim threshold:")} ≥ ${formatUsd(m.minClaimAmount, 2)}`);
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.status() };
}

export function formatLessons(lessons, options = {}) {
  const list = Array.isArray(lessons) ? lessons : [];
  if (!list.length) return { text: "No lessons recorded yet.", buttons: ACTION_BUTTONS.status() };
  const lines = [];
  lines.push(b(`📚 Lessons (${list.length})`));
  lines.push("");
  const showCount = options.limit || 20;
  list.slice(0, showCount).forEach((l, i) => {
    const pin = l.pinned ? "📌 " : "";
    const when = timeAgo(l.created_at);
    lines.push(`${pin}${i + 1}. ${esc(l.rule || "?")}`);
    const meta = [];
    if (l.outcome) meta.push(l.outcome);
    if (l.sourceType) meta.push(l.sourceType);
    if (when) meta.push(when);
    if (meta.length) lines.push(`   <i>${esc(meta.join(" • "))}</i>`);
  });
  if (list.length > showCount) lines.push(`… and ${list.length - showCount} more`);
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.status() };
}

export function formatPerformance(summary, history, options = {}) {
  const lines = [];
  lines.push(b("📊 Performance"));
  lines.push("");
  if (summary) {
    const s = summary;
    lines.push(`${b("Total positions:")} ${s.total ?? "—"}`);
    lines.push(`${b("Win rate:")} ${s.win_rate_pct?.toFixed(1) ?? "—"}%`);
    lines.push(`${b("Avg PnL:")} ${formatPct(s.avg_pnl_pct)}`);
    if (s.total_pnl_usd != null) lines.push(`${b("Total PnL:")} ${formatUsd(s.total_pnl_usd)}`);
    if (s.total_fees_usd != null) lines.push(`${b("Total fees:")} ${formatUsd(s.total_fees_usd, 4)}`);
    if (s.avg_range_efficiency != null) lines.push(`${b("Avg range efficiency:")} ${s.avg_range_efficiency.toFixed(1)}%`);
  } else {
    lines.push("No performance data yet.");
  }
  if (history?.positions?.length) {
    lines.push("");
    lines.push(b("Recent closes"));
    history.positions.slice(0, 5).forEach((p) => {
      const sign = p.pnl_pct >= 0 ? "🟢" : "🔴";
      lines.push(`  ${sign} ${esc(p.pool_name || p.pool?.slice(0, 8) || "?")} — ${formatPct(p.pnl_pct)} • ${formatUsd(p.pnl_usd)} • ${timeAgo(p.recorded_at)}`);
    });
  }
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.status() };
}

// ─── Error card ──────────────────────────────────────────────────

export function formatError(title, message, options = {}) {
  const lines = [];
  lines.push("⚠️ " + b(title || "Error"));
  lines.push("");
  lines.push(esc(message || "Unknown error"));
  if (options.hint) {
    lines.push("");
    lines.push(`<i>Hint: ${esc(options.hint)}</i>`);
  }
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.status() };
}

// ─── Help / cycle reports ────────────────────────────────────────

export function formatStart({ wallet, positions, config } = {}) {
  const lines = [];
  lines.push("🤖 " + b("Welcome to Meridian"));
  lines.push("");
  lines.push("Autonomous Meteora DLMM screening and position management.");
  if (wallet) {
    lines.push("");
    lines.push(`${b("Wallet:")} ${formatSol(wallet.sol)} • ${formatUsd(wallet.sol_usd)} • ${b("Total:")} ${formatUsd(wallet.total_usd)}`);
  }
  if (positions) {
    lines.push(`${b("Open positions:")} ${positions.total_positions ?? positions.positions?.length ?? 0}`);
  }
  if (config?.management && config?.schedule) {
    lines.push(`${b("Deploy:")} ${config.management.deployAmountSol} SOL • ${b("Manage:")} ${config.schedule.managementIntervalMin}m • ${b("Screen:")} ${config.schedule.screeningIntervalMin}m`);
  }
  lines.push("");
  lines.push(b("Try:"));
  lines.push("  /status — wallet and positions snapshot");
  lines.push("  /screen — refresh candidate list");
  lines.push("  /positions — inspect open positions");
  lines.push("  /help — full command list");
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.screening() };
}

export function formatHelp() {
  return [
    "📋 " + b("Meridian Commands"),
    "",
    b("Wallet & portfolio"),
    "  /status, /wallet — wallet + open positions + risk summary",
    "  /balance — detailed balance including SPL tokens",
    "  /positions — list all open DLMM positions",
    "  /pool &lt;n&gt; — detail card for one position",
    "  /help — show this help",
    "",
    b("Screening & deploy"),
    "  /screen, /candidates — refresh candidate list (no deploy)",
    "  /autoscreen — run full AI screening cycle (may deploy)",
    "  /deploy &lt;n&gt; — deploy into cached candidate N",
    "  /close &lt;n&gt; — close position by index",
    "  /set &lt;n&gt; &lt;note&gt; — attach note to a position",
    "  /briefing — morning briefing",
    "",
    b("Config"),
    "  /config — full config snapshot",
    "  /thresholds — show current screening thresholds",
    "  /settings — button-driven config menu",
    "  /setcfg &lt;key&gt; &lt;value&gt; — update persisted config",
    "",
    b("Learning"),
    "  /learn — study top LPers from current pool",
    "  /lessons — recent saved lessons",
    "  /thresholds — see /thresholds above",
    "  /evolve — run threshold evolution",
    "  /performance — win rate / avg PnL / total fees",
    "  /screening-stats — screening funnel stats",
    "  /hive — HiveMind sync status",
    "  /ml-status — model generation, blend λ, emotion state, personality",
    "  /ml-train — force an ML training pass",
    "  /mlpersonality &lt;name&gt; — switch ML personality preset",
    "",
    b("Lifecycle"),
    "  /pause, /resume — pause / resume cron cycles",
    "  /stop — shut down the agent",
  ].join("\n");
}

// ─── Cycle reports (used by liveMessage) ────────────────────────

export function formatScreeningReport(rawText, { pool, poolName, dryRun, runtimeMode } = {}) {
  if (!rawText) return { text: "(empty report)", buttons: ACTION_BUTTONS.screening() };
  const lines = [];
  lines.push("🔍 " + b("Screening Cycle"));
  if (runtimeMode) lines.push(`<i>runtime: ${esc(runtimeMode)}</i>`);
  lines.push("");
  lines.push(esc(rawText.trim()));
  if (dryRun) lines.push("");
  if (dryRun) lines.push(b("⚠️ DRY RUN — no transactions sent"));
  if (pool) lines.push(`Pool: <code>${truncAddr(pool, 8, 4)}</code>`);
  if (poolName) lines.push(`Name: ${esc(poolName)}`);
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.screening() };
}

export function formatManagementReport(rawText, { positions, dryRun, runtimeMode } = {}) {
  if (!rawText) return { text: "(empty report)", buttons: ACTION_BUTTONS.management() };
  const lines = [];
  lines.push("🔄 " + b("Management Cycle"));
  if (runtimeMode) lines.push(`<i>runtime: ${esc(runtimeMode)}</i>`);
  if (Array.isArray(positions) && positions.length) {
    lines.push(`${b("Open:")} ${positions.length} position(s)`);
  }
  lines.push("");
  lines.push(esc(rawText.trim()));
  if (dryRun) lines.push("");
  if (dryRun) lines.push(b("⚠️ DRY RUN — no transactions sent"));
  return { text: lines.join("\n").slice(0, 3900), buttons: ACTION_BUTTONS.management() };
}

// ─── Live progress enhancer ──────────────────────────────────────

function stageLabel(stage) {
  const map = {
    fetching: "🔍 Fetching candidates...",
    filtering: "⚗️ Filtering pools...",
    enriching: "📡 Enriching with narratives & smart wallets...",
    scoring: "🧮 Scoring candidates...",
    deciding: "🤖 LLM evaluating...",
    deploying: "🚀 Deploying position...",
    reporting: "📝 Building report...",
    done: "✅ Complete",
  };
  return map[stage] || stage;
}

export async function liveStage(live, stage) {
  if (!live) return;
  await live.note(stageLabel(stage));
}

function stripHeaderFooter(rawText, isDeploy) {
  if (!rawText) return "";
  let body = rawText
    .replace(/^.*?(?:🚀 DEPLOYED|⛔ NO DEPLOY).*?\n/, "")
    .trim();
  return body;
}

export {
  ACTION_BUTTONS,
  SOLSCAN_URL,
  esc,
  b,
  code,
  link,
  stageLabel,
  progressBar,
  formatSol,
  formatUsd,
  formatPct,
  truncAddr,
  timeAgo,
  stripHeaderFooter,
};

// ─── Plain-text variants for REPL / CLI console ─────────────────────
// These strip HTML tags and convert button-emoji tables to ASCII so
// output is readable in a terminal. The data layer is identical; only
// the rendering differs.

const HTML_TAG_RE = /<\/?(?:b|i|u|s|code|pre|a)\b[^>]*>/gi;

function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(HTML_TAG_RE, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\u00a0/g, " ");
}

function unwrap({ text, buttons }) {
  return { text: stripHtml(text), buttons: buttons || [] };
}

export const formatWalletStatusPlain = (args) => unwrap(formatWalletStatus(args));
export const formatPositionCardPlain = (position, options = {}) => unwrap(formatPositionCard(position, options));
export const formatPositionPnLCardPlain = (position, options = {}) => unwrap(formatPositionPnLCard(position, options));
export const formatCandidatesListPlain = (candidates, options = {}) => unwrap(formatCandidatesList(candidates, options));
export const formatPoolDetailPlain = (pool, options = {}) => unwrap(formatPoolDetail(pool, options));
export const formatBalancePlain = (wallet, options = {}) => unwrap(formatBalance(wallet, options));
export const formatConfigSnapshotPlain = (config, options = {}) => unwrap(formatConfigSnapshot(config, options));
export const formatThresholdsPlain = (config, options = {}) => unwrap(formatThresholds(config, options));
export const formatLessonsPlain = (lessons, options = {}) => unwrap(formatLessons(lessons, options));
export const formatPerformancePlain = (summary, history, options = {}) => unwrap(formatPerformance(summary, history, options));
export const formatErrorPlain = (title, message, options = {}) => unwrap(formatError(title, message, options));
export const formatHelpPlain = () => formatHelp();
export const formatDeployResultPlain = (result, options = {}) => unwrap(formatDeployResult(result, options));
export const formatCloseResultPlain = (result, options = {}) => unwrap(formatCloseResult(result, options));
export const formatClaimResultPlain = (result, options = {}) => unwrap(formatClaimResult(result, options));
export const formatScreeningReportPlain = (rawText, options = {}) => unwrap(formatScreeningReport(rawText, options));
export const formatManagementReportPlain = (rawText, options = {}) => unwrap(formatManagementReport(rawText, options));
