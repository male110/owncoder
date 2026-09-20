/**
 * IPC handlers: terminal log, interactive PTY.
 */
import { ipcMain } from "electron";
import { createPty, killPty, resizePty, writePty } from "../pty";
import type { IpcContext } from "./types";

export function registerTerminalHandlers(ctx: IpcContext): void {
  const { session, getWindow, isRendererReady } = ctx;
  const sink = { getWindow, isRendererReady };

  ipcMain.handle("terminal:log", (_e, sessionId?: string) => session.getTerminalLog(sessionId));

  ipcMain.handle("terminal:clear", () => {
    session.clearTerminalLog();
    return true;
  });

  ipcMain.handle("pty:create", (_e, opts?: { cols?: number; rows?: number }) => {
    const cwd = session.getState().workspace?.root;
    return createPty(sink, { cwd, cols: opts?.cols, rows: opts?.rows });
  });

  ipcMain.on("pty:input", (_e, id: string, data: string) => {
    writePty(id, data);
  });

  ipcMain.on("pty:resize", (_e, id: string, cols: number, rows: number) => {
    resizePty(id, cols, rows);
  });

  ipcMain.on("pty:kill", (_e, id: string) => {
    killPty(id);
  });
}
