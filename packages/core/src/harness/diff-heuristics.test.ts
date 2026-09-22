import { describe, expect, it } from "vitest";
import { extractExportDecl, unmatchedExportChanges } from "./diff-heuristics.ts";

const TEMPLATE_CONST_DIFF = `
diff --git a/packages/settings/src/task-decompose-prompt.ts b/packages/settings/src/task-decompose-prompt.ts
--- a/packages/settings/src/task-decompose-prompt.ts
+++ b/packages/settings/src/task-decompose-prompt.ts
@@ -1,4 +1,4 @@
-export const BUILTIN_TASK_DECOMPOSE_PROMPT = \`You are the request-understanding
+export const BUILTIN_TASK_DECOMPOSE_PROMPT = \`You are a programming assistant
 agent.
\`.trim();
`.trim();

describe("extractExportDecl", () => {
  it("parses export const / function / class / interface / type", () => {
    expect(extractExportDecl("export const FOO = 1")?.name).toBe("FOO");
    expect(extractExportDecl("export function bar() {")?.name).toBe("bar");
    expect(extractExportDecl("export default class Baz {")?.name).toBe("Baz");
    expect(extractExportDecl("export interface Qux {")?.name).toBe("Qux");
    expect(extractExportDecl("export type Id = string")?.name).toBe("Id");
  });

  it("ignores non-export lines", () => {
    expect(extractExportDecl("const FOO = 1")).toBeNull();
    expect(extractExportDecl("export { foo }")).toBeNull();
  });
});

describe("unmatchedExportChanges", () => {
  it("treats same-name export const template edits as modification, not add/remove", () => {
    expect(unmatchedExportChanges(TEMPLATE_CONST_DIFF)).toEqual({
      removed: [],
      added: [],
    });
  });

  it("reports a genuine removed export", () => {
    const diff = `
@@ -1,2 +1,1 @@
-export function isMeaningfulRepoMap(text: string): boolean {
-  return text.length > 0;
+const unused = 1;
`.trim();
    expect(unmatchedExportChanges(diff).removed).toEqual([
      "export function isMeaningfulRepoMap(text: string): boolean {",
    ]);
    expect(unmatchedExportChanges(diff).added).toEqual([]);
  });

  it("reports a genuine added export", () => {
    const diff = `
@@ -1,1 +1,2 @@
 const x = 1;
+export const NEW_FLAG = true;
`.trim();
    expect(unmatchedExportChanges(diff).added).toEqual(["export const NEW_FLAG = true;"]);
    expect(unmatchedExportChanges(diff).removed).toEqual([]);
  });

  it("reports rename as remove old + add new", () => {
    const diff = `
@@ -1,1 +1,1 @@
-export function foo() {
+export function bar() {
`.trim();
    expect(unmatchedExportChanges(diff)).toEqual({
      removed: ["export function foo() {"],
      added: ["export function bar() {"],
    });
  });
});
