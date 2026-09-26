/**
 * IPC handlers: workspace / project / file operations.
 */
import { dialog, ipcMain, shell } from "electron";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/** Resolve a Markdown link to a file in the current workspace. */
export function resolveWorkspaceFileLink(workspaceRoot: string, href: string): string | null {
  const raw = String(href || "").trim();
  if (!raw || raw.startsWith("#") || (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^file:/i.test(raw))) {
    return null;
  }

  let input = raw;
  try {
    input = decodeURIComponent(/^file:\/\//i.test(input) ? new URL(input).pathname : input);
  } catch {
    return null;
  }

  // Chromium represents a Windows absolute path as /C:/path in an href.
  if (/^\/[a-z]:[\\/]/i.test(input)) input = input.slice(1);
  input = input.replace(/\\/g, "/");
  const root = resolve(workspaceRoot);
  const abs = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return abs;
}

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

  ipcMain.handle("workspace:openFile", async (_e, href: unknown) => {
    const ws = session.getState().workspace;
    if (!ws || typeof href !== "string") return "No workspace open";
    const abs = resolveWorkspaceFileLink(ws.root, href);
    if (!abs) return "Invalid workspace file link";
    try {
      const [rootReal, fileReal] = await Promise.all([fs.realpath(ws.root), fs.realpath(abs)]);
      const rel = relative(rootReal, fileReal);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "Invalid workspace file link";
      const stat = await fs.stat(fileReal);
      if (!stat.isFile()) return "Workspace path is not a file";
      return shell.openPath(fileReal);
    } catch {
      return "Workspace file does not exist";
    }
  });

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
