/**
 * Unit tests for the `CompatibilityAdapter` facade over `SessionOrchestrator` (task 3.14).
 *
 * These tests verify that an instance created through `createCompatibilityAdapter()`
 * behaves identically to one created directly through `createSession()` /
 * `new SessionOrchestrator()` — the facade must not change any observable behavior
 * (requirements.md Requirement 9.7: preserve the current open-project, switch-session,
 * send-message, regenerate, cancel, history, terminal, checkpoint, and change-review
 * behavior).
 *
 * Requirements: 9.7
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import {
  createCompatibilityAdapter,
  COMPATIBILITY_ADAPTER_MODULE_ID,
  type CompatibilityAdapter,
} from "./compatibility-adapter.ts";
import { createSession, SessionOrchestrator } from "./index.ts";

test("createCompatibilityAdapter() returns a real SessionOrchestrator instance", () => {
  const adapter = createCompatibilityAdapter();
  assert.ok(adapter instanceof SessionOrchestrator);
});

test("CompatibilityAdapter and SessionOrchestrator denote the same runtime type (type alias, not a wrapper)", () => {
  // `CompatibilityAdapter` is a type alias for `SessionOrchestrator`; the following
  // assignment only type-checks if both sides are exactly the same type in both
  // directions. This is the compile-time half of the equivalence check.
  const viaFacade: CompatibilityAdapter = createCompatibilityAdapter();
  const viaLegacy: SessionOrchestrator = viaFacade; // no cast needed
  const backAgain: CompatibilityAdapter = viaLegacy; // no cast needed either
  assert.ok(backAgain instanceof SessionOrchestrator);
});

test("instance created via the facade has identical default state to one created directly", () => {
  const viaFacade = createCompatibilityAdapter();
  const viaLegacy = createSession();

  assert.deepEqual(viaFacade.getState(), viaLegacy.getState());
  assert.deepEqual(viaFacade.getHistory(), viaLegacy.getHistory());
  assert.deepEqual(viaFacade.getTerminalLog(), viaLegacy.getTerminalLog());
  assert.deepEqual(viaFacade.listMcpTools(), viaLegacy.listMcpTools());
});

test("methods on a facade-created instance behave identically to a directly-created instance (no workspace)", async () => {
  const viaFacade = createCompatibilityAdapter();
  const viaLegacy = createSession();

  // No workspace is opened in either instance — both should report the same
  // "no workspace" default git status rather than diverging in shape or values.
  const [facadeStatus, legacyStatus] = await Promise.all([
    viaFacade.getGitStatus(),
    viaLegacy.getGitStatus(),
  ]);
  assert.deepEqual(facadeStatus, legacyStatus);

  // Mutating one instance's state must not affect the other — they are independent
  // instances, exactly like two `createSession()` calls would be.
  // (setMode() requires an active session; getState() returns independent shallow copies.)
  const facadeStateA = viaFacade.getState();
  const legacyStateA = viaLegacy.getState();
  assert.deepEqual(facadeStateA, legacyStateA);
  assert.notEqual(facadeStateA, legacyStateA); // different object references

  // sendMessage() without an active session must reject with the same error message
  // on both instances.
  const [facadeResult, legacyResult] = await Promise.allSettled([
    viaFacade.sendMessage("hello"),
    viaLegacy.sendMessage("hello"),
  ]);
  assert.equal(facadeResult.status, "rejected");
  assert.equal(legacyResult.status, "rejected");
  assert.equal(
    (facadeResult as PromiseRejectedResult).reason.message,
    (legacyResult as PromiseRejectedResult).reason.message,
  );
});

test("COMPATIBILITY_ADAPTER_MODULE_ID is a stable, greppable marker string", () => {
  assert.equal(COMPATIBILITY_ADAPTER_MODULE_ID, "compatibility-adapter");
});
