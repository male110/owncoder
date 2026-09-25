/**
 * 主进程 i18n 接入：对话框标题、错误消息等用户可见文案。
 *
 * 语言偏好由渲染层经 `app:setLocaleOverride` 推送（持久化在渲染层 localStorage）；
 * 偏好为 "system" 时按 `app.getLocale()`（系统区域设置）判定：zh* → 中文，否则英文。
 */
import { app, ipcMain } from "electron";
import {
  isLocalePref,
  resolveLocale,
  setRuntimeLocale,
  t,
  type LocalePref,
  type MsgId,
  type MsgParams,
} from "../shared/i18n/core";

let pref: LocalePref = "system";

function sync(): void {
  setRuntimeLocale(resolveLocale(pref, app.getLocale()));
}

/** 注册 locale IPC 并完成首次语言判定；在 app ready 前后调用均可。 */
export function initLocaleIpc(): void {
  ipcMain.handle("app:getLocaleInfo", () => ({ osLocale: app.getLocale(), pref }));
  ipcMain.handle("app:setLocaleOverride", (_e, p: unknown) => {
    pref = isLocalePref(p) ? p : "system";
    sync();
  });
  sync();
}

/** 主进程文案取词（当前生效语言）。 */
export function mt(id: MsgId, params?: MsgParams): string {
  return t(id, params);
}
