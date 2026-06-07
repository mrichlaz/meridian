/**
 * Telegram Rich Formatter
 *
 * Converts agent reports into HTML-formatted messages with inline
 * action buttons. The LLM still generates the text — this module
 * wraps it into structured, readable Telegram messages.
 *
 * Exports:
 *   - formatScreeningReport(rawText, pool, buttons) → { text, buttons }
 *   - formatManagementReport(rawText, positions, buttons) → { text, buttons }
 *   - formatStatusCard(wallet, positions, ml, config) → { text, buttons }
 *   - formatPositionCard(position) → { text, buttons }
 *   - ACTION_BUTTONS   → reusable button presets
 *   - SOLSCAN_URL      → "https://solscan.io"
 */

const SOLSCAN_URL = "https://solscan.io";

// ─── HTML escape ─────────────────────────────────────────────────

function esc(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

  /** Screening cycle actions */
  screening() {
    return [
      [
        { text: "🔄 Force Screen", callback_data: "cmd:/screen" },
        { text: "📊 Status", callback_data: "cmd:/status" },
      ],
      [
        { text: "⚙️ Settings", callback_data: "cmd:/settings" },
        { text: "👥 Candidates", callback_data: "cmd:/candidates" },
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
        { text: "🔄 Screen", callback_data: "cmd:/screen" },
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
};

// ─── Text formatting ─────────────────────────────────────────────

/** Bold shortcut */
function b(text) {
  return `<b>${esc(text)}</b>`;
}

/** Code/monospace shortcut */
function code(text) {
  return `<code>${esc(text)}</code>`;
}

/** Inline link */
function link(text, url) {
  return `<a href="${esc(url)}">${esc(text)}</a>`;
}

// ─── Report formatters ───────────────────────────────────────────

/**
 * Parse a raw screening report into structured HTML + buttons.
 */
export function formatScreeningReport(rawText, extras = {}) {
  const {
    pool = null,
    poolName = null,
    position = null,
    tx = null,
    deployAmount = null,
    strategy = null,
  } = extras;

  const isDeploy = /🚀\s*DEPLOYED/i.test(rawText);

  let text = "";

  if (isDeploy) {
    text += `🚀 ${b("DEPLOYED")}\n` +
      `${esc(poolName || pool || "Unknown")}\n` +
      `${code((pool || "").slice(0, 16))}...\n`;
    if (deployAmount) text += `◎ ${b(deployAmount)} SOL`;
    if (strategy) text += ` | ${esc(strategy)}`;
    text += "\n";
    if (position) text += `Pos: ${code(position)}\n`;
    if (tx) text += `Tx: ${code((tx || "").slice(0, 16))}...\n`;
    const body = stripHeaderFooter(rawText, true);
    if (body) text += "\n" + esc(body);
  } else {
    // LLM output already contains the ⛔ NO DEPLOY header and structured sections.
    // Just escape for safety — don't add redundant headers.
    text += esc(rawText);
  }

  text = text.slice(0, 3900);

  const buttons = pool
    ? ACTION_BUTTONS.deploy(pool)
    : ACTION_BUTTONS.screening();

  return { text, buttons };
}

/**
 * Parse a management cycle report into structured HTML + buttons.
 */
export function formatManagementReport(rawText, positions = []) {
  let text = `🔧 ${b("MANAGEMENT")}\n`;

  // Convert markdown **bold** to HTML <b>bold</b> — esc preserves ** then replace
  text += esc(rawText).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").slice(0, 3500);

  const firstPosition = positions[0];
  const buttons = firstPosition?.pool
    ? ACTION_BUTTONS.position(firstPosition.pool, firstPosition.position)
    : ACTION_BUTTONS.management();

  return { text: text.slice(0, 3900), buttons };
}

/**
 * Build a rich wallet + positions status card.
 */
export function formatStatusCard({ wallet, positions, ml, config } = {}) {
  const sol = wallet?.sol ?? 0;
  const solUsd = wallet?.sol_usd ?? 0;
  const solPrice = wallet?.sol_price ?? 0;
  const totalPositions = positions?.total_positions ?? positions?.positions?.length ?? 0;
  const maxPositions = config?.risk?.maxPositions ?? 3;
  const dryRun = process.env.DRY_RUN === "true";

  let text = `💼 ${b("Wallet Status")}\n\n`;
  text += `SOL: ${b(sol.toFixed(4))} ($${solUsd.toFixed(2)})\n`;
  if (solPrice) text += `Price: $${solPrice.toFixed(2)}\n`;
  text += `Positions: ${totalPositions}/${maxPositions}\n`;

  if (ml) {
    const conf = ml.confidence ?? 0.5;
    const risk = ml.riskAppetite ?? 0.5;
    const mood = conf > 0.6 ? "😊" : risk < 0.3 ? "😰" : "😐";
    text += `ML: ${mood} conf=${conf.toFixed(2)} risk=${risk.toFixed(2)}\n`;
  }

  if (dryRun) text += `\n⚠️ ${b("DRY RUN")} — no real transactions\n`;

  // Position list
  if (positions?.positions) {
    text += `\n${b("Open Positions")}\n`;
    for (let i = 0; i < Math.min(positions.positions.length, 5); i++) {
      const p = positions.positions[i];
      const rangeBar = p.in_range ? "🟢" : "🔴";
      text += `${rangeBar} ${i + 1}. ${esc(p.pair || "?")}: ${p.pnl_pct >= 0 ? "+" : ""}${(p.pnl_pct ?? 0).toFixed(2)}%\n`;
    }
    if (positions.positions.length > 5) {
      text += `  ... and ${positions.positions.length - 5} more\n`;
    }
  }

  return { text: text.slice(0, 3900), buttons: ACTION_BUTTONS.status() };
}

/**
 * Build a single position card with inline action buttons.
 */
export function formatPositionCard(position) {
  let text = `📊 ${b(esc(position.pair || position.pool_name || "Position"))}\n\n`;
  text += `PnL: ${position.pnl_pct >= 0 ? "+" : ""}${(position.pnl_pct ?? 0).toFixed(2)}%\n`;
  text += `Fees: $${(position.unclaimed_fees_usd ?? 0).toFixed(4)}\n`;
  text += `Value: $${(position.total_value_usd ?? 0).toFixed(2)}\n`;
  text += `In range: ${position.in_range ? "Yes" : `No (${position.minutes_out_of_range ?? 0}m)`}\n`;
  if (position.fee_per_tvl_24h != null) text += `Fee/TVL 24h: ${position.fee_per_tvl_24h}%\n`;
  if (position.instruction) text += `Note: "${esc(position.instruction)}"\n`;

  const buttons = ACTION_BUTTONS.position(
    position.pool,
    position.position,
  );

  return { text: text.slice(0, 3900), buttons };
}

// ─── Live progress enhancer ──────────────────────────────────────

/**
 * Build richer stage labels for liveMessage during screening.
 */
function stageLabel(stage) {
  const map = {
    fetching: "🔍 Fetching candidates...",
    filtering: "⚗️ Filtering pools...",
    enriching: "📡 Enriching with narratives & smart wallets...",
    scoring: "🧠 ML scoring candidates...",
    deciding: "🤖 LLM evaluating...",
    deploying: "🚀 Deploying position...",
    reporting: "📝 Building report...",
    done: "✅ Complete",
  };
  return map[stage] || stage;
}

/**
 * Helper to push a stage update through a liveMessage.
 */
export async function liveStage(live, stage) {
  if (!live) return;
  await live.note(stageLabel(stage));
}

// ─── Helpers ─────────────────────────────────────────────────────

function stripHeaderFooter(rawText, isDeploy) {
  if (!rawText) return "";
  // Remove the 🚀 DEPLOYED or ⛔ NO DEPLOY header line
  let body = rawText
    .replace(/^.*?(?:🚀 DEPLOYED|⛔ NO DEPLOY).*?\n/, "")
    .trim();

  // If it's a deploy report, keep everything; if no-deploy, keep the full analysis
  return body;
}

export { ACTION_BUTTONS, SOLSCAN_URL, esc, b, code, link, stageLabel };
