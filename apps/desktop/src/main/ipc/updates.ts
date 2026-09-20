import { ipcMain } from "electron";
import {
  checkForUpdates,
  downloadUpdatePackage,
  initUpdateStatusSink,
  installDownloadedUpdate,
  openUpdateUrl,
} from "../updates";
import type { IpcContext } from "./types";

/** 更新检查/自动下载相关 IPC。 */
export function registerUpdateHandlers(ctx: IpcContext): void {
  // 主进程把下载进度/完成/失败推给渲染层（窗口不可用时安全丢弃）。
  initUpdateStatusSink((status) => {
    const win = ctx.getWindow();
    if (!win || win.isDestroyed() || !ctx.isRendererReady()) return;
    win.webContents.send("updates:downloadStatus", status);
  });

  ipcMain.handle("updates:check", () => checkForUpdates());
  ipcMain.handle("updates:download", () => downloadUpdatePackage());
  ipcMain.on("updates:install", () => installDownloadedUpdate());
  ipcMain.on("updates:open", (_event, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) openUpdateUrl(url);
  });
}