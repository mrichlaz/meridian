/**
 * Realtime arb-stream ingester.
 *
 * Drives a Chromium (via CDP) to load sandwiched.me, which passes Cloudflare
 * and opens the arb WebSocket (`wss://…/stream`). We intercept the WS frames
 * with CDP (Network.webSocketFrameReceived) and turn each `AtomicArbs` swap
 * into a token event in the SAME tokens/events tables the poller feeds — so
 * all scoring / safety / notify logic works unchanged, just realtime.
 *
 * One container: by default it LAUNCHES a memory-capped headless Chromium as a
 * child process. Set BROWSER_WS_ENDPOINT / BROWSER_URL to connect to an
 * external browser instead (off-box option).
 *
 * Lightpanda was evaluated and rejected: it is blocked by Cloudflare and lacks
 * the Web APIs (Canvas, etc.) the app needs, so it never opens the WS.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import { getDB } from "./db.js";
import { log } from "./logger.js";
import { CONFIG, WSOL, EXCLUDED_MINTS } from "./config.js";

// Memory-conscious flags for a low-RAM host.
const SLIM_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--single-process",
  "--no-zygote",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-software-rasterizer",
  "--disable-features=site-per-process,TranslateUI",
  "--mute-audio",
  "--no-first-run",
  "--js-flags=--max-old-space-size=128",
];

let _stopped = false;
let _running = false;
let _browser = null;
let _ownsBrowser = false;
const _lastWsOpenAt = {};   // url → ms timestamp, for log throttling
// Frame-shape discovery: log the first N frames in full (truncated) so the
// operator can see exactly what the WS is emitting. The stand-alone
// stream-ingester ran fine for the user pre-merge, so we know the protocol
// works; this log helps confirm the new in-tree build still gets frames
// (and what shape they're in) when the heartbeat shows 0 arbs.
const _loggedFrames = [];
const FRAME_LOG_LIMIT = 20;

/**
 * Robust "is the browser still alive" probe. puppeteer-core changed the
 * Browser API between v23 (had isConnected() method) and v25 (it's a
 * `connected` boolean property now, or absent entirely on some wrappers).
 * Try each in order; fall back to "assume alive" so the loop at least
 * catches real failures via try/catch and reconnect cycles.
 */
export function isBrowserConnected(b) {
  if (!b) return false;
  if (typeof b.isConnected === "function") {
    try { return b.isConnected(); } catch { return false; }
  }
  if (typeof b.connected === "boolean") return b.connected;
  return true;
}

const health = { connected: false, lastFrameAt: 0, framesTotal: 0, arbsTotal: 0, tokensSeen: 0 };

export function streamHealth() {
  return { ...health, running: _running };
}

function pickTokenMint(swap) {
  // The arbitraged token is the non-SOL / non-stable side of the swap.
  for (const side of [swap?.buyToken, swap?.sellToken]) {
    const id = side?.id;
    if (id && id !== WSOL && !EXCLUDED_MINTS.has(id)) return { mint: id, meta: side };
  }
  return null;
}

function recordArbFrame(db, msg) {
  const blk = msg?.block_arbs;
  if (!blk?.arbs?.length) return;
  const ts = blk.time ? blk.time * 1000 : Date.now();

  const insSeen = db.prepare("INSERT OR IGNORE INTO seen_sigs VALUES (?,?)");
  const insEvent = db.prepare("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?)");
  const upToken = db.prepare(`
    INSERT INTO tokens (mint, symbol, name, dex, first_seen, last_seen, last_event, occurrence_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(mint) DO UPDATE SET
      symbol = COALESCE(tokens.symbol, excluded.symbol),
      name = COALESCE(tokens.name, excluded.name),
      dex = COALESCE(excluded.dex, tokens.dex),
      last_seen = excluded.last_seen,
      last_event = excluded.last_event,
      occurrence_count = tokens.occurrence_count + 1
  `);

  const now = Date.now();
  db.transaction(() => {
    for (const arb of blk.arbs) {
      const bot = arb.program || arb.signer || null; // attribute to the bot
      for (const swap of arb.swaps || []) {
        const picked = pickTokenMint(swap);
        if (!picked) continue;
        const sig = swap.sig || arb.swaps?.[0]?.sig;
        if (!sig) continue;
        insSeen.run(sig, now);
        insEvent.run(sig, picked.mint, bot, "stream", ts);
        upToken.run(
          picked.mint,
          picked.meta?.symbol || null,
          picked.meta?.name || null,
          swap.amm || null,
          ts, ts, ts
        );
        health.tokensSeen++;
      }
      health.arbsTotal++;
    }
  })();
}

/**
 * Find a Chromium-class binary to drive via puppeteer-core.
 *
 * puppeteer-core (the package we use) does NOT auto-download Chrome like the
 * full `puppeteer` package does — it requires either `executablePath` or
 * `channel` to be passed at launch time. The user can set BROWSER_EXECUTABLE
 * in .env to override; otherwise we probe the usual install locations for
 * the platform the process is running on.
 *
 * If nothing is found we throw a clear error so the user knows what to
 * install, instead of the cryptic puppeteer-core message about
 * `executablePath or channel must be specified`.
 */
function findBrowserExecutable() {
  if (CONFIG.browserExecutable) return CONFIG.browserExecutable;

  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      ]
    : process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`,
      ]
    : [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chrome",
        "/opt/google/chrome/chrome",
        "/snap/bin/chromium",
      ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

async function openBrowser() {
  if (CONFIG.browserWsEndpoint) {
    _ownsBrowser = false;
    return puppeteer.connect({ browserWSEndpoint: CONFIG.browserWsEndpoint });
  }
  if (CONFIG.browserUrl) {
    _ownsBrowser = false;
    return puppeteer.connect({ browserURL: CONFIG.browserUrl });
  }
  _ownsBrowser = true;

  // Resolve the binary up front so we either have an executablePath or a
  // channel — never neither (which is what puppeteer-core complains about).
  const exec = findBrowserExecutable();
  const launchOpts = {
    headless: "new",
    args: SLIM_ARGS,
  };
  if (exec) {
    launchOpts.executablePath = exec;
  } else {
    // No executable found on disk — tell puppeteer-core to look for a
    // system-managed Chrome. If nothing is on PATH the launch itself will
    // fail with a clear error from puppeteer.
    launchOpts.channel = "chrome";
  }
  try {
    return await puppeteer.launch(launchOpts);
  } catch (e) {
    log("stream_error", `puppeteer.launch failed: ${e.message}. Set BROWSER_EXECUTABLE in .env to a Chrome/Chromium binary.`);
    throw e;
  }
}

export function startStream() {
  if (_running) return;
  _running = true;
  _stopped = false;
  const db = getDB();
  log("stream", "Starting arb-stream ingester...");

  (async function loop() {
    while (!_stopped) {
      try {
        _browser = await openBrowser();
        _browser.on("disconnected", () => {
          health.connected = false;
        });
        const page = await _browser.newPage();

        // Drop heavy resources to save memory/CPU (keep JS/XHR/WS).
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const t = req.resourceType();
          if (t === "image" || t === "media" || t === "font") req.abort().catch(() => {});
          else req.continue().catch(() => {});
        });

        const client = await page.target().createCDPSession();
        await client.send("Network.enable");
        client.on("Network.webSocketCreated", ({ url }) => {
          health.connected = true;
          // Debounce: sandwiched.me's WS flaps (reconnects every few seconds
          // when Cloudflare rotates), flooding the log. Throttle to one
          // message per URL per 5 minutes.
          const now = Date.now();
          if (!_lastWsOpenAt[url] || now - _lastWsOpenAt[url] > 300_000) {
            _lastWsOpenAt[url] = now;
            log("stream", `WS open: ${url}`);
          }
        });
        client.on("Network.webSocketFrameReceived", ({ response }) => {
          if (!response?.payloadData) return;
          health.framesTotal++;
          const payload = String(response.payloadData);

          // Frame-shape discovery: log the first N frames in full so the
          // operator can confirm the WS is delivering anything at all and
          // what the payload looks like. Truncated to 240 chars per line.
          if (_loggedFrames.length < FRAME_LOG_LIMIT) {
            const head = payload.slice(0, 240).replace(/\n/g, " ");
            log("stream", `frame #${_loggedFrames.length + 1} (${payload.length}b): ${head}${payload.length > 240 ? "…" : ""}`);
            _loggedFrames.push(payload);
          }

          let msg = null;
          try { msg = JSON.parse(payload); } catch { /* non-JSON, already logged above */ }
          if (!msg) return;

          if (msg.channel === "AtomicArbs") {
            health.lastFrameAt = Date.now();
            recordArbFrame(db, msg);
          } else if (msg.type === "AtomicArbs" || msg.kind === "AtomicArbs") {
            // Some WS implementations nest the channel under type/kind.
            health.lastFrameAt = Date.now();
            recordArbFrame(db, msg);
          }
        });

        await page.goto(CONFIG.streamUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
        log("stream", "Page loaded; listening for arb frames...");

        // Stay alive until stopped or the browser disconnects.
        let lastHeartbeat = 0;
        while (!_stopped) {
          if (!isBrowserConnected(_browser)) break;
          await new Promise((r) => setTimeout(r, 2000));
          if (Date.now() - lastHeartbeat > 300_000) {
            log("stream", `Heartbeat — ${health.arbsTotal} arbs, ${health.tokensSeen} token events, last frame ${health.lastFrameAt ? Math.round((Date.now() - health.lastFrameAt) / 1000) + "s ago" : "never"}`);
            lastHeartbeat = Date.now();
          }
        }
      } catch (e) {
        log("stream_error", `Cycle error: ${e.message}`);
      } finally {
        health.connected = false;
        try {
          if (_browser) _ownsBrowser ? await _browser.close() : await _browser.disconnect();
        } catch {}
        _browser = null;
      }
      if (!_stopped) await new Promise((r) => setTimeout(r, CONFIG.streamReconnectMs));
    }
    _running = false;
    log("stream", "Stopped");
  })();
}

export function stopStream() {
  _stopped = true;
}
