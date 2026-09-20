/**
 * IPC handlers: workspace / project / file operations.
 */
import { dialog, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import { checkWritable } from "@owncoder/core";
import { searchWorkspaceFiles } from "../workspace-search";
import type { IpcContext } from "./types";

const LIST_DIR_IGNORE = new Set([
  "node_modules",
  ".git",
  ".owncoder",
  ".owncode",
  "dist",
  "out",
  "target",
  ".pnpm",
  ".vite",
]);

export type WorkspaceDirEntryDto = {
  name: string;
  path: string;
  kind: "file" | "dir";
};

export function registerWorkspaceHandlers(ctx: IpcContext): void {
  const { session, settingsStore, recentStore, openWorkspaceRoot, switchWorkspaceRoot, resolveWorkspacePath } = ctx;

  ipcMain.handle("workspace:openDialog", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return openWorkspaceRoot(result.filePaths[0]!);
  });

  ipcMain.handle("workspace:reopenLast", async () => {
    const recent = recentStore.load().lastWorkspace;
    if (!recent) return null;
    return openWorkspaceRoot(recent.root);
  });

  ipcMain.handle("workspace:getRecent", () => recentStore.load());

  ipcMain.handle("workspace:listProjects", () => recentStore.listProjects());

  ipcMain.handle("workspace:removeProject", (_e, root: string) => {
    recentStore.removeProject(root);
    return recentStore.listProjects();
  });

  ipcMain.handle("workspace:openPath", (_e, root: string) => openWorkspaceRoot(root));

  // 轻量级切换工作区，不清理会话（用于已加载项目之间的快速切换）
  ipcMain.handle("workspace:switchPath", (_e, root: string) => switchWorkspaceRoot(root));

  ipcMain.handle("workspace:get", () => session.getState().workspace);

  ipcMain.handle("workspace:searchFiles", async (_e, query: string) => {
    const ws = session.getState().workspace;
    if (!ws) return [];
    return searchWorkspaceFiles(ws.root, query);
  });

  /** List one directory under a project root (non-recursive). Paths are relative to root. */
  ipcMain.handle(
    "workspace:listDir",
    async (_e, root: string, relPath = ""): Promise<WorkspaceDirEntryDto[]> => {
      const projectRoot = String(root || "").trim();
      if (!projectRoot) return [];
      const absDir = resolveWorkspacePath(projectRoot, String(relPath || "."));
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return [];
      }
      const result: WorkspaceDirEntryDto[] = [];
      for (const entry of entries) {
        if (LIST_DIR_IGNORE.has(entry.name)) continue;
        // Keep common env files; skip other dot entries for a cleaner tree.
        if (
          entry.name.startsWith(".") &&
          entry.name !== ".env" &&
          entry.name !== ".env.local"
        ) {
          continue;
        }
        const full = join(absDir, entry.name);
        const rel = relative(projectRoot, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          result.push({ name: entry.name, path: rel, kind: "dir" });
        } else if (entry.isFile()) {
          result.push({ name: entry.name, path: rel, kind: "file" });
        }
      }
      result.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return result;
    },
  );

  ipcMain.handle("workspace:readFile", async (_e, path: string) => {
    const ws = session.getState().workspace;
    if (!ws) throw new Error("No workspace open");
    const abs = resolveWorkspacePath(ws.root, String(path || ""));
    return fs.readFile(abs, "utf8");
  });

  ipcMain.handle("workspace:writeFile", async (_e, path: string, content: string) => {
    const ws = session.getState().workspace;
    if (!ws) throw new Error("No workspace open");
    const policy = settingsStore.getEffective().context.writePolicy;
    const check = checkWritable(ws.root, String(path || ""), policy);
    if (!check.ok) throw new Error(check.reason || "write denied");
    const abs = resolveWorkspacePath(ws.root, check.relPath);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, String(content ?? ""), "utf8");
    return { path: check.relPath };
  });
}
