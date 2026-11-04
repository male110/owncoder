/**
 * Index UtilityProcess entry.
 * Owns the writable SQLite connection and runs scan/build off the Electron main process.
 *
 * 代码语义索引的构建侧也在本进程：open 消息携带 embeddingModelDir，
 * 模型可用时构建 SemanticSearchPort（bge 批量嵌入 + sqlite-vec 加载器）
 * 注入 createIndexClient——adapter 的构建分支随后跑后置语义通道，把符号
 * chunk 嵌入写入同一 unified-index.db。模型缺失/不可用时整条语义通道
 * 降级（ragSearch 空，消费方 hybrid 回退 FTS），符号索引不受影响。
 */
import { createIndexClient, type IndexClient, type SemanticSearchPort } from "@owncoder/index";
import * as sqliteVec from "sqlite-vec";
import {
  configureEmbeddingCacheDir,
  embeddingModelAvailable,
  getSharedEmbeddingService,
} from "./embedding-service.ts";

type ParentMessage =
  | { type: "open"; root: string; extraIgnore?: string[]; embeddingModelDir?: string }
  | { type: "invalidate"; paths?: string[]; directories?: string[] }
  | { type: "stop" };

type ChildMessage =
  | { type: "progress"; current: number; total: number; file: string }
  | { type: "ready"; files: number }
  | { type: "fileTypes"; fileTypes: string[] }
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

const fileTypesListener = (fileTypes: string[]) => post({ type: "fileTypes", fileTypes });

let index: IndexClient = createIndexClient();
index.onFileTypes?.(fileTypesListener);
let busy = false;

/**
 * 构建语义端口（bge 共享单例 + sqlite-vec 加载器）。
 * 嵌入是懒加载的（首次 embedBatch 才加载模型），这里只做目录预检——
 * 预检失败即返回 undefined，整条语义通道不注册，日志一行说明降级。
 */
function buildSemanticPort(): SemanticSearchPort | undefined {
  if (!embeddingModelAvailable()) return undefined;
  const service = getSharedEmbeddingService();
  return {
    embedBatch: (texts) => service.embedBatch(texts),
    embedQuery: (text) => service.embed(text),
    loadVec: (db) => {
      try {
        sqliteVec.load(db as Parameters<typeof sqliteVec.load>[0]);
      } catch (error) {
        console.warn("[index-worker] sqlite-vec load failed:", error);
      }
    },
  };
}

async function openRoot(
  root: string,
  extraIgnore?: string[],
  embeddingModelDir?: string,
): Promise<void> {
  if (busy) {
    post({ type: "log", message: `skip open while busy: ${root}` });
    return;
  }
  busy = true;
  try {
    if (embeddingModelDir) {
      configureEmbeddingCacheDir(embeddingModelDir);
      const semantic = buildSemanticPort();
      if (semantic) {
        index = createIndexClient({ semantic });
        index.onFileTypes?.(fileTypesListener);
        post({ type: "log", message: "semantic index enabled" });
      } else {
        post({ type: "log", message: "embedding model unavailable; semantic index disabled" });
      }
    }
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
    void openRoot(msg.root, msg.extraIgnore, msg.embeddingModelDir);
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
