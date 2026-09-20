import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeToolName,
  parseToolCallsFromAssistant,
  softParseArgs,
} from "./parser.ts";

test("softParseArgs: truncated payload is flagged and jsonrepair attempts repair", () => {
  const raw = `{"path":"file.ts","content":"some text that was truncated`;
  const args = softParseArgs(raw);
  assert.equal(args._truncated, true);
  // jsonrepair closes the string so the fragment becomes parseable
  assert.equal(typeof args.path, "string");
  assert.equal(args.path, "file.ts");
});

test("softParseArgs: valid JSON is not flagged as truncated", () => {
  const raw = `{"path":"file.ts","content":"complete"}`;
  const args = softParseArgs(raw);
  assert.equal(args._truncated, undefined);
  assert.equal(args.path, "file.ts");
  assert.equal(args.content, "complete");
});

test("parseToolCallsFromAssistant: single tool call is parsed correctly", () => {
  const calls = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      { id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"test.ts"}' } },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "read_file");
  assert.equal(calls[0]!.arguments.path, "test.ts");
});

test("parseToolCallsFromAssistant: multiple tool calls are parsed in order", () => {
  const calls = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      { id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      { id: "2", type: "function", function: { name: "write_file", arguments: '{"path":"b.ts","content":"x"}' } },
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
});
