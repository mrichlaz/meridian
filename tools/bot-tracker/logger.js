import fs from "fs";
import path from "path";
import { PATHS, CONFIG } from "./config.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[CONFIG.logLevel] ?? 1;

/**
 * Simple leveled logger with daily-rotating file output.
 * Category substrings "error"/"warn" bump the level automatically.
 */
export function log(category, message) {
  const level = category.includes("error")
    ? "error"
    : category.includes("warn")
    ? "warn"
    : "info";
  if (LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${category.toUpperCase()}] ${message}`;
  console.log(line);

  try {
    const dateStr = timestamp.split("T")[0];
    const logFile = path.join(PATHS.logs, `tracker-${dateStr}.log`);
    fs.appendFileSync(logFile, line + "\n");
  } catch {
    /* logging must never crash the app */
  }
}
