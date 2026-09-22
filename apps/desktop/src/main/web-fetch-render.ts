/**
 * Lightweight CSR page renderer for web_fetch.
 *
 * Reuses a single hidden BrowserWindow (show:false) instead of spawning
 * Puppeteer/Playwright or creating an offscreen window per request.
 * Requests are serialized so concurrent web_fetch calls share one Chromium
 * guest page safely.
 */
import { BrowserWindow, app } from "electron";

export type RenderPageResult = {
  html?: string;
  text?: string;
};

type RenderOpts = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 25_000;
/** Initial pause after dom-ready before first content sample. */
const SETTLE_INITIAL_MS = 800;
/** Poll interval while waiting for CSR text to grow/stabilize. */
const SETTLE_POLL_MS = 400;
/** Stop early once visible text stays this long for 2 consecutive samples. */
const SETTLE_MIN_CHARS = 200;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let sharedWin: BrowserWindow | null = null;
let queue: Promise<unknown> = Promise.resolve();

function ensureWindow(): BrowserWindow {
  if (sharedWin && !sharedWin.isDestroyed() && !sharedWin.webContents.isDestroyed()) {
    return sharedWin;
  }
  sharedWin = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      // Guest page only — no Node / preload bridge.
      offscreen: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: true,
      images: false,
      webSecurity: true,
    },
  });
  sharedWin.webContents.setUserAgent(USER_AGENT);
  sharedWin.webContents.setAudioMuted(true);
  sharedWin.on("closed", () => {
    sharedWin = null;
  });
  return sharedWin;
}

function waitForDomReady(win: BrowserWindow, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const wc = win.webContents;
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onFail = (_e: Electron.Event, _code: number, desc: string) => {
      cleanup();
      reject(new Error(`load failed: ${desc || "unknown"}`));
    };
    const onAbort = () => {
      cleanup();
      try {
        wc.stop();
      } catch {
        /* ignore */
      }
      reject(signal?.reason ?? new Error("aborted"));
    };
    const cleanup = () => {
      wc.removeListener("dom-ready", onReady);
      wc.removeListener("did-fail-load", onFail);
      signal?.removeEventListener("abort", onAbort);
    };
    wc.once("dom-ready", onReady);
    wc.once("did-fail-load", onFail);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function extractContent(win: BrowserWindow): Promise<RenderPageResult> {
  const result = (await win.webContents.executeJavaScript(
    `(() => {
      try {
        const html = document.documentElement ? document.documentElement.outerHTML : (document.body?.outerHTML ?? "");
        const text = document.body ? (document.body.innerText || document.body.textContent || "") : "";
        return { html, text };
      } catch (e) {
        return { html: "", text: String(e) };
      }
    })()`,
    true,
  )) as RenderPageResult;
  return {
    html: typeof result?.html === "string" ? result.html : "",
    text: typeof result?.text === "string" ? result.text : "",
  };
}

async function waitForContentSettle(
  win: BrowserWindow,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<RenderPageResult> {
  await delay(SETTLE_INITIAL_MS, signal);
  let last = await extractContent(win);
  let stableHits = 0;
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (signal.aborted) break;
    await delay(SETTLE_POLL_MS, signal);
    const next = await extractContent(win);
    const prevLen = (last.text ?? "").replace(/\s+/g, " ").trim().length;
    const nextLen = (next.text ?? "").replace(/\s+/g, " ").trim().length;
    last = next;
    if (nextLen >= SETTLE_MIN_CHARS && nextLen <= prevLen + 20) {
      stableHits += 1;
      if (stableHits >= 2) break;
    } else {
      stableHits = 0;
    }
  }
  return last;
}

async function renderOne(url: string, opts?: RenderOpts): Promise<RenderPageResult | null> {
  if (!app.isReady()) return null;
  const timeoutMs = Math.max(3_000, Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000));
  const signal = opts?.signal;
  if (signal?.aborted) return null;

  const win = ensureWindow();
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("render timeout")), timeoutMs);

  try {
    // Attach ready/fail listeners BEFORE loadURL to avoid missing a fast dom-ready.
    const ready = waitForDomReady(win, controller.signal);
    const nav = win.loadURL(url).catch(() => undefined);
    await Promise.race([ready, nav.then(() => ready)]);
    // Poll until visible text stabilizes (CSR hydrate) or the remaining budget ends.
    const settleBudget = Math.max(1_500, timeoutMs - 3_000);
    return await waitForContentSettle(win, controller.signal, settleBudget);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
    try {
      win.webContents.stop();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Render a URL in the shared hidden BrowserWindow and return post-JS HTML/text.
 * Concurrent callers are queued (single guest page).
 */
export function renderPage(url: string, opts?: RenderOpts): Promise<RenderPageResult | null> {
  const run = queue.then(() => renderOne(url, opts));
  // Keep the chain alive even when a render fails/returns null.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Tear down the shared window (e.g. on app quit). */
export function disposeWebFetchRenderer(): void {
  const win = sharedWin;
  sharedWin = null;
  if (win && !win.isDestroyed()) {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
}
