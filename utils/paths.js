import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use /data on EasyPanel (or any platform with persistent volume), fallback to project dir
const DATA_ROOT = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : __dirname);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(DATA_ROOT);

export const PATHS = {
  root: DATA_ROOT,
  data: DATA_ROOT,
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
  // ML / deep learning
  mlModel: path.join(DATA_ROOT, "ml", "ml-model.json"),
  mlDir: path.join(DATA_ROOT, "ml"),
};

export function getPath(name) {
  return PATHS[name];
}