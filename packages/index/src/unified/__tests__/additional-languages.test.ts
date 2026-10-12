import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import Parser from "web-tree-sitter";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectLanguage,
  scanWorkspace,
  scanWorkspaceAsync,
  walkFileMetas,
  walkFileMetasAsync,
} from "../scanner.ts";
import { initTreeSitter, extractSymbolsTreeSitter } from "../parser-treesitter.ts";
import { buildIndexAsync } from "../builder.ts";
import { initializeSchema } from "../schema.ts";

const fixtures: [string, string, string][] = [
  ["sample.zig", "zig", "pub fn hello() void {}"],
  ["sample.lua", "lua", "function hello() end"],
  ["sample.dart", "dart", "void hello() {}"],
  ["sample.ex", "elixir", "defmodule Sample do\n  def hello, do: :ok\nend"],
  ["sample.exs", "elixir", "IO.puts(\"hello\")"],
  ["sample.elm", "elm", "module Sample exposing (hello)\nhello = 1"],
  ["sample.ml", "ocaml", "let hello () = 1"],
  ["sample.mli", "ocaml", "val hello : unit -> int"],
  ["sample.res", "rescript", "let hello = () => 1"],
  ["sample.resi", "rescript", "let hello: unit => int"],
  ["sample.el", "elisp", "(defun hello () 1)"],
  ["sample.sh", "bash", "hello() { echo hello; }"],
  ["sample.bash", "bash", "hello() { echo hello; }"],
  ["sample.m", "objc", "@interface Sample\n- (void)hello;\n@end"],
  ["sample.mm", "objc", "@implementation Sample\n- (void)hello {}\n@end"],
  ["sample.sol", "solidity", "contract Sample { function hello() public {} }"],
  ["sample.ql", "ql", "predicate hello() { 1 = 1 }"],
  ["sample.qll", "ql", "predicate hello() { 1 = 1 }"],
  ["sample.css", "css", ".hello { color: red; }"],
  ["sample.html", "html", "<div>hello</div>"],
  ["sample.htm", "html", "<div>hello</div>"],
  ["sample.component.vue", "vue", "<template><div>hello</div></template><script>export default {}</script>"],
  ["sample.json", "json", '{"hello": 1}'],
  ["sample.yaml", "yaml", "hello: 1"],
  ["sample.yml", "yaml", "hello: 1"],
  ["sample.toml", "toml", "hello = 1"],
  [".config.json", "json", '{"hello": 1}'],
  [".github.yml", "yaml", "hello: 1"],
  ["UPPER.LUA", "lua", "function hello() end"],
  ["Sample.java", "java", "public class Sample { public void hello() {} }"],
];

let root: string | undefined;
let db: Database.Database | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  db = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function createWorkspace(): string {
  root = mkdtempSync(join(tmpdir(), "additional-languages-"));
  for (const [path, , content] of fixtures) writeFileSync(join(root, path), content);
  writeFileSync(join(root, "ignored.txt"), "hello");
  writeFileSync(join(root, ".unsupported"), "hello");
  return root;
}

describe("新增语言的默认索引支持", () => {
  it("同步、异步及元数据扫描均发现新增类型并识别语言", async () => {
    const workspace = createWorkspace();
    const expected = fixtures.map(([path, language]) => ({ path, language }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const scans = [
      [...scanWorkspace({ root: workspace })],
      await scanWorkspaceAsync({ root: workspace }),
      [...walkFileMetas({ root: workspace })],
      await walkFileMetasAsync({ root: workspace }),
    ];
    for (const files of scans) {
      expect(files.map(({ path, language }) => ({ path, language }))
        .sort((a, b) => a.path.localeCompare(b.path))).toEqual(expected);
    }
    for (const [path, language] of fixtures) expect(detectLanguage(path)).toBe(language);
  });

  it("实际加载每种新增语言的 grammar 并执行解析", async () => {
    await initTreeSitter();
    const load = vi.spyOn(Parser.Language, "load");
    const languages = new Set<string>();
    for (const [, language, content] of fixtures) {
      if (language === "java" || languages.has(language)) continue;
      languages.add(language);
      expect(await extractSymbolsTreeSitter(content, language)).toBeInstanceOf(Array);
    }
    // 空符号数组也可能代表 grammar 未找到，必须验证实际加载成功。
    expect(load).toHaveBeenCalledTimes(18);
    for (const result of load.mock.results) {
      expect(await result.value).toBeInstanceOf(Parser.Language);
    }
  });

  it("全量构建建立文件和内容索引，增量构建发现新增及修改文件", async () => {
    const workspace = createWorkspace();
    db = new Database(":memory:");
    initializeSchema(db);
    const full = await buildIndexAsync(db, { root: workspace, incremental: false });
    expect(full.errors).toEqual([]);
    expect(full.filesIndexed).toBe(fixtures.length);
    expect(db.prepare("SELECT path, language FROM files ORDER BY path").all()).toEqual(
      fixtures.map(([path, language]) => ({ path, language }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    expect(db.prepare("SELECT count(*) AS count FROM files_fts WHERE files_fts MATCH 'hello'").get())
      .toEqual({ count: fixtures.length });
    expect(db.prepare("SELECT name FROM symbols WHERE name = 'hello'").all().length)
      .toBeGreaterThan(0);

    writeFileSync(join(workspace, "added.lua"), "function added() end");
    writeFileSync(join(workspace, "sample.json"), '{"updatedMarker": true}');
    const incremental = await buildIndexAsync(db, { root: workspace, incremental: true });
    expect(incremental.errors).toEqual([]);
    expect(incremental.filesIndexed).toBe(2);
    expect(db.prepare("SELECT language FROM files WHERE path = 'added.lua'").get())
      .toEqual({ language: "lua" });
    expect(db.prepare("SELECT path FROM files_fts WHERE files_fts MATCH 'updatedMarker'").all())
      .toEqual([{ path: "sample.json" }]);
  });
});
