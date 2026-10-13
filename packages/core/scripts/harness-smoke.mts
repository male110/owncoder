/**
 * Lightweight harness self-checks (no test runner required).
 * Run: node --import tsx packages/core/scripts/harness-smoke.mts
 * Or after build: node packages/core/dist/... — prefer tsx via pnpm.
 */
import assert from "node:assert/strict";
import { applySearchReplacePatch } from "../src/harness/patch.js";
import { parseToolCallsFromAssistant } from "../src/harness/parser.js";


// patch
{
  const orig = "line1\nhello world\nline3\n";
  const patch = `<<<<<<< SEARCH
hello world
=======
hello OwnCoder
>>>>>>> REPLACE`;
  const r = applySearchReplacePatch(orig, patch);
  assert.equal(r.ok, true);
  assert.ok(r.content?.includes("hello OwnCoder"));
}

// patch: lenient markers (3-char, trailing spaces, lowercase ok)
{
  const orig = "line1\nhello world\nline3\n";
  const patch = `<<< SEARCH
hello world
===       
hello OwnCoder
>>> replace`;
  const r = applySearchReplacePatch(orig, patch);
  assert.equal(r.ok, true, `lenient patch should apply, error: ${r.error}`);
  assert.ok(r.content?.includes("hello OwnCoder"));
}

// patch: format error returns diagnostic, not just bare message
{
  const orig = "line1\nhello world\nline3\n";
  const r = applySearchReplacePatch(orig, "just some text with no markers at all");
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("no SEARCH/REPLACE blocks found"));
  assert.ok(r.error?.includes("Do NOT re-read the file"), "should tell model not to re-read");
  assert.ok(r.error?.includes("Expected format"), "should include format hint");
  assert.ok(r.error?.includes("just some text"), "should preview the bad patch");
}

// patch: SEARCH content mismatch returns a distinct, re-read-friendly error
{
  const orig = "line1\nhello world\nline3\n";
  const patch = `<<<<<<< SEARCH
hello nonexistent
=======
hello OwnCoder
>>>>>>> REPLACE`;
  const r = applySearchReplacePatch(orig, patch);
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes("SEARCH block not found in file"));
  assert.ok(r.error?.includes("Re-read the file"), "should suggest re-reading for content mismatch");
}

// parser: OpenAI-style
{
  const calls = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      {
        id: "1",
        type: "function",
        function: { name: "read_file", arguments: '{"file_path":"a.ts"}' },
      },
    ],
  });
  assert.equal(calls[0]?.name, "read_file");
  assert.equal(calls[0]?.arguments.file_path, "a.ts");
}

// parser: XML
{
  const calls = parseToolCallsFromAssistant({
    content: `<tool_call name="grep">{"pattern":"foo"}</tool_call>`,
  });
  assert.equal(calls[0]?.name, "grep");
}

// parser: recover `path` when arguments JSON is malformed by a large `content`
// string with raw newlines + nested code fences (a common weak-model failure
// mode). JSON.parse fails, but `path` must still be rescued so write_file
// doesn't reject it with "requires a non-empty file path".
{
  const calls = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      {
        id: "1",
        type: "function",
        function: {
          name: "write_file",
          arguments:
            '{"path":"docs/TDD.md","content":"# TDD\n```rust\nlet x = \'a\';\n```\n"}',
        },
      },
    ],
  });
  assert.equal(calls[0]?.name, "write_file");
  assert.equal(calls[0]?.arguments.path, "docs/TDD.md");
}


// parser: recover `path` for apply_patch when arguments JSON is broken by a
// patch payload with raw newlines + unescaped quotes (a common weak-model
// failure mode that drops path and triggers "requires a non-empty file path").
{
  const calls = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      {
        id: "1",
        type: "function",
        function: {
          name: "apply_patch",
          arguments:
            '{"path":"src/foo.ts","patch":"<<<<<<< SEARCH\nconst x = "bug";\n=======\n"}',
        },
      },
    ],
  });
  assert.equal(calls[0]?.name, "apply_patch");
  assert.equal(calls[0]?.arguments.path, "src/foo.ts");
}

// parser: recover `path` when the key has no quotes AND an unescaped quote in
// another field breaks JSON.parse even after repair — forces the fallback into
// extractSingleLineStringFields, which must quote the bare key to rescue path.
{
  const calls = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      {
        id: "1",
        type: "function",
        function: {
          name: "apply_patch",
          arguments: '{path:"src/a.ts",patch:"a"b"}',
        },
      },
    ],
  });
  assert.equal(calls[0]?.arguments.path, "src/a.ts");
}

console.log("harness-smoke: ok");
