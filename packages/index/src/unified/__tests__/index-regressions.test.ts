import { describe, expect, it, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnifiedIndex } from "../index.ts";
import { buildIndex, buildIndexAsync } from "../builder.ts";
import { initializeSchema } from "../schema.ts";
import { UnifiedCodemapAdapter } from "../adapter.ts";
import { UnifiedIndexAdapter } from "../index-client-adapter.ts";

const workspaces: string[] = [];
const databases: Database.Database[] = [];
const indexes: UnifiedIndex[] = [];

afterEach(() => {
  for (const index of indexes.splice(0)) index.close();
  for (const db of databases.splice(0)) db.close();
  for (const root of workspaces.splice(0)) {
    if (!existsSync(root)) continue;
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (i === 2) throw error;
      }
    }
  }
});

function createWorkspace(): { root: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "index-regression-"));
  mkdirSync(join(root, ".owncoder"), { recursive: true });
  const db = new Database(join(root, ".owncoder", "unified-index.db"));
  initializeSchema(db);
  workspaces.push(root);
  databases.push(db);
  return { root, db };
}

describe("code index regressions", () => {
  it("39KB 深层源码中的方法能被扫描、解析并通过符号全文索引检索", async () => {
    const { root, db } = createWorkspace();
    const dir = "src/features/domain/services/internal/handlers/nested";
    mkdirSync(join(root, dir), { recursive: true });
    const source = "export class WorkspaceService {\n  loadDeepWorkspaceData() {}\n}\n";
    writeFileSync(
      join(root, dir, "service.ts"),
      source + " ".repeat(39 * 1024 - Buffer.byteLength(source)),
    );
    await buildIndexAsync(db, { root, incremental: false });
    const index = new UnifiedIndex();
    indexes.push(index);
    index.open(root);

    const exact = await index.searchSymbolsExact("loadDeepWorkspaceData");
    const fuzzy = await index.searchSymbolsFuzzy("loadDeepWorkspaceData");
    expect(exact).toHaveLength(1);
    expect(fuzzy).toHaveLength(1);
    expect(fuzzy[0]).toMatchObject({
      name: "loadDeepWorkspaceData",
      kind: "method",
      path: `${dir}/service.ts`,
      line: 2,
    });
  });

  it("全量重建能修复未变更的 39KB Java 文件中的漏索引", async () => {
    const { root, db } = createWorkspace();
    const dir = "paper-server/src/main/java/com/modi/service/exam/impl";
    const path = `${dir}/ExamTaskTopicTeacherPaperServiceImpl.java`;
    mkdirSync(join(root, dir), { recursive: true });
    const source = [
      "package com.modi.service.exam.impl;",
      "public class ExamTaskTopicTeacherPaperServiceImpl {",
      "  @Override",
      "  public void studentTopicPaperToUser(Long userId) {}",
      "}",
    ].join("\n");
    writeFileSync(join(root, path), source + " ".repeat(39 * 1024 - Buffer.byteLength(source)));
    const first = await buildIndexAsync(db, { root, incremental: false });
    expect(first.errors).toEqual([]);
    expect(db.prepare("SELECT name FROM symbols WHERE name = ?").get("studentTopicPaperToUser"))
      .toBeDefined();

    // 模拟旧解析器留下文件记录，但漏掉方法符号；源码元数据保持不变。
    db.prepare("DELETE FROM symbols WHERE name = ?").run("studentTopicPaperToUser");
    const adapter = new UnifiedIndexAdapter();
    indexes.push(adapter["index"]);
    await adapter.open(root, undefined, { mode: "build" });
    await adapter.rebuildAll();
    const index = new UnifiedIndex();
    indexes.push(index);
    index.open(root);
    expect(await index.searchSymbolsExact("studentTopicPaperToUser")).toHaveLength(1);
    expect(await index.searchSymbolsFuzzy("studentTopicPaperToUser")).toHaveLength(1);
    expect(await index.searchSymbolsFuzzy("studentTopic")).toHaveLength(1);
    expect((await index.searchSymbolsExact("studentTopicPaperToUser"))[0])
      .toMatchObject({ path, line: 3 });
    expect(await index.searchSymbolsExact("ExamTaskTopicTeacherPaperServiceImpl")).toHaveLength(1);
  });

  it("Codemap 全量构建使用 Java AST 并恢复未变更文件的漏索引", async () => {
    const { root, db } = createWorkspace();
    writeFileSync(join(root, "Service.java"),
      "public class Service { public void studentTopicPaperToUser() {} }");
    const adapter = new UnifiedCodemapAdapter();
    indexes.push(adapter["index"]);
    const status = await adapter.build(root);
    expect(status.nodeCount).toBeGreaterThanOrEqual(2);
    expect((await adapter.search("studentTopicPaperToUser")).some(
      (hit) => hit.node.name === "studentTopicPaperToUser",
    )).toBe(true);
    db.prepare("DELETE FROM symbols WHERE name = ?").run("studentTopicPaperToUser");
    await adapter.build(root);
    expect((await adapter.search("studentTopicPaperToUser")).some(
      (hit) => hit.node.name === "studentTopicPaperToUser",
    )).toBe(true);
  });

  it.each([
    ["同步", buildIndex],
    ["异步", buildIndexAsync],
  ] as const)("%s 全量扫描同步新增、修改、删除文件，并隔离其他项目", async (_mode, build) => {
    const { root, db } = createWorkspace();
    const other = createWorkspace();
    const oldSource = "export function alpha() {}";
    const newSource = "export function bravo() {}";
    const changedPath = join(root, "changed.ts");
    const deletedPath = join(root, "gone.ts");
    writeFileSync(changedPath, oldSource);
    writeFileSync(deletedPath, "export function gone() {}\nexport function caller() { gone(); }");
    writeFileSync(join(other.root, "gone.ts"), "export function otherProject() {}");
    expect((await build(db, { root, incremental: false })).errors).toEqual([]);
    expect((await build(other.db, { root: other.root, incremental: false })).errors).toEqual([]);

    expect(db.prepare("SELECT 1 FROM symbol_references r JOIN symbols s ON s.id = r.to_symbol_id WHERE s.name = 'gone'").get()).toBeDefined();

    const oldMtime = statSync(changedPath).mtime;
    writeFileSync(changedPath, newSource);
    utimesSync(changedPath, oldMtime, oldMtime);
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "added.ts"), "export function added() {}");
    rmSync(deletedPath);
    expect((await build(db, { root, incremental: false })).errors).toEqual([]);
    expect(db.prepare("SELECT path FROM files ORDER BY path").all()).toEqual([
      { path: "changed.ts" }, { path: "nested/added.ts" },
    ]);
    const names = (db.prepare("SELECT name FROM symbols").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toContain("bravo");
    expect(names).toContain("added");
    expect(names).not.toContain("alpha");
    expect(names).not.toContain("gone");
    expect(db.prepare("SELECT 1 FROM files_fts WHERE path = 'gone.ts'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM symbols JOIN files ON files.id = symbols.file_id WHERE files.path = 'gone.ts'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM symbol_references r JOIN symbols s ON s.id = r.from_symbol_id OR s.id = r.to_symbol_id WHERE s.name IN ('gone', 'caller')").get()).toBeUndefined();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const index = new UnifiedIndex();
    indexes.push(index);
    index.open(root);
    expect(await index.searchSymbolsExact("gone")).toHaveLength(0);
    expect(await index.searchSymbolsFuzzy("gone")).toHaveLength(0);
    expect(await index.search("gone", { type: "file" })).toHaveLength(0);
    expect(other.db.prepare("SELECT name FROM symbols WHERE name = 'otherProject'").get()).toBeDefined();
  });

  it.each([
    ["同步", buildIndex],
    ["异步", buildIndexAsync],
  ] as const)("%s 增量扫描新增文件并保留未变更文件记录", async (_mode, build) => {
    const { root, db } = createWorkspace();
    writeFileSync(join(root, "existing.ts"), "export function existing() {}");
    expect((await build(db, { root, incremental: true })).errors).toEqual([]);
    const before = db.prepare("SELECT * FROM files WHERE path = 'existing.ts'").get();
    expect((await build(db, { root, incremental: true })).filesIndexed).toBe(0);
    writeFileSync(join(root, "added.ts"), "export function added() {}");
    const result = await build(db, { root, incremental: true });
    expect(result.errors).toEqual([]);
    expect(result.filesIndexed).toBe(1);
    expect(db.prepare("SELECT * FROM files WHERE path = 'existing.ts'").get()).toEqual(before);
    expect(db.prepare("SELECT name FROM symbols WHERE name = 'added'").get()).toBeDefined();
  });

  it("同步全量重建会重新提取未变更文件的符号", () => {
    const { root, db } = createWorkspace();
    writeFileSync(join(root, "service.ts"), "export function recovered() {}");
    buildIndex(db, { root, incremental: false });
    db.prepare("DELETE FROM symbols").run();
    const rebuilt = buildIndex(db, { root, incremental: false });
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.filesIndexed).toBe(1);
    expect(db.prepare("SELECT name FROM symbols WHERE name = 'recovered'").get()).toBeDefined();
  });

  it("binds call references to the containing function", async () => {
    const { root, db } = createWorkspace();
    writeFileSync(
      join(root, "calls.ts"),
      [
        "function helper() {}",
        "function main() { helper(); }",
      ].join("\n"),
    );

    buildIndex(db, { root, incremental: false });
    const index = new UnifiedIndex();
    indexes.push(index);
    index.open(root);

    const impact = await index.impact("helper");
    expect(impact.callers.some((caller) => caller.name === "main")).toBe(true);
  });

  it("honors exportedOnly and file search filters", async () => {
    const { root, db } = createWorkspace();
    writeFileSync(
      join(root, "search-target.ts"),
      "export function publicThing() {}\nfunction privateThing() {}",
    );

    buildIndex(db, { root, incremental: false });
    const index = new UnifiedIndex();
    indexes.push(index);
    index.open(root);

    const exported = await index.search("publicThing", { exportedOnly: true });
    expect(exported.map((result) => result.name)).toEqual(["publicThing"]);

    const files = await index.search("search-target", { type: "file" });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("search-target.ts");
  });

  it("rebuilds a forced async path even when mtime and size are unchanged", async () => {
    const { root, db } = createWorkspace();
    const filePath = join(root, "forced.ts");
    writeFileSync(filePath, "export function alpha() {}");
    await buildIndexAsync(db, { root, incremental: true });

    const oldMtime = statSync(filePath).mtime;
    writeFileSync(filePath, "export function bravo() {}");
    utimesSync(filePath, oldMtime, oldMtime);

    await buildIndexAsync(db, {
      root,
      incremental: true,
      forcedPaths: ["forced.ts"],
    });

    const names = (db.prepare("SELECT name FROM symbols").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(names).toContain("bravo");
    expect(names).not.toContain("alpha");
  });

  it("removes deleted files from the file FTS index", async () => {
    const { root, db } = createWorkspace();
    const filePath = join(root, "gone.ts");
    writeFileSync(filePath, "export function gone() {}");
    buildIndex(db, { root, incremental: true });

    rmSync(filePath);
    buildIndex(db, { root, incremental: true });

    const stale = db
      .prepare("SELECT COUNT(*) AS count FROM files_fts WHERE path = ?")
      .get("gone.ts") as { count: number };
    expect(stale.count).toBe(0);
  });
});
