/**
 * Runtime mode guard (4A).
 *
 * Centralizes the MERIDIAN_RUNTIME_MODE env var. Tools/CLI must check
 * this before starting long-lived intervals (caches, heartbeats, polls)
 * so one-shot commands don't keep the Node process alive.
 *
 * Modes:
 *   - "cli"     : one-shot CLI invocation (default for `node cli.js ...`)
 *   - "repl"    : interactive REPL started by `node index.js`
 *   - "daemon"  : long-running autonomous agent (PM2 / systemd)
 *   - "telegram": Telegram bot started by `node index.js` with no REPL
 *
 *   If unset, the runtime falls back to a best-effort detection: CLI
 *   when the script was launched from `cli.js`, otherwise "daemon".
 */

let _resolved = null;
let _explicit = false;

export const RUNTIME_MODES = Object.freeze({
  CLI: "cli",
  REPL: "repl",
  DAEMON: "daemon",
  TELEGRAM: "telegram",
});

function detectFromArgs() {
  if (process.env.pm_id) return RUNTIME_MODES.DAEMON;
  const argv1 = (process.argv[1] || "").replace(/\\/g, "/");
  if (argv1.endsWith("/cli.js")) return RUNTIME_MODES.CLI;
  if (argv1.endsWith("/index.js")) {
    if (process.env.TELEGRAM_BOT_TOKEN) return RUNTIME_MODES.TELEGRAM;
    if (process.stdin && process.stdin.isTTY) return RUNTIME_MODES.REPL;
    return RUNTIME_MODES.DAEMON;
  }
  return RUNTIME_MODES.DAEMON;
}

export function getRuntimeMode() {
  if (_resolved) return _resolved;
  const env = String(process.env.MERIDIAN_RUNTIME_MODE || "").toLowerCase().trim();
  if (env && Object.values(RUNTIME_MODES).includes(env)) {
    _resolved = env;
    _explicit = true;
    return _resolved;
  }
  _resolved = detectFromArgs();
  return _resolved;
}

export function setRuntimeMode(mode) {
  const normalized = String(mode || "").toLowerCase().trim();
  if (!Object.values(RUNTIME_MODES).includes(normalized)) {
    throw new Error(`Invalid runtime mode: ${mode}. Use one of: ${Object.values(RUNTIME_MODES).join(", ")}`);
  }
  process.env.MERIDIAN_RUNTIME_MODE = normalized;
  _resolved = normalized;
  _explicit = true;
  return normalized;
}

export function isExplicit() {
  return _explicit;
}

export function isCli() {
  return getRuntimeMode() === RUNTIME_MODES.CLI;
}

export function isRepl() {
  return getRuntimeMode() === RUNTIME_MODES.REPL;
}

export function isDaemon() {
  return getRuntimeMode() === RUNTIME_MODES.DAEMON;
}

export function isTelegram() {
  return getRuntimeMode() === RUNTIME_MODES.TELEGRAM;
}

/**
 * Start a setInterval that does not block process exit in CLI mode.
 * In long-lived modes (repl/daemon/telegram) the interval runs as normal.
 */
export function safeSetInterval(fn, ms, label = "interval") {
  const handle = setInterval(() => {
    try {
      fn();
    } catch (e) {
      // Don't let an interval failure kill the process; just log.
      // Logger is intentionally not imported here to avoid a circular
      // dep — fall back to stderr.
      process.stderr.write(`[${label}] interval error: ${e?.message || e}\n`);
    }
  }, ms);
  if (isCli()) handle.unref?.();
  return handle;
}

/**
 * Start a setTimeout that does not block process exit in CLI mode.
 */
export function safeSetTimeout(fn, ms, label = "timeout") {
  const handle = setTimeout(() => {
    try {
      fn();
    } catch (e) {
      process.stderr.write(`[${label}] timeout error: ${e?.message || e}\n`);
    }
  }, ms);
  if (isCli()) handle.unref?.();
  return handle;
}
