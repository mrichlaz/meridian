import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { REPO_ROOT } from "../repo-root.js";

// Persistent data and log locations:
//   1. ${DATA_DIR} env var (if set + writable)
//   2. /data  (EasyPanel / generic Docker persistent volume)
//   3. /app/data + /app/logs (when repo lives at /app)
//   4. <repo>/data + <repo>/logs (fallback)
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; }
  catch { return false; }
}

function firstExisting(candidates) {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && isWritable(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

function resolveDir(envKey, candidates) {
  const configured = process.env[envKey];
  if (configured) {
    try { return ensureDir(configured); }
    catch { /* fall through */ }
  }
  const existing = firstExisting(candidates);
  if (existing) return existing;
  // Final fallback: create the first candidate (or repo-root-scoped)
  return ensureDir(candidates[0] || REPO_ROOT);
}

const DATA_ROOT = resolveDir("DATA_DIR", [
  "/data",
  path.join(REPO_ROOT, "data"),
  "/app/data",
]);
ensureDir(DATA_ROOT);

const LOG_ROOT = resolveDir("LOG_DIR", [
  "/logs",
  path.join(REPO_ROOT, "logs"),
  "/app/logs",
  path.join(DATA_ROOT, "logs"), // logs live alongside data if neither of the above exists
]);
ensureDir(LOG_ROOT);

export const PATHS = {
  root: DATA_ROOT,
  data: DATA_ROOT,
  logs: LOG_ROOT,
  userConfig: path.join(DATA_ROOT, "user-config.json"),
  state: path.join(DATA_ROOT, "state.json"),
  decisionLog: path.join(DATA_ROOT, "decision-log.json"),
  lessons: path.join(DATA_ROOT, "lessons.json"),
  poolMemory: path.join(DATA_ROOT, "pool-memory.json"),
  smartWallets: path.join(DATA_ROOT, "smart-wallets.json"),
  tokenBlacklist: path.join(DATA_ROOT, "token-blacklist.json"),
  hivemindCache: path.join(DATA_ROOT, "hivemind-cache.json"),
  signalWeights: path.join(DATA_ROOT, "signal-weights.json"),
  strategyLibrary: path.join(DATA_ROOT, "strategy-library.json"),
  deployerBlacklist: path.join(DATA_ROOT, "deployer-blacklist.json"),
  discordSignals: path.join(DATA_ROOT, "discord-signals.json"),
  performanceRejects: path.join(DATA_ROOT, "performance-rejects.json"),
  // ML / deep learning
  mlModel: path.join(DATA_ROOT, "ml", "ml-model.json"),
  mlDir: path.join(DATA_ROOT, "ml"),
};

export function getPath(name) {
  return PATHS[name];
}