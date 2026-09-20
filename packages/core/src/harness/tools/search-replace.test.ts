import assert from "node:assert/strict";
import { test } from "vitest";
import { applySearchReplace } from "./search-replace.ts";

const SR = (search: string, replace: string) =>
  `<<<<<<< SEARCH\n${search}=======\n${replace}>>>>>>> REPLACE\n`;

test("exact line-level match replaces a single block", () => {
  const file = "import foo\nconst x = 1\nconst y = 2\n";
  const res = applySearchReplace(file, SR("const x = 1\n", "const x = 3\n"));
  assert.equal(res.success, true);
  assert.equal(res.content, "import foo\nconst x = 3\nconst y = 2\n");
});

test("multiple blocks apply sequentially", () => {
  const file = "a\nb\nc\n";
  const patch = SR("a\n", "A\n") + SR("c\n", "C\n");
  const res = applySearchReplace(file, patch);
  assert.equal(res.success, true);
  assert.equal(res.content, "A\nb\nC\n");
});

test("CRLF file matches a LF search via line-ending equivalence", () => {
  const file = "import foo\r\nconst x = 1\r\nconst y = 2\r\n";
  const res = applySearchReplace(file, SR("const x = 1\n", "const x = 3\n"));
  assert.equal(res.success, true);
  assert.equal(res.content, "import foo\r\nconst x = 3\r\nconst y = 2\r\n");
});

test("uniform indent drift is tolerated via whitespace-flexible match", () => {
  // File uses an 8-space base indent; SEARCH/REPLACE use 4 (uniform -4 drift,
  // and every line still has >0 indent so outdent is well-defined).
  const file = "class A {\n        void run() {\n            doThing();\n        }\n}\n";
  const search = "    void run() {\n        doThing();\n    }\n";
  const replace = "    void run() {\n        doThing();\n        doMore();\n    }\n";
  const res = applySearchReplace(file, SR(search, replace));
  assert.equal(res.success, true);
  assert.equal(
    res.content,
    "class A {\n        void run() {\n            doThing();\n            doMore();\n        }\n}\n",
  );
});

test("regression: similar sibling methods are NOT cross-matched (no fuzzy replace)", () => {
  // Two structurally similar methods. SEARCH targets recognize() but contains
  // a typo (saveOcr("z") instead of saveOcr("y")). The old character-level
  // Levenshtein fallback could match this against run() and corrupt it.
  const file = [
    "class Processor {",
    "  void run() {",
    '    saveOcr("x");',
    "    doRun();",
    "  }",
    "  void recognize() {",
    '    saveOcr("y");',
    "    doRecognize();",
    "  }",
    "}",
    "",
  ].join("\n");
  const search = [
    "  void recognize() {",
    '    saveOcr("z");',
    "    doRecognize();",
    "  }",
    "",
  ].join("\n");
  const replace = [
    "  void recognize() {",
    '    saveOcr("y");',
    "    doRecognize();",
    "    cache();",
    "  }",
    "",
  ].join("\n");
  const res = applySearchReplace(file, SR(search, replace));

  // Must fail — never silently apply to the wrong method.
  assert.equal(res.success, false);
  assert.equal(res.content, undefined);
  // run() must be untouched (content unchanged because failure returns no content).
  assert.match(res.error ?? "", /Could not find SEARCH text/);
  // Did-you-mean should point at the real recognize() body, not run().
  assert.match(res.error ?? "", /doRecognize/);
});

test("trailing whitespace differences are tolerated via trailing-whitespace-flexible match", () => {
  // File has trailing spaces on two lines; SEARCH omits them. The body still
  // matches exactly, so the replacement must land safely (not fail).
  const file = "const a = 1;   \nconst b = 2;\t\nconst c = 3;\n";
  const res = applySearchReplace(file, SR("const a = 1;\nconst b = 2;\n", "const a = 10;\nconst b = 20;\n"));
  assert.equal(res.success, true);
  assert.equal(res.content, "const a = 10;\nconst b = 20;\nconst c = 3;\n");
});

test("trailing whitespace differences alone do not cause wrong-location fuzzy replace", () => {
  // A character difference in the body must still fail even when surrounding
  // lines differ only by trailing whitespace.
  const file = "const a = 1;   \nconst b = 2;\nconst c = 3;\n";
  const search = "const a = 1;\nconst b = 99;\n"; // body "99" != "2"
  const res = applySearchReplace(file, SR(search, "const a = 10;\nconst b = 20;\n"));
  assert.equal(res.success, false);
  assert.match(res.error ?? "", /Could not find SEARCH text/);
});

test("non-unique SEARCH fails with a uniqueness error", () => {
  const file = "    }\n    }\n}\n";
  // SEARCH "    }\n" appears three times.
  const res = applySearchReplace(file, SR("    }\n", "  }\n"));
  assert.equal(res.success, false);
  assert.match(res.error ?? "", /not unique/i);
});

test("missing SEARCH fails safely without mutating the file", () => {
  const file = "alpha\nbeta\ngamma\n";
  const res = applySearchReplace(file, SR("beta\n", "BETA\n") + SR("zzz\n", "ZZZ\n"));
  assert.equal(res.success, false);
  assert.equal(res.content, undefined);
  assert.match(res.error ?? "", /Could not find SEARCH text/);
});

test("a ======= line inside file content does not break parsing or matching", () => {
  // File contains a leftover conflict marker line from a prior corrupted edit.
  const file = "int a = 1;\n=======\nint b = 2;\n";
  const res = applySearchReplace(file, SR("int a = 1;\n", "int a = 10;\n"));
  assert.equal(res.success, true);
  assert.equal(res.content, "int a = 10;\n=======\nint b = 2;\n");
});

test("empty SEARCH section is rejected", () => {
  const file = "x\n";
  const res = applySearchReplace(file, SR("", "y\n"));
  assert.equal(res.success, false);
  assert.match(res.error ?? "", /SEARCH section is empty/);
});

test("patch with no blocks is rejected", () => {
  const res = applySearchReplace("x\n", "just some prose, no markers");
  assert.equal(res.success, false);
  assert.match(res.error ?? "", /No SEARCH\/REPLACE blocks/);
});