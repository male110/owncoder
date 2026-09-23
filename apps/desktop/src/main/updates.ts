import { app, shell } from "electron";
import { NsisUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import type {
  UpdateCheckOutcomeDto,
  UpdateDownloadStatusDto,
  UpdateInfoDto,
} from "../preload/index";
import { mt } from "./i18n";

/**
 * 基于 electron-updater 的自动更新。
 *
 * 产物分布（详见 `apps/desktop/scripts/publish-release.mjs` 与 README）：
 *   - Gitee release 资产：仅上传 ~5MB 的 `*-web.exe` 引导器（满足 Gitee 100M 上限）
 *   - OSS 桶（Aliyun OSS / 腾讯 COS）：全量 `.exe`、`.blockmap`、`.nsis.delta`、`latest.yml`
 *
 * 启动期 `app.whenReady()` 会注入一次 `checkForUpdates()`，渲染层也可手动触发。
 * 渲染层 IPC 协议不变：`UpdateInfoDto` / `UpdateCheckOutcomeDto` / `UpdateDownloadStatusDto`。
 *
 * dev / 非 Windows / 非打包版跳过更新检查与下载。
 */

const FETCH_TIMEOUT_MS = 20_000;
const RELEASE_PAGE = "https://gitee.com/f6688/owncoder/releases";

let statusSink: ((status: UpdateDownloadStatusDto) => void) | null = null;
let downloadInProgress = false;
let currentUpdater: NsisUpdater | null = null;
let lastUpdateInfo: UpdateInfo | null = null;

function canAutoUpdate(): boolean {
  return app.isPackaged && process.platform === "win32";
}

/** 把 electron-updater 的 UpdateInfo 转成 IPC 层用的 UpdateInfoDto（不暴露内部字段）。 */
function toUpdateInfoDto(info: UpdateInfo): UpdateInfoDto {
  const rawVersion = info.version ?? "";
  return {
    version: rawVersion.replace(/^v/i, ""),
    tagName: rawVersion,
    name: info.releaseName ?? rawVersion,
    notes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
    downloadUrl: typeof info.files?.[0]?.url === "string" ? info.files[0].url : RELEASE_PAGE,
    releaseUrl: RELEASE_PAGE,
    publishedAt: typeof info.releaseDate === "string" ? info.releaseDate : undefined,
    canAutoUpdate: canAutoUpdate(),
  };
}

function ensureUpdater(): NsisUpdater | null {
  if (!canAutoUpdate()) return null;
  if (currentUpdater) return currentUpdater;
  const updater = new NsisUpdater();
  // 手动控制下载/安装时机；状态通过 statusSink 推给渲染层。
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  updater.on("download-progress", (progress: ProgressInfo) => {
    const percent = Math.round(progress.percent ?? 0);
    statusSink?.({ state: "downloading", percent: Math.min(99, Math.max(0, percent)) });
  });
  updater.on("update-downloaded", (info: UpdateInfo) => {
    lastUpdateInfo = info;
    statusSink?.({ state: "downloaded" });
  });
  updater.on("error", (err: Error) => {
    statusSink?.({
      state: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  });

  currentUpdater = updater;
  return updater;
}

/** 拉取最新发布信息（OSS 上的 `latest.yml`）；失败返回 null。 */
export async function fetchLatestRelease(): Promise<UpdateInfoDto | null> {
  const updater = ensureUpdater();
  if (!updater) return null;
  try {
    const result = await withTimeout(updater.checkForUpdates(), FETCH_TIMEOUT_MS);
    if (!result?.updateInfo) return null;
    lastUpdateInfo = result.updateInfo;
    return toUpdateInfoDto(result.updateInfo);
  } catch {
    return null;
  }
}

/** 完整检查流程：比较本地版本与最新发布（纯检测，不触发下载）。 */
export async function checkForUpdates(): Promise<UpdateCheckOutcomeDto> {
  const current = app.getVersion();
  const info = await fetchLatestRelease();
  if (!info) {
    return { status: "error", currentVersion: current, message: mt("无法获取最新版本信息") };
  }
  // semver 比较：electron-updater 内部已过滤，只有更新时才会返回 updateInfo
  if (info.version && info.version !== current) {
    return { status: "update-available", currentVersion: current, info };
  }
  return { status: "up-to-date", currentVersion: current };
}

/** 用系统默认浏览器打开更新地址（发布页或安装包直链）。 */
export function openUpdateUrl(url: string): void {
  void shell.openExternal(url).catch(() => {
    /* 用户无默认浏览器等场景静默失败 */
  });
}

/** 注册下载状态回调；由 IPC 层注入（需要把状态推给渲染层）。 */
export function initUpdateStatusSink(sink: (status: UpdateDownloadStatusDto) => void): void {
  statusSink = sink;
}

/** 下载最新安装包（后台，带进度）。失败返回 false，具体原因走 statusSink。 */
export async function downloadUpdatePackage(): Promise<boolean> {
  const updater = ensureUpdater();
  if (!updater) return false;
  if (downloadInProgress) return true; // 已在下载中，避免重入

  downloadInProgress = true;
  try {
    // 还没拉过最新清单就先拉一次
    if (!lastUpdateInfo) {
      const check = await withTimeout(updater.checkForUpdates(), FETCH_TIMEOUT_MS);
      lastUpdateInfo = check?.updateInfo ?? null;
    }
    if (!lastUpdateInfo) {
      statusSink?.({ state: "failed", message: mt("无法获取最新版本信息") });
      return false;
    }
    await withTimeout(updater.downloadUpdate(), FETCH_TIMEOUT_MS * 6);
    return true;
  } catch (err) {
    statusSink?.({
      state: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    downloadInProgress = false;
  }
}

/** 安装已下载的更新（静默安装并重启）；未下载完成时忽略。 */
export function installDownloadedUpdate(): void {
  const updater = ensureUpdater();
  if (!updater || !lastUpdateInfo) return;
  // quitAndInstall 内部会调度应用退出 + 启动安装器，参数控制静默与覆盖安装。
  void updater.quitAndInstall();
}

/** Promise 超时包装，避免 electron-updater 卡死整个检查流程。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(mt("请求超时（{{ms}}ms）", { ms }))), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}