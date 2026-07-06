#!/usr/bin/env node
// Docker HEALTHCHECK probe — exit 0 healthy, exit 1 unhealthy.
// Unhealthy = open positions exist but the daemon heartbeat (written after
// every management cycle) is stale: the process is hung or its loops died.
// A crash is already covered by `restart: unless-stopped`; this catches the
// alive-but-stuck case. No Telegram here — healthchecks run constantly and
// must be silent; docker ps / `docker events` surface the status, and the
// full-fat scripts/watchdog.mjs (host cron) does the alerting if you want it.
//
// Env: DATA_DIR (set in docker-compose), HEALTHCHECK_STALE_MINUTES (default 25).

import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const STALE_MINUTES = Number(process.env.HEALTHCHECK_STALE_MINUTES || 25);

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const state = readJson(path.join(DATA_DIR, "state.json"), { positions: {} });
const openCount = Object.values(state.positions || {}).filter((p) => !p.closed).length;
if (openCount === 0) {
  // Nothing at risk — a quiet daemon between deploys is healthy.
  process.exit(0);
}

const hb = readJson(path.join(DATA_DIR, "heartbeat.json"));
const hbAt = hb?.at ? Date.parse(hb.at) : NaN;
const staleMinutes = Number.isFinite(hbAt) ? (Date.now() - hbAt) / 60000 : Infinity;

if (staleMinutes >= STALE_MINUTES) {
  console.error(`unhealthy: heartbeat ${Number.isFinite(staleMinutes) ? Math.round(staleMinutes) + "m stale" : "missing"} with ${openCount} open position(s)`);
  process.exit(1);
}
process.exit(0);
