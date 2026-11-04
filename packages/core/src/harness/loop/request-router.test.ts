import assert from "node:assert/strict";
import { test } from "vitest";
import { routeRequest } from "./request-router.ts";

test("routes an exact single-file change to the precise path", () => {
  const route = routeRequest("Fix the validation in src/auth.ts:120-130 and run the focused test");
  assert.equal(route.mode, "precise_single_file");
  assert.deepEqual(route.targetPaths, ["src/auth.ts"]);
  assert.equal(route.startLine, 120);
  assert.equal(route.endLine, 130);
});

test("routes an anchored replacement to the precise path", () => {
  const route = routeRequest('Change `return false` in src/auth.ts');
  assert.equal(route.mode, "precise_single_file");
});

test("keeps a single located question direct without task graph", () => {
  const route = routeRequest("How does src/auth.ts handle the token?");
  assert.equal(route.mode, "simple_direct");
});

test("requires normal exploration when location evidence is missing", () => {
  assert.equal(routeRequest("Fix the login bug").mode, "normal");
});

test("marks multiple files or broad scope as a multi-task candidate", () => {
  assert.equal(routeRequest("Refactor src/a.ts and src/b.ts").mode, "multi_task_candidate");
  assert.equal(routeRequest("Audit all token validation paths").mode, "multi_task_candidate");
});
