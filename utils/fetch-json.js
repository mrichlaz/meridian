/**
 * Shared fetch helper with 429/5xx retry, jitter, and structured logging (4B).
 *
 * Usage:
 *   const data = await fetchJsonWithRetry(url, { method: "GET" });
 *   const out = await fetchJsonWithRetry(url, {
 *     method: "POST",
 *     headers: { "X-APIKEY": apiKey },
 *     body: JSON.stringify(payload),
 *     retries: 3,
 *   });
 *
 * Backoff is exponential with jitter, capped at 30s. 429/5xx are retried;
 * 4xx (other than 429) are not. 408 (timeout) is retried once.
 */

const DEFAULT_RETRIES = 4;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

function isRetryableStatus(status) {
  if (status === 429) return true;
  if (status === 408) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function isLikelyJsonResponse(contentType) {
  if (!contentType) return true;
  return /application\/json|text\/json/i.test(contentType);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt, baseDelayMs, maxDelayMs) {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  // Add ±20% jitter
  const jitter = exp * (0.8 + Math.random() * 0.4);
  return Math.max(50, Math.floor(jitter));
}

export async function fetchJsonWithRetry(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    label = url,
    signal,
    onRetry,
  } = options;

  const isCliMode = (process.env.MERIDIAN_RUNTIME_MODE || "").toLowerCase() === "cli";

  let lastError = null;
  let lastStatus = null;
  let lastBody = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), timeoutMs);
    // Compose external signal + our internal one
    const composedSignal = signal
      ? (() => {
          const controller = new AbortController();
          const onAbort = () => controller.abort();
          signal.addEventListener("abort", onAbort, { once: true });
          ac.signal.addEventListener("abort", onAbort, { once: true });
          return controller.signal;
        })()
      : ac.signal;

    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: composedSignal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        if (!isLikelyJsonResponse(res.headers.get("content-type"))) {
          return { ok: true, status: res.status, data: null, text: await res.text() };
        }
        const data = await res.json().catch(() => null);
        return { ok: true, status: res.status, data };
      }

      lastStatus = res.status;
      lastBody = (await res.text().catch(() => "")).slice(0, 500);

      if (!isRetryableStatus(res.status) || attempt >= retries) {
        return {
          ok: false,
          status: res.status,
          error: `HTTP ${res.status} ${res.statusText}`.trim(),
          body: lastBody,
        };
      }

      const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
      if (typeof onRetry === "function") {
        try { onRetry({ attempt, status: res.status, delayMs, label }); } catch { /* ignore */ }
      }
      await sleep(delayMs);
      continue;
    } catch (error) {
      lastError = error;
      clearTimeout(timeout);
      const retryable =
        error?.name === "AbortError" ||
        /timeout|fetch failed|socket hang up|ECONN/i.test(String(error?.message || ""));
      if (!retryable || attempt >= retries) {
        return { ok: false, status: lastStatus, error: error?.message || String(error) };
      }
      const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
      if (typeof onRetry === "function") {
        try { onRetry({ attempt, status: lastStatus, delayMs, label, error: error?.message }); } catch { /* ignore */ }
      }
      await sleep(delayMs);
      continue;
    }
  }

  return {
    ok: false,
    status: lastStatus,
    error: lastError?.message || `Failed after ${retries} attempts`,
    body: lastBody,
  };
}

/**
 * Convenience for plain JSON GET with API-key header.
 */
export async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 15_000, retries = 3 } = {}) {
  return fetchJsonWithRetry(url, { method, headers, body, timeoutMs, retries });
}
