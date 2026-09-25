/**
 * IPC handlers: symbol index and repo-map.
 */
import { ipcMain, shell } from "electron";
import type { IpcContext } from "./types";
import { mt } from "../i18n";

export function registerIndexHandlers(ctx: IpcContext): void {
  const { session } = ctx;

  ipcMain.handle("index:status", () => session.getIndex().status());

  ipcMain.handle("index:repoMap", async () => {
    const wf = session.getState().workflow;
    return session.getIndex().buildRepoMap({ mapTokens: wf.context.mapTokens });
  });

  ipcMain.handle("index:rebuild", () => {
    const status = session.getIndex().status();
    return {
      ...status,
      message: mt("索引仅在项目打开时初始化，后续由文件监听增量更新；手动重建已禁用。"),
    };
  });

  // Codemap is query-only at runtime. Its writable index is initialized by the
  // workspace IndexHost and then maintained by file-watch invalidations.
  ipcMain.handle("index:codemapStatus", async () => (await session.getCodemap()).status());
  ipcMain.handle("index:codemapBuild", async () => {
    const status = await (await session.getCodemap()).status();
    return {
      ...status,
      message: mt("Codemap 仅在项目打开时初始化，后续由文件监听增量更新；手动重建已禁用。"),
    };
  });
  ipcMain.handle("index:codemapSearch", async (_e, query: unknown, limit?: unknown) => {
    const text = typeof query === "string" ? query.trim().slice(0, 512) : "";
    if (!text) throw new Error(mt("请输入要搜索的符号或描述"));
    const count = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : 20;
    return (await session.getCodemap()).search(text, Math.max(1, Math.min(count, 50)));
  });
  ipcMain.handle("index:codemapImpact", async (_e, query: unknown, depth?: unknown) => {
    const text = typeof query === "string" ? query.trim().slice(0, 512) : "";
    if (!text) throw new Error(mt("请输入要分析的符号"));
    const hops = typeof depth === "number" && Number.isFinite(depth) ? Math.trunc(depth) : 3;
    return (await session.getCodemap()).impact(text, Math.max(1, Math.min(hops, 6)));
  });

  ipcMain.handle("shell:openPath", (_e, p: string) => shell.openPath(p));
}
