import { watch, statSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface WorkspaceWatcherHooks {
  /** 单文件变更：使符号索引中的该文件失效。 */
  invalidate(path: string): void;
  /** 目录删除/缺失：使该子树失效。 */
  invalidateDir(path: string): void;
  /** 把脏路径转发给 desktop 可写索引进程（可为空）。 */
  onDirty?(batch: { files: string[]; directories: string[] }): void;
}

/**
 * 工作区文件监听器。
 *
 * 从 index.ts (SessionOrchestrator.startFileWatcher) 拆分：监听工作区的
 * 外部编辑并增量推送进索引；同一路径的连发事件（编辑器自动保存）按
 * 300ms 防抖合并为一次失效。切换工作区时先 close() 旧实例再 start() 新的。
 */
export class WorkspaceFileWatcher {
  private watcher: FSWatcher | null = null;
  /** Per-path debounce timers, so repeated save events for the same path
   * collapse into a single `invalidate` call. */
  private timers: Map<string, NodeJS.Timeout> = new Map();

  start(root: string, hooks: WorkspaceWatcherHooks): void {
    // Close any watcher / pending timers from a previous workspace.
    this.close();

    const skip = new Set([
      "node_modules",
      ".git",
      ".venv",
      "venv",
      "target",
      "dist",
      "build",
      ".next",
      ".owncoder",
      "__pycache__",
      "vendor",
      "out",
      "bin",
      "obj",
    ]);

    const shouldSkip = (absPath: string): boolean => {
      const rel = absPath.split(/[\\/]/);
      return rel.some((seg) => skip.has(seg));
    };

    const DEBOUNCE_MS = 300;
    try {
      const watcher = watch(
        root,
        { recursive: true },
        (_event, filename) => {
          if (!filename) return;
          const absPath = join(root, filename);
          if (shouldSkip(absPath)) return;
          // Debounce: collapse bursts of change events (e.g. editor
          // auto-save) for the same path into a single `invalidate`, which
          // re-parses the file (or drops it if deleted) without a full rescan.
          const existing = this.timers.get(absPath);
          if (existing) clearTimeout(existing);
          this.timers.set(
            absPath,
            setTimeout(() => {
              this.timers.delete(absPath);
              // Determine whether this is a directory delete. On Windows a
              // deleted non-empty directory may only report the directory
              // itself (not each file), so we strip the whole subtree to avoid
              // leaving stale entries in the symbol index.
              let isDirOrGone = false;
              try {
                isDirOrGone = statSync(absPath).isDirectory();
              } catch {
                isDirOrGone = true; // deleted: can't tell file vs dir → treat as dir
              }
              if (isDirOrGone) {
                hooks.invalidateDir(absPath);
                hooks.onDirty?.({ files: [], directories: [absPath] });
              } else {
                hooks.invalidate(absPath);
                hooks.onDirty?.({ files: [absPath], directories: [] });
              }
              // The desktop IndexHost receives this path through onDirty.
              // Codemap updates are intentionally not built in the main process.
            }, DEBOUNCE_MS),
          );
        },
      );
      this.watcher = watcher;
    } catch {
      // Recursive watch can fail on some platforms; live updates simply won't
      // run, but the open-time diff still keeps the index correct.
      this.watcher = null;
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
