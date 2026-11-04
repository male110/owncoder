/**
 * 代码语义索引召回质量评估（对标 Cursor auto-context 的数据证据）。
 *
 * 默认跳过：设 ONWCODER_SEMANTIC_EVAL=1 真跑——对 apps/desktop/src/main
 * 建统一索引（含 bge 语义通道），对黄金问题集比较关键词路（FTS）与
 * 语义路（ragSearch）的 top-8 命中率与 MRR，输出 console.table 报告。
 * 真实 ONNX 推理，单轮约数十秒，不进常规 CI。
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { createIndexClient, type IndexClient, type SemanticSearchPort } from "@owncoder/index";
import {
  configureEmbeddingCacheDir,
  getSharedEmbeddingService,
} from "../embedding-service";

const ENABLED = process.env.ONWCODER_SEMANTIC_EVAL === "1";

/** 评估对象：桌面主进程目录（文件构成与本仓真实代码一致）。 */
const EVAL_ROOT = resolve(__dirname, "..");
/** 打包/开发期模型目录：本仓 assets。 */
const MODEL_DIR = resolve(__dirname, "../../../assets/embedding-model");

interface GoldenQuery {
  /** 自然语言问题（不含确切标识符，正是 FTS 的盲区场景）。 */
  query: string;
  /** 期望文件子串（任一命中即算 hit）。 */
  expect: string[];
}

const GOLDEN: GoldenQuery[] = [
  { query: "历史对话怎么被嵌入并存进向量库", expect: ["history-vector"] },
  { query: "共享的 ONNX 嵌入会话在哪里创建", expect: ["embedding-service"] },
  { query: "索引构建跑在哪个独立进程里", expect: ["index-worker"] },
  { query: "主进程和索引工作进程的通信桥", expect: ["index-host"] },
  { query: "工作区打开后怎么启动索引与注入检索端口", expect: ["main-app"] },
  { query: "语义检索用的向量表怎么建的", expect: ["history-vector", "embedding-service"] },
  { query: "聊天事件缓冲与持久化", expect: ["chat-event-buffer"] },
  { query: "IPC 处理器注册入口在哪", expect: ["ipc/index", "ipc\\index", "ipc/index.ts"] },
];

describe.skipIf(!ENABLED)("代码语义索引召回评估", () => {
  it("FTS vs 语义 ragSearch：top-8 命中率与 MRR", async () => {
    expect(existsSync(MODEL_DIR)).toBe(true);
    configureEmbeddingCacheDir(MODEL_DIR);
    const service = getSharedEmbeddingService();
    const port: SemanticSearchPort = {
      embedBatch: (texts) => service.embedBatch(texts),
      embedQuery: (text) => service.embed(text),
      loadVec: (db) => {
        try {
          sqliteVec.load(db as Parameters<typeof sqliteVec.load>[0]);
        } catch (error) {
          console.warn("[eval] sqlite-vec load failed:", error);
        }
      },
    };
    const index: IndexClient = createIndexClient({ semantic: port });
    await index.open(EVAL_ROOT, undefined, { mode: "build" });

    let keywordHits = 0;
    let semanticHits = 0;
    let keywordMrr = 0;
    let semanticMrr = 0;
    const rows: Array<Record<string, unknown>> = [];

    for (const g of GOLDEN) {
      // 关键词路：标识符/词直接 FTS。
      const terms = g.query.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [];
      const keyword = new Set<string>();
      for (const t of [...terms, g.query]) {
        for (const r of await index.ftsSearch?.(t, { limit: 8 }) ?? []) keyword.add(r.path);
      }
      const semantic = new Set((await index.ragSearch?.(g.query, 8) ?? []).map((r) => r.filePath));

      const score = (set: Set<string>): { hit: boolean; rank: number } => {
        const ranked = [...set];
        for (const p of g.expect) {
          const idx = ranked.findIndex((r) => r.includes(p));
          if (idx >= 0) return { hit: true, rank: idx + 1 };
        }
        return { hit: false, rank: 0 };
      };
      const k = score(keyword);
      const s = score(semantic);
      keywordHits += k.hit ? 1 : 0;
      semanticHits += s.hit ? 1 : 0;
      keywordMrr += k.rank ? 1 / k.rank : 0;
      semanticMrr += s.rank ? 1 / s.rank : 0;
      rows.push({ query: g.query.slice(0, 20), k_hit: k.hit, k_rank: k.rank, s_hit: s.hit, s_rank: s.rank });
    }

    const n = GOLDEN.length;
    console.table(rows);
    console.log(
      `[semantic-eval] top-8 hit: keyword ${(keywordHits / n).toFixed(2)} vs semantic ${(semanticHits / n).toFixed(2)}; ` +
        `MRR: keyword ${(keywordMrr / n).toFixed(2)} vs semantic ${(semanticMrr / n).toFixed(2)}`,
    );

    // 健全性：语义路必须能召回（真实模型加载失败不会到这）。
    expect(semanticHits).toBeGreaterThan(0);
    // 评估产生的索引库落在 EVAL_ROOT/.owncoder/（已在 .gitignore），不强制删除：
    // better-sqlite3 句柄仍被 native 模块持有，rmSync 在 Windows 上会 EPERM；
    // 下次 open(build) 复用同一 db（增量水位自动 reconcile）。
  }, 600_000);
});
