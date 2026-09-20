/**
 * Main-process host for the index UtilityProcess.
 * Main process keeps a read-only IndexClient for queries; writes happen in the worker.
 */
import { utilityProcess, type UtilityProcess } from "electron";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export type IndexHostStatus = {
  kind: "idle" | "building" | "ready" | "error";
  root: string | null;
  files: number;
  message?: string;
  progress?: { current: number; total: number; file: string };
};

type WorkerOut =
  | { type: "progress"; current: number; total: number; file: string }
  | { type: "ready"; files: number }
  | { type: "error"; message: string }
  | { type: "log"; message: string };

export class IndexHost {
  private child: UtilityProcess | null = null;
  private currentRoot: string | null = null;
  private status: IndexHostStatus = { kind: "idle", root: null, files: 0 };
  private listeners = new Set<(s: IndexHostStatus) => void>();

  onStatus(listener: (s: IndexHostStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): IndexHostStatus {
    return this.status;
  }

  private emit(next: IndexHostStatus): void {
    this.status = next;
    for (const listener of this.listeners) listener(next);
  }

  private workerEntry(): string {
    // electron-vite: index-worker.js 在 out/main/；本模块可能在 out/main/chunks/。
    let mainDir = __dirname;
    if (basename(mainDir) === "chunks") mainDir = join(mainDir, "..");
    return join(mainDir, "index-worker.js");
  }

  start(root: string, extraIgnore: string[] = []): void {
    if (this.currentRoot === root && this.child) {
      return;
    }
    this.stop();
    this.currentRoot = root;
    this.emit({ kind: "building", root, files: 0, message: "starting index worker" });

    const entry = this.workerEntry();
    const child = utilityProcess.fork(entry, [], {
      serviceName: "owncoder-index",
      stdio: "pipe",
    });
    this.child = child;

    child.on("message", (raw) => {
      const msg = raw as WorkerOut;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "progress") {
        this.emit({
          kind: "building",
          root,
          files: this.status.files,
          progress: { current: msg.current, total: msg.total, file: msg.file },
        });
        return;
      }
      if (msg.type === "ready") {
        this.emit({ kind: "ready", root, files: msg.files });
        return;
      }
      if (msg.type === "error") {
        this.emit({ kind: "error", root, files: this.status.files, message: msg.message });
        return;
      }
      if (msg.type === "log") {
        console.log(`[index-worker] ${msg.message}`);
      }
    });

    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (this.status.kind === "building") {
        this.emit({
          kind: "error",
          root,
          files: this.status.files,
          message: `index worker exited (${code ?? "?"})`,
        });
      }
    });

    child.postMessage({ type: "open", root, extraIgnore });
  }

  invalidate(batch: { files?: string[]; directories?: string[] }): void {
    this.child?.postMessage({
      type: "invalidate",
      paths: batch.files ?? [],
      directories: batch.directories ?? [],
    });
  }

  stop(): void {
    if (!this.child) {
      this.currentRoot = null;
      return;
    }
    try {
      this.child.postMessage({ type: "stop" });
    } catch {
      // ignore
    }
    try {
      this.child.kill();
    } catch {
      // ignore
    }
    this.child = null;
  }
}

export const indexHost = new IndexHost();

/** Dev helper: resolve file URL for debugging. */
export function indexWorkerUrl(): string {
  let mainDir = __dirname;
  if (basename(mainDir) === "chunks") mainDir = join(mainDir, "..");
  return pathToFileURL(join(mainDir, "index-worker.js")).href;
}
