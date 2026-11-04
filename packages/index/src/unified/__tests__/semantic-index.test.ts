/**
 * buildSemanticIndex（后置语义通道）单元测试。
 *
 * index 包不依赖 sqlite-vec，测试走无 vec 分支：验证 reconcile 水位、
 * 符号级切片、批量嵌入调用、事务写入与孤儿清理。vec0 路径（KNN）由
 * 桌面端集成验证（embedding-service 端口注入 + ragSearch）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeSchema } from "../schema";
import {
  buildSemanticIndex,
  SEMANTIC_EMBED_DIM,
  type SemanticEmbedder,
} from "../semantic-index";

let root: string;
let db: Database.Database;

function seedFile(path: string, content: string, hash: string): number {
  const r = db
    .prepare(
      `INSERT INTO files (path, language, size, hash, indexed_at, mtime) VALUES (?, 'typescript', ?, ?, ?, ?)`,
    )
    .run(path, content.length, hash, Date.now(), Date.now());
  return Number(r.lastInsertRowid);
}

function seedSymbol(fileId: number, name: string, qualifiedName: string, start: number, end: number, signature: string, doc: string): void {
  db.prepare(
    `INSERT INTO symbols (file_id, name, qualified_name, kind, start_line, end_line, exported, signature, doc)
     VALUES (?, ?, ?, 'function', ?, ?, 1, ?, ?)`,
  ).run(fileId, name, qualifiedName, start, end, signature, doc);
}

/** 确定性 fake 嵌入器：文本哈希摊成 512 维；记录调用批次供断言。 */
function fakeEmbedder(): SemanticEmbedder & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    async embedBatch(batch) {
      texts.push(...batch);
      return batch.map((t) => {
        const v = new Float32Array(SEMANTIC_EMBED_DIM);
        for (let i = 0; i < t.length; i++) v[i % SEMANTIC_EMBED_DIM] = (t.charCodeAt(i) % 7) / 7;
        return v;
      });
    },
  };
}

beforeEach(() => {
  root = join(tmpdir(), `semantic-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, "src"), { recursive: true });
  db = new Database(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("buildSemanticIndex", () => {
  it("首轮 reconcile：符号级切片入 code_chunks，水位推进，嵌入文本含限定名/签名/doc", async () => {
    writeFileSync(join(root, "src", "auth.ts"), "line1\nline2\nexport function validateToken(t) {\n  return true;\n}\n");
    const fid = seedFile("src/auth.ts", "dummy", "hash-a");
    seedSymbol(fid, "validateToken", "AuthService.validateToken", 3, 5, "function validateToken(t): boolean", "Checks signature");

    const embedder = fakeEmbedder();
    const stats = await buildSemanticIndex(db, root, { embedder });

    expect(stats.filesEmbedded).toBe(1);
    expect(stats.chunksWritten).toBe(1);
    const row = db.prepare(`SELECT * FROM code_chunks`).get() as Record<string, unknown>;
    expect(row.path).toBe("src/auth.ts");
    expect(row.symbol_name).toBe("validateToken");
    expect(row.qualified_name).toBe("AuthService.validateToken");
    expect(row.start_line).toBe(3);
    expect(row.end_line).toBe(5);
    expect(String(row.content)).toContain("AuthService.validateToken");
    expect(String(row.content)).toContain("function validateToken(t)");
    expect(String(row.content)).toContain("Checks signature");
    expect(String(row.content)).toContain("return true;");
    expect(String(row.content_hash)).toHaveLength(64);
    const state = db.prepare(`SELECT * FROM code_chunks_state`).get() as { file_hash: string };
    expect(state.file_hash).toBe("hash-a");
    expect(embedder.texts).toHaveLength(1);
  });

  it("水位一致时幂等：第二次跑零嵌入调用", async () => {
    writeFileSync(join(root, "src", "a.ts"), "function a() {\n  return 1;\n}\n");
    const fid = seedFile("src/a.ts", "x", "h1");
    seedSymbol(fid, "a", "a", 1, 3, "function a()", "");

    await buildSemanticIndex(db, root, { embedder: fakeEmbedder() });
    const second = fakeEmbedder();
    const stats = await buildSemanticIndex(db, root, { embedder: second });

    expect(stats.filesEmbedded).toBe(0);
    expect(second.texts).toHaveLength(0);
  });

  it("files.hash 变化触发重嵌入：旧 chunk 清除、新 chunk 写入", async () => {
    writeFileSync(join(root, "src", "a.ts"), "function a() {\n  return 1;\n}\n");
    const fid = seedFile("src/a.ts", "x", "h1");
    seedSymbol(fid, "a", "a", 1, 3, "function a()", "");
    await buildSemanticIndex(db, root, { embedder: fakeEmbedder() });

    db.prepare(`UPDATE files SET hash = 'h2' WHERE id = ?`).run(fid);
    const stats = await buildSemanticIndex(db, root, { embedder: fakeEmbedder() });

    expect(stats.filesEmbedded).toBe(1);
    const rows = db.prepare(`SELECT content FROM code_chunks`).all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1); // 旧行被事务删除，未重复累积
  });

  it("文件从 files 表消失 → 孤儿 chunk 与水位级联清理", async () => {
    writeFileSync(join(root, "src", "a.ts"), "function a() {\n  return 1;\n}\n");
    const fid = seedFile("src/a.ts", "x", "h1");
    seedSymbol(fid, "a", "a", 1, 3, "function a()", "");
    await buildSemanticIndex(db, root, { embedder: fakeEmbedder() });

    db.prepare(`DELETE FROM files WHERE id = ?`).run(fid);
    await buildSemanticIndex(db, root, { embedder: fakeEmbedder() });

    expect(db.prepare(`SELECT COUNT(*) AS n FROM code_chunks`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM code_chunks_state`).get()).toEqual({ n: 0 });
  });

  it("无符号文件退化为单个文件级 chunk；空文件写水位不嵌入", async () => {
    writeFileSync(join(root, "notes.md"), "# Design\nSome doc\n");
    writeFileSync(join(root, "empty.ts"), "");
    seedFile("notes.md", "x", "hm");
    const emptyFid = seedFile("empty.ts", "x", "he");
    // notes.md 无 symbols 行

    const embedder = fakeEmbedder();
    const stats = await buildSemanticIndex(db, root, { embedder });

    expect(stats.filesEmbedded).toBe(1); // notes.md（文件级兜底）
    const chunk = db.prepare(`SELECT kind, qualified_name FROM code_chunks`).get() as { kind: string; qualified_name: string };
    expect(chunk.kind).toBe("file");
    expect(chunk.qualified_name).toBe("notes.md");
    expect(embedder.texts[0]).toContain("# Design");

    // 空文件只写水位，不产生 chunk
    const emptyState = db.prepare(`SELECT * FROM code_chunks_state WHERE path = 'empty.ts'`).get();
    expect(emptyState).toBeDefined();
    void emptyFid;
  });

  it("嵌入批次失败不拖垮整体：该批跳过、其余照常入库", async () => {
    writeFileSync(join(root, "src", "a.ts"), "function a() {\n  return 1;\n}\n");
    writeFileSync(join(root, "src", "b.ts"), "function b() {\n  return 2;\n}\n");
    const fa = seedFile("src/a.ts", "x", "ha");
    const fb = seedFile("src/b.ts", "x", "hb");
    seedSymbol(fa, "a", "a", 1, 3, "function a()", "");
    seedSymbol(fb, "b", "b", 1, 3, "function b()", "");

    const flaky: SemanticEmbedder = {
      async embedBatch(texts) {
        if (texts[0]?.includes("b.ts") || texts.some((t) => t.includes("function b()"))) {
          throw new Error("simulated ONNX failure");
        }
        return texts.map(() => new Float32Array(SEMANTIC_EMBED_DIM).fill(0.5));
      },
    };
    const stats = await buildSemanticIndex(db, root, { embedder: flaky, embedBatchSize: 1 });

    expect(stats.chunksWritten).toBe(1);
    expect(stats.chunksSkipped).toBe(1);
    const paths = (db.prepare(`SELECT path FROM code_chunks ORDER BY path`).all() as Array<{ path: string }>).map((r) => r.path);
    expect(paths).toEqual(["src/a.ts"]);
  });

  it("维度不符的嵌入结果按跳过处理（端口契约）", async () => {
    writeFileSync(join(root, "src", "a.ts"), "function a() {\n  return 1;\n}\n");
    const fid = seedFile("src/a.ts", "x", "h1");
    seedSymbol(fid, "a", "a", 1, 3, "function a()", "");

    const wrongDim: SemanticEmbedder = {
      async embedBatch(texts) {
        return texts.map(() => new Float32Array(8));
      },
    };
    const stats = await buildSemanticIndex(db, root, { embedder: wrongDim });
    expect(stats.chunksWritten).toBe(0);
    expect(stats.chunksSkipped).toBe(1);
  });
});
