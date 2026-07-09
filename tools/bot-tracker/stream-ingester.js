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
  const insEvent = db.prepare("INSERT OR IGNORE INTO events VALUES (?,?,?,?)");
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
        insEvent.run(sig, picked.mint, bot, ts);
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
  return puppeteer.launch({
    executablePath: CONFIG.browserExecutable || undefined,
    headless: "new",
    args: SLIM_ARGS,
  });
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
          log("stream", `WS open: ${url}`);
        });
        client.on("Network.webSocketFrameReceived", ({ response }) => {
          if (!response?.payloadData) return;
          health.framesTotal++;
          try {
            const msg = JSON.parse(response.payloadData);
            if (msg.channel === "AtomicArbs") {
              health.lastFrameAt = Date.now();
              recordArbFrame(db, msg);
            }
          } catch {
            /* non-JSON / partial frame */
          }
        });

        await page.goto(CONFIG.streamUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
        log("stream", "Page loaded; listening for arb frames...");

        // Stay alive until stopped or the browser disconnects.
        let lastHeartbeat = 0;
        while (!_stopped && _browser.isConnected()) {
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
