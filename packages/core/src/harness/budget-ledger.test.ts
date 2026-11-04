import assert from "node:assert/strict";
import { test } from "vitest";
import { BudgetLedger } from "./budget-ledger.ts";

test("child ledgers share monotonic usage with the parent", () => {
  const parent = new BudgetLedger({ toolCalls: 3, nestedCalls: 2 });
  const child = parent.child({ toolCalls: 2, nestedCalls: 1 });
  assert.equal(child.chargeTool("read_file", true).ok, true);
  assert.equal(parent.usedValue("toolCalls"), 1);
  assert.equal(parent.usedValue("nestedCalls"), 1);
  assert.equal(parent.chargeTool("read_file", true).ok, true);
  assert.equal(parent.chargeTool("read_file", true).ok, false);
});

test("read calls consume both logical calls and output bytes", () => {
  const ledger = new BudgetLedger({ readCalls: 1, readBytes: 4 });
  assert.equal(ledger.chargeRead(4).ok, true);
  assert.equal(ledger.chargeRead(1).ok, false);
  assert.equal(ledger.usedValue("readCalls"), 1);
});

test("parallel callers cannot reserve beyond a shared limit", () => {
  const ledger = new BudgetLedger({ toolCalls: 1 });
  assert.equal(ledger.chargeTool("a").ok, true);
  assert.equal(ledger.chargeTool("b").ok, false);
});
