import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeToolName,
  parseToolCallsFromAssistant,
  scanUnterminatedString,
  softParseArgs,
} from "./parser.ts";

test("softParseArgs: truncated payload is flagged and jsonrepair attempts repair", () => {
  const raw = `{"file_path":"file.ts","content":"some text that was truncated`;
  const args = softParseArgs(raw);
  assert.equal(args._truncated, true);
  // jsonrepair closes the string so the fragment becomes parseable
  assert.equal(typeof args.file_path, "string");
  assert.equal(args.file_path, "file.ts");
});

test("softParseArgs: valid JSON is not flagged as truncated", () => {
  const raw = `{"file_path":"file.ts","content":"complete"}`;
  const args = softParseArgs(raw);
  assert.equal(args._truncated, undefined);
  assert.equal(args.file_path, "file.ts");
  assert.equal(args.content, "complete");
});

test("softParseArgs: invalid JSON is marked unsafe instead of becoming writable arguments", () => {
  const args = softParseArgs('{"file_path":"x",}');
  assert.equal(args._invalid_json, true);
  assert.equal(args._truncated, undefined);
});


test("parseToolCallsFromAssistant: single tool call is parsed correctly", () => {
  const calls = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      { id: "1", type: "function", function: { name: "read_file", arguments: '{"file_path":"test.ts"}' } },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "read_file");
  assert.equal(calls[0]!.arguments.file_path, "test.ts");
});

test("parseToolCallsFromAssistant: multiple tool calls are parsed in order", () => {
  const calls = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      { id: "1", type: "function", function: { name: "read_file", arguments: '{"file_path":"a.ts"}' } },
      { id: "2", type: "function", function: { name: "write_file", arguments: '{"file_path":"b.ts","content":"x"}' } },
    ],
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.name, "read_file");
  assert.equal(calls[1]!.name, "write_file");
});

test("normalizeToolName maps search aliases onto search_symbols", () => {
  assert.equal(normalizeToolName("search"), "search_symbols");
  assert.equal(normalizeToolName("search_code"), "search_symbols");
  assert.equal(normalizeToolName("search-code"), "search_symbols");
  assert.equal(normalizeToolName("Search Code"), "search_symbols");
  assert.equal(normalizeToolName("grep"), "grep");
  assert.equal(normalizeToolName("search_symbols"), "search_symbols");
  assert.equal(normalizeToolName("search_semantic"), "search_semantic");
});

// ── scanUnterminatedString：run_script code 载荷的完整性预检 ──

test("scanUnterminatedString: clean code passes", () => {
  assert.equal(scanUnterminatedString('const x = "hello"; console.log(x);'), null);
  // 转义引号不算未闭合
  assert.equal(scanUnterminatedString('const s = "a\\"b";'), null);
  // 注释内的引号/括号不计
  assert.equal(scanUnterminatedString('// "unterminated\nconst x = 1; /* ) */'), null);
  // 模板字符串与单引号同样支持
  assert.equal(scanUnterminatedString("const t = `a${1}b`; const q = 'ok';"), null);
});

test("scanUnterminatedString: unterminated string reports position", () => {
  const raw = 'const s = "truncated mid';
  const issue = scanUnterminatedString(raw);
  assert.ok(issue, "应检出未闭合字符串");
  assert.equal(issue.kind, "unterminated_string");
  assert.equal(issue.line, 1);
  // 位置指向文本末尾——字符串从第 11 列的引号开始，但直到结尾都未闭合
  assert.equal(issue.column, raw.length + 1);
  assert.ok(issue.snippet.includes("truncated mid"));
  assert.match(issue.detail, /从未闭合/);
});

test("scanUnterminatedString: unclosed bracket reports opening position", () => {
  const issue = scanUnterminatedString('const o = {"a": 1');
  assert.ok(issue);
  assert.equal(issue.kind, "unclosed_bracket");
  assert.equal(issue.line, 1);
  assert.equal(issue.column, 11);
  assert.match(issue.detail, /没有闭合/);
});

test("scanUnterminatedString: extra closer is flagged", () => {
  const issue = scanUnterminatedString("const a = 1; }");
  assert.ok(issue);
  assert.equal(issue.kind, "extra_closer");
  assert.match(issue.detail, /多余的闭括号/);
});

test("scanUnterminatedString: multi-line position tracking", () => {
  const code = 'line1\nline2\nconst s = "oops';
  const issue = scanUnterminatedString(code);
  assert.ok(issue);
  assert.equal(issue.kind, "unterminated_string");
  assert.equal(issue.line, 3);
  // 列指向第 3 行末尾（截断点），而非开引号处
  assert.equal(issue.column, 16);
});
