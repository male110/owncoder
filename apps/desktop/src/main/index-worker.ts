/**
 * Index UtilityProcess entry.
 * Owns the writable SQLite connection and runs scan/build off the Electron main process.
 */
import { createIndexClient } from "@owncoder/index";

type ParentMessage =
  | { type: "open"; root: string; extraIgnore?: string[] }
  | { type: "invalidate"; paths?: string[]; directories?: string[] }
  | { type: "stop" };

type ChildMessage =
  | { type: "progress"; current: number; total: number; file: string }
  | { type: "ready"; files: number }
  | { type: "error"; message: string }
  | { type: "log"; message: string };

const port = process.parentPort;
if (!port) {
  console.error("[index-worker] missing parentPort; this file must run under utilityProcess.fork");
  process.exit(1);
}

function post(msg: ChildMessage): void {
  port.postMessage(msg);
}

const index = createIndexClient();
let busy = false;

async function openRoot(root: string, extraIgnore?: string[]): Promise<void> {
  if (busy) {
    post({ type: "log", message: `skip open while busy: ${root}` });
    return;
  }
  busy = true;
  try {
    if (extraIgnore?.length) index.setExtraIgnore?.(extraIgnore);
    await index.open(root, undefined, { mode: "build" });
    const status = index.status();
    post({ type: "ready", files: status.fileCount ?? 0 });
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    busy = false;
  }
}

port.on("message", (event) => {
  const msg = event.data as ParentMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "open") {
    void openRoot(msg.root, msg.extraIgnore);
    return;
  }
  if (msg.type === "invalidate") {
    for (const path of msg.paths ?? []) index.invalidate(path);
    for (const dir of msg.directories ?? []) index.invalidateDir?.(dir);
    void (async () => {
      if (busy) return;
      busy = true;
      try {
        await index.flushDirty?.();
        const status = index.status();
        post({ type: "ready", files: status.fileCount ?? 0 });
      } catch (error) {
        post({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        busy = false;
      }
    })();
    return;
  }
  if (msg.type === "stop") {
    process.exit(0);
  }
});

post({ type: "log", message: "index-worker online" });
