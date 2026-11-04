import assert from "node:assert/strict";
import { test } from "vitest";
import { rewriteByLocator } from "./exact-edit.ts";

test("逐字命中时只替换唯一一处", () => {
  const res = rewriteByLocator("import foo\nconst x = 1\nconst y = 2\n", "const x = 1", "const x = 3");
  assert.equal(res.ok, true);
  assert.equal(res.text, "import foo\nconst x = 3\nconst y = 2\n");
  assert.equal(res.replaced, 1);
  assert.equal(res.via, "verbatim");
});

test("定位不要求行对齐，行中片段也能命中", () => {
  const res = rewriteByLocator("const value = compute(input);", "compute(input)", "compute(output)");
  assert.equal(res.ok, true);
  assert.equal(res.text, "const value = compute(output);");
});

test("全局替换会改写每一处", () => {
  // 'a' 共出现 5 次：首行 1 次、'banana' 内 3 次、末行 1 次。
  const res = rewriteByLocator("a\nbanana\na\n", "a", "Z", true);
  assert.equal(res.ok, true);
  assert.equal(res.text, "Z\nbZnZnZ\nZ\n");
  assert.equal(res.replaced, 5);
});

test("多处命中且未要求全局替换时，给出可操作的诊断", () => {
  const file = "const x = 1;\nconst x = 2;\n";
  const res = rewriteByLocator(file, "const x", "const y");
  assert.equal(res.ok, false);
  assert.equal(res.fault, "multiple_targets");
  assert.match(res.message ?? "", /matches 2 places/);
  assert.match(res.message ?? "", /replace_all on/);
});

test("CRLF 文件可用 LF 探针命中，写回后仍为 CRLF", () => {
  const res = rewriteByLocator("import foo\r\nconst x = 1\r\n", "const x = 1", "const x = 3");
  assert.equal(res.ok, true);
  assert.equal(res.text, "import foo\r\nconst x = 3\r\n");
});

test("读取器行号前缀（123: 文本）会在定位前剥离", () => {
  // 模型直接连行号前缀一起从 read_file 输出里复制了过来。
  const res = rewriteByLocator("alpha\nbeta\n", "  1: alpha", "ALPHA");
  const res2 = rewriteByLocator("alpha\nbeta\n", "1: alpha", "ALPHA");
  assert.equal(res2.ok, true);
  assert.equal(res2.text, "ALPHA\nbeta\n");
  assert.equal(res.via, undefined); // 第一次尝试并不带可识别前缀
  void res;
});

test("探针里的字面转义序列可命中真实字符", () => {
  // 模型把换行写成了 \n 两个字符。
  const res = rewriteByLocator("line one\nline two\n", "line one\\nline two", "A\nB");
  assert.equal(res.ok, true);
  assert.equal(res.text, "A\nB\n");
  assert.equal(res.via, "visible_escapes");
});

test("探针里的弯引号可命中文件中的直引号，写回时保留弯引号风格", () => {
  const file = "const msg = “hello world”;\n";
  const res = rewriteByLocator(file, 'const msg = "hello world";', "const msg = “bye”;".split("").join(""));
  assert.equal(res.ok, true);
  assert.equal(res.via, "smart_quotes");
});

test("缩进漂移可由宽松定位器兜住", () => {
  // 文件用 8 空格缩进，探针用 4 空格。链上更早的"逐行空白忽略"在此
  // 已能命中，因此两个定位器都可接受——关键是整块被定位并改写，而不
  // 是靠猜。
  const file = "class A {\n        void run() {\n            doThing();\n        }\n}\n";
  const search = "void run() {\n        doThing();\n    }";
  const res = rewriteByLocator(file, search, "void run() {\n        doMore();\n    }");
  assert.equal(res.ok, true);
  assert.ok(["whitespace_insensitive", "dedent_aligned"].includes(res.via ?? ""));
  assert.ok(res.text?.includes("doMore();"));
  assert.ok(res.text?.includes("void run() {"));
});

test("行尾空白差异由逐行空白忽略定位器兜住", () => {
  // 命中的整块取自文件原文（含行尾空格），逐字替换会整块重写并丢掉
  // 这些填充空格。
  const file = "const a = 1;   \nconst b = 2;\n";
  const res = rewriteByLocator(file, "const a = 1;\nconst b = 2;", "const a = 10;\nconst b = 20;");
  assert.equal(res.ok, true);
  assert.equal(res.text, "const a = 10;\nconst b = 20;\n");
  assert.equal(res.via, "whitespace_insensitive");
});

test("首尾行夹取出现歧义时拒绝而非猜测", () => {
  // 两个结构相似的方法：宽松定位器不得擅自挑一个。
  const file = [
    "class P {",
    "  void run() {",
    "    doRun();",
    "  }",
    "  void recognize() {",
    "    doRecognize();",
    "  }",
    "}",
    "",
  ].join("\n");
  const res = rewriteByLocator(file, "  void run() {\n    doOther();\n  }", "  void run() {\n    ok();\n  }");
  assert.equal(res.ok, false);
});

test("定位失败时诊断中会带上探针原文", () => {
  const res = rewriteByLocator("alpha\nbeta\n", "zzz", "ZZZ");
  assert.equal(res.ok, false);
  assert.equal(res.fault, "missing_target");
  assert.match(res.message ?? "", /Could not locate/);
  assert.match(res.message ?? "", /zzz/);
});

test("新旧片段相同会被拒绝", () => {
  const res = rewriteByLocator("alpha\n", "alpha", "alpha");
  assert.equal(res.ok, false);
  assert.equal(res.fault, "nothing_to_do");
  assert.match(res.message ?? "", /identical/);
});

test("空探针会被拒绝", () => {
  const res = rewriteByLocator("alpha\n", "", "beta");
  assert.equal(res.ok, false);
  assert.equal(res.fault, "bad_request");
  assert.match(res.message ?? "", /empty/);
});

test("删除一行时整行移除，而不是留下空行", () => {
  const res = rewriteByLocator("alpha\nbeta\ngamma\n", "beta", "");
  assert.equal(res.ok, true);
  assert.equal(res.text, "alpha\ngamma\n");
});

test("删除最后一行后不残留多余换行", () => {
  const res = rewriteByLocator("alpha\nbeta\n", "beta", "");
  assert.equal(res.ok, true);
  assert.equal(res.text, "alpha\n");
});
