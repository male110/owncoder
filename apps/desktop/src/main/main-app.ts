import { app, BrowserWindow, ipcMain, Menu, Notification } from "electron";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createCompatibilityAdapter } from "@owncoder/core";
import { SettingsStore } from "./settings-store";
import { RecentStore } from "./recent-store";
import { ensureDefaultWorkspace, migrateWorkspaceDotDir } from "./default-workspace";
import { SecretsStore } from "./secrets-store";
import { disposeAllPty } from "./pty";
import { registerAllHandlers, type IpcContext } from "./ipc/index";
import { checkForUpdates } from "./updates";
import { indexHost } from "./index-host";

/**
 * electron-vite 产物布局：
 *   out/main/index.js            入口
 *   out/main/chunks/*.js         主进程代码分割后的模块（__dirname 可能落在这里）
 *   out/preload/index.js
 *   out/renderer/index.html
 *
 * 先建 out 子目录再迁移/拆包后，若仍用 `join(__dirname, "../preload")`，
 * 会从 chunks/ 解析到不存在的 out/main/preload，preload 注入失败，
 * 渲染进程 `window.owncoder` 整棵为 undefined。
 */
function appOutRoot(): string {
  let dir = __dirname;
  // Walk up until we find a directory that contains preload/ (or hit filesystem root).
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "preload", "index.js"))) return dir;
    if (basename(dir) === "chunks") {
      dir = join(dir, "..");
      continue;
    }
    if (basename(dir) === "main") {
      dir = join(dir, "..");
      continue;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: historical layout relative to main/chunks.
  dir = __dirname;
  if (basename(dir) === "chunks") dir = join(dir, "..");
  if (basename(dir) === "main") dir = join(dir, "..");
  return dir;
}

function preloadScriptPath(): string {
  const candidate = join(appOutRoot(), "preload", "index.js");
  if (!existsSync(candidate)) {
    console.error(`[main] preload script missing at ${candidate} (__dirname=${__dirname})`);
  }
  return candidate;
}

function rendererIndexPath(): string {
  return join(appOutRoot(), "renderer", "index.html");
}

// When the Electron process is launched without a console (e.g. double-clicking
// the .exe or via a GUI shortcut), stdout/stderr pipes may already be closed.
// Writing to a broken pipe throws EPIPE, which crashes the main process. Monkey-
// patch the write streams to swallow EPIPE so that legitimate logging never
// kills the app, and log stream-switch events for diagnostics.
for (const stream of [process.stdout, process.stderr]) {
  const origWrite = stream.write.bind(stream);
  stream.write = function (
    chunk: string | Buffer | Uint8Array,
    ...rest: unknown[]
  ): boolean {
    try {
      // Call origWrite with proper overload handling
      if (rest.length === 0) {
        return origWrite(chunk as string);
      } else if (rest.length === 1) {
        return origWrite(chunk as string, rest[0] as BufferEncoding);
      } else {
        return origWrite(chunk as string, rest[0] as BufferEncoding, rest[1] as ((err?: Error | null) => void));
      }
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as NodeJS.ErrnoException).code === "EPIPE"
      ) {
        // Stream is gone — silently discard
        return true;
      }
      throw err;
    }
  } as typeof origWrite;
}

// The renderer DOM and styles are healthy, but this Windows environment fails
// to present Chromium's GPU-composited surface. Force software rendering and
// disable DirectComposition before Electron is ready so content is painted via
// the compatible window-composition path.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-direct-composition");
// Raise V8 old-space before app.ready. Default ~2GB is too small for the
// main-process workspace index + embedding path during `electron-vite dev`.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");

// ── Singletons ────────────────────────────────────────────────────────────────

const userDataDir = app.getPath("userData");
const settingsStore = new SettingsStore(userDataDir);
const chatBufferRef: { removeSession: (sessionId: string | null) => void; flushAll: () => void } = {
  removeSession() {},
  flushAll() {},
};
settingsStore.reload();
const recentStore = new RecentStore(userDataDir);
const secretsStore = new SecretsStore(userDataDir);

const session = createCompatibilityAdapter();
session.setWorkflow(settingsStore.getEffective());
session.setLlmApiKey(secretsStore.load().llmApiKey);
session.setMemoriesDir(settingsStore.memoriesDir);

let mainWindow: BrowserWindow | null = null;
let settingsPanelOpen = false;

// Main-frame liveness, tracked from webContents lifecycle events. Push IPC
// channels gate on this (see renderer-send.ts): after a failed reload the
// webContents is neither destroyed nor crashed, yet its main frame is already
// disposed, and every send into it logs "Render frame was disposed".
let rendererReady = false;
// Consecutive main-frame load failures; reset by every successful load.
let loadRetries = 0;
const MAX_LOAD_RETRIES = 3;

function migrateWorkspaceMetadata(root: string): void {
  // `.owncode` → `.owncoder`；若先建了空 `.owncoder` 也会被安全替换。
  migrateWorkspaceDotDir(root);
}

type PendingDangerousConfirmation = {
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingDangerousConfirmations = new Map<string, PendingDangerousConfirmation>();
let dangerousConfirmationSeq = 0;

function settleDangerousConfirmation(requestId: string, allowed: boolean): void {
  const pending = pendingDangerousConfirmations.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingDangerousConfirmations.delete(requestId);
  pending.resolve(allowed);
}

function rejectPendingDangerousConfirmations(): void {
  for (const requestId of pendingDangerousConfirmations.keys()) {
    settleDangerousConfirmation(requestId, false);
  }
  // Renderer is gone/unreachable: drop every pending ask_user prompt too, so
  // no agent turn stays blocked waiting for an answer that can never arrive.
  rejectPendingAskRequests();
}

type PendingAskUser = {
  resolve: (answer: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingAskRequests = new Map<string, PendingAskUser>();
let askUserSeq = 0;

function settleAskUser(requestId: string, answer: string): void {
  const pending = pendingAskRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingAskRequests.delete(requestId);
  pending.resolve(answer);
}

function rejectPendingAskRequests(): void {
  for (const requestId of pendingAskRequests.keys()) {
    settleAskUser(requestId, "");
  }
}

/**
 * When the main window is not focused (user is in another app), show a brief
 * OS toast in the bottom-right so they notice a pending confirmation. Auto-
 * closes after 5s; clicking the toast focuses OwnCoder. Does not change the
 * confirmation flow itself.
 */
function notifyConfirmationNeeded(title: string, body: string): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  // Only notify when OwnCoder is not the foreground window.
  if (win.isFocused()) return;
  if (!Notification.isSupported()) return;

  const notification = new Notification({
    title,
    body,
    silent: false,
    timeoutType: "default",
  });

  const closeTimer = setTimeout(() => {
    try {
      notification.close();
    } catch {
      /* already dismissed */
    }
  }, 5_000);

  notification.on("click", () => {
    clearTimeout(closeTimer);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  notification.on("close", () => {
    clearTimeout(closeTimer);
  });

  notification.show();
}

/**
 * Forward an ask_user request to the renderer and block until the user answers.
 * Returns "" (treated as "cancelled / no answer") when the window is gone, the
 * frame is not ready, the send fails, or the 5-minute timeout elapses — the
 * agent then receives an empty answer rather than hanging forever.
 */
function requestAskUser(
  req: { question: string; options: Array<{ label: string; value: string; description?: string }>; allowFreeText?: boolean; placeholder?: string },
  sessionId?: string,
): Promise<string> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return Promise.resolve("");
  if (!rendererReady) return Promise.resolve("");

  const requestId = `ask_${Date.now().toString(36)}_${(++askUserSeq).toString(36)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settleAskUser(requestId, ""), 300_000);
    pendingAskRequests.set(requestId, { resolve, timer });
    try {
      win.webContents.send("ask:request", {
        requestId,
        question: req.question,
        options: req.options,
        allowFreeText: req.allowFreeText ?? false,
        placeholder: req.placeholder ?? undefined,
        sessionId: sessionId ?? null,
      });
      const preview = req.question.length > 80 ? `${req.question.slice(0, 80)}…` : req.question;
      notifyConfirmationNeeded("OwnCoder 需要你确认", preview || "Agent 弹出了选择框，请回到应用确认");
    } catch {
      settleAskUser(requestId, "");
    }
  });
}

function requestDangerousConfirmation(command: string, sessionId?: string): Promise<boolean> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  // Fail closed while the frame cannot receive the prompt (reload in flight or
  // a load that failed outright) - same policy as close and timeout.
  if (!rendererReady) return Promise.resolve(false);

  const requestId = `danger_${Date.now().toString(36)}_${(++dangerousConfirmationSeq).toString(36)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settleDangerousConfirmation(requestId, false), 120_000);
    pendingDangerousConfirmations.set(requestId, { resolve, timer });
    try {
      win.webContents.send("security:dangerousCommandRequest", { requestId, command, sessionId: sessionId ?? null });
      const preview = command.length > 80 ? `${command.slice(0, 80)}…` : command;
      notifyConfirmationNeeded("OwnCoder 需要确认命令", preview || "有待执行命令需要你确认");
    } catch {
      settleDangerousConfirmation(requestId, false);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const abs = resolve(workspaceRoot, inputPath);
  const rel = relative(workspaceRoot, abs);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error("path escapes workspace");
  }
  return abs;
}

async function openWorkspaceRoot(root: string): Promise<{ root: string; name: string } | null> {
  if (!existsSync(root)) return null;
  migrateWorkspaceMetadata(root);
  const name = basename(root);
  settingsStore.setProjectRoot(root);
  session.setWorkflow(settingsStore.getEffective());
  await session.openWorkspace(root, name);
  recentStore.ensureProject(root, name);
  recentStore.setLastWorkspace(root, name);
  // Writable index build runs in a UtilityProcess so the main V8 heap never
  // holds whole-repo file contents during startup.
  const workflow = settingsStore.getEffective();
  if (workflow.index?.enabled !== false) {
    indexHost.start(root, workflow.index?.extraIgnore ?? []);
  }
  return { root, name };
}

/**
 * 轻量级切换工作区：只更新活跃工作区引用，不清理会话。
 * 用于已加载的项目之间的快速切换，避免终止正在运行的会话。
 */
async function switchWorkspaceRoot(root: string): Promise<{ root: string; name: string } | null> {
  if (!existsSync(root)) return null;
  migrateWorkspaceMetadata(root);
  const name = basename(root);
  settingsStore.setProjectRoot(root);
  session.setWorkflow(settingsStore.getEffective());
  // switchWorkspace 内部会 cleanupAllSessions：只清已完成会话，跳过运行中的。
  await session.switchWorkspace(root, name);
  recentStore.setLastWorkspace(root, name);
  chatBufferRef.flushAll();
  const workflow = settingsStore.getEffective();
  if (workflow.index?.enabled !== false) {
    indexHost.start(root, workflow.index?.extraIgnore ?? []);
  } else {
    indexHost.stop();
  }
  return { root, name };
}

/**
 * Schedule a retry load of the renderer page. Both transient load failures and
 * hard crashes leave the window with no usable document, so the same recovery
 * strategy applies: poll up to MAX_LOAD_RETRIES times, increasing delay each
 * attempt. On first successful load (dom-ready) the counter resets.
 */
function scheduleRendererReload(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (loadRetries >= MAX_LOAD_RETRIES) {
    console.error(
      `[renderer:load-failed] page unreachable after ${loadRetries} retries - ` +
        "stopping in-flight agent turns",
    );
    session.cancelAllTurns();
    rejectPendingDangerousConfirmations();
    return;
  }
  const attempt = ++loadRetries;
  const delayMs = 1000 * attempt;
  console.log(
    `[renderer:load-failed] reloading in ${delayMs}ms (attempt ${attempt}/${MAX_LOAD_RETRIES})`,
  );
  const url =
    process.env.ELECTRON_RENDERER_URL ||
    pathToFileURL(rendererIndexPath()).href;
  setTimeout(() => {
    if (win.isDestroyed()) return;
    void win.webContents.loadURL(url).catch(() => {
      /* the resulting did-fail-load drives the next retry or the give-up */
    });
  }, delayMs);
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(): void {
  rendererReady = false;
  loadRetries = 0;
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "OwnCoder",
    backgroundColor: "#0c0d0f",
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0c0d0f",
      symbolColor: "#848b96",
      height: 36,
    },
    webPreferences: {
      preload: preloadScriptPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Renderer failures used to leave only BrowserWindow's dark background visible.
  // Record browser-console and process/load failures so a production black screen
  // has a concrete error trail in the launch terminal.
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const prefix = `[renderer:console:${level}] ${sourceId}:${line}`;
    if (level >= 2) console.error(prefix, message);
    else console.log(prefix, message);
  });
  mainWindow.webContents.on("did-start-loading", () => {
    // A load is in flight (initial load or reload): the current frame can be
    // replaced at any moment, so stop pushing until the new document is ready.
    rendererReady = false;
  });
  mainWindow.webContents.on("dom-ready", () => {
    rendererReady = true;
    loadRetries = 0;
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[renderer:process-gone]", details.reason, `exitCode=${details.exitCode}`);
    // The render frame is gone (crash or clean exit). Stop every in-flight
    // agent turn so streaming deltas stop firing emitChat into a disposed
    // frame (which floods the log with "Render frame was disposed" errors).
    rendererReady = false;
    session.cancelAllTurns();
    void session.cleanupAllSessions();
    rejectPendingDangerousConfirmations();
    // Renderer crashes (OOM, GPU process death, etc.) leave the window with no
    // document. Schedule a reload the same way as did-fail-load so the page
    // recovers instead of staying black.
    scheduleRendererReload(mainWindow);
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      console.error(
        "[renderer:load-failed]",
        `code=${errorCode}`,
        errorDescription,
        validatedUrl,
        `mainFrame=${isMainFrame}`,
      );
      if (!isMainFrame) return;
      rendererReady = false;
      // ERR_ABORTED (-3): the load was cancelled or superseded (e.g. the window
      // closing mid-load); retrying would fight the cancellation.
      if (errorCode === -3) return;
      // Delegate to the shared retry helper so both load failures and crashes
      // follow the same recovery path.
      scheduleRendererReload(mainWindow!);
    },
  );
  mainWindow.webContents.on("unresponsive", () => {
    console.error("[renderer:unresponsive]");
  });
  // Intercept close: if settings panel is open, close it first instead of quitting.
  mainWindow.on("close", (e) => {
    if (settingsPanelOpen) {
      e.preventDefault();
      settingsPanelOpen = false;
      mainWindow?.webContents.send("app:closeSettingsPanel");
      return;
    }
    // Never leave an agent waiting on a renderer response while the window is closing.
    rejectPendingDangerousConfirmations();
  });

  mainWindow.on("closed", () => {
    // The renderer can no longer receive events. Stop every in-flight agent
    // turn so streaming deltas stop firing emitChat into a disposed frame.
    rendererReady = false;
    session.cancelAllTurns();
    void session.cleanupAllSessions();
    rejectPendingDangerousConfirmations();
    indexHost.stop();
    disposeAllPty();
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(rendererIndexPath());
  }
}

// ── App bootstrap ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  // The renderer owns presentation; the main process remains the security boundary.
  // Responses are request-id based and fail closed on timeout, close, or reload.
  session.setDangerousBashConfirmer((command, sessionId) => requestDangerousConfirmation(command, sessionId));
  session.setAskUserHandler((req, sessionId) => requestAskUser(req, sessionId));

  // Build the shared context bag and register all IPC domains.
  const ipcCtx: IpcContext = {
    getWindow: () => mainWindow,
    isRendererReady: () => rendererReady,
    session,
    settingsStore,
    recentStore,
    secretsStore,
    openWorkspaceRoot,
    switchWorkspaceRoot,
    resolveWorkspacePath,
    chatBufferRef,
  };
  registerAllHandlers(ipcCtx);

  ipcMain.on("security:dangerousCommandResponse", (event, requestId: unknown, allowed: unknown) => {
    if (event.sender !== mainWindow?.webContents) return;
    if (typeof requestId !== "string" || typeof allowed !== "boolean") return;
    settleDangerousConfirmation(requestId, allowed);
  });

  ipcMain.on("ask:response", (event, requestId: unknown, answer: unknown) => {
    if (event.sender !== mainWindow?.webContents) return;
    if (typeof requestId !== "string" || typeof answer !== "string") return;
    settleAskUser(requestId, answer);
  });

  // Settings-panel open/close sync (fire-and-forget; no response needed).
  ipcMain.on("app:settingsPanelState", (_e, open: boolean) => {
    settingsPanelOpen = open;
  });

  // App version for the titlebar display; read from package.json at runtime
  // so packaged builds and dev share the single source of truth.
  ipcMain.handle("app:version", () => app.getVersion());

  // Keep native frameless chrome (overlay + window background) in sync with UI theme.
  ipcMain.handle("app:setChromeTheme", (_e, theme: unknown) => {
    if (!mainWindow || (theme !== "dark" && theme !== "codex")) return;
    const isLight = theme === "codex";
    const background = isLight ? "#f4f2ee" : "#0c0d0f";
    const symbol = isLight ? "#6f6b64" : "#848b96";
    mainWindow.setBackgroundColor(background);
    try {
      mainWindow.setTitleBarOverlay({
        color: background,
        symbolColor: symbol,
        height: 36,
      });
    } catch {
      /* Overlay API may be unavailable on some platforms/builds. */
    }
  });

  // Re-focus and raise the main window. Used after a native confirm() dialog
  // steals focus, so subsequent interaction with the renderer works again.
  ipcMain.on("app:focusWindow", (event) => {
    if (event.sender !== mainWindow?.webContents) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // Restore last workspace (or fall back to default).
  const userData = app.getPath("userData");
  const builtIn = ensureDefaultWorkspace(userData);
  // Keep recent-store path map in sync after OwnCodeProject → OwnCoderProject rename.
  recentStore.setBuiltinRoot(builtIn.root);
  // Built-in must stay at the bottom of the project list (ensureProject appends it last).
  recentStore.ensureProject(builtIn.root, builtIn.name);

  // History-vector / ONNX is heavy. Defer construction until first archive/search
  // so it does not stack with workspace open + index worker startup.
  let historyVectorReady: Promise<void> | null = null;
  const ensureHistoryVector = async (): Promise<void> => {
    if (historyVectorReady) return historyVectorReady;
    historyVectorReady = (async () => {
      try {
        const { createHistoryVector, configureEmbeddingCacheDir } = await import("./history-vector");
        const embeddingDir = app.isPackaged
          ? join(process.resourcesPath, "embedding-model")
          : join(app.getAppPath(), "assets", "embedding-model");
        configureEmbeddingCacheDir(embeddingDir);
        const hv = createHistoryVector(join(userData, "history-vector.db"));
        session.setHistoryVector(hv);
        console.log("[history-vector] 历史向量检索已启用（lazy）");
      } catch (error) {
        console.warn("[history-vector] 初始化失败，降级为最近 N 轮历史：", error);
      }
    })();
    return historyVectorReady;
  };
  // Kick off shortly after first paint, not during openWorkspace.
  setTimeout(() => { void ensureHistoryVector(); }, 15_000);
  session.setIndexDirtySink((batch) => indexHost.invalidate(batch));

  const recent = recentStore.load().lastWorkspace;
  const restoreRoot = recent && existsSync(recent.root) ? recent.root : builtIn.root;
  const opened = await openWorkspaceRoot(restoreRoot);

  createWindow();

  // 更新检查：仅打包版开启。启动后延迟 8 秒（不干扰首屏）首次检查，
  // 之后每 4 小时复查一次；发现新版本时推送给渲染层显示提示条。
  if (app.isPackaged) {
    const notifyAvailableUpdate = async (): Promise<void> => {
      const outcome = await checkForUpdates();
      if (outcome.status !== "update-available") return;
      if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) return;
      mainWindow.webContents.send("updates:available", outcome.info);
    };
    setTimeout(() => { void notifyAvailableUpdate(); }, 8_000);
    setInterval(() => { void notifyAvailableUpdate(); }, 4 * 60 * 60 * 1000);
  }

  if (opened) {
    mainWindow?.webContents.send("workspace:restored", {
      root: opened.root,
      name: opened.name,
      sessionRestored: session.getState().sessionRestored,
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on("before-quit", async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  try {
    await session.drainPersists();
  } catch {
    /* ignore: flush 失败不阻塞退出 */
  }
  app.exit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
