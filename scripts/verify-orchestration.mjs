/**
 * T13 smoke test — verify pipeline orchestration behaviors.
 * Run: node scripts/verify-orchestration.mjs
 */
import assert from "node:assert/strict";
import {
  builtinAgentPipeline,
  movePipelineNode,
  addPipelineNode,
  removePipelineNode,
  walkLinearNodes,
  positionConstraintsOf,
  resolveNodeType,
  ModePipelineSchema,
} from "../packages/settings/dist/index.js";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`  ✓ ${name}`); };

const base = builtinAgentPipeline();
const linear = walkLinearNodes(base);
console.log("Base agent pipeline order:", linear.map(n => n.type).join(" → "));

// ── Scenario 1: move history_compact past execute_tools → rejected (slot constraint) ──
check("S1: history_compact 不能跨槽位移到 execute_tools 之后", () => {
  // Find history_compact and try to move it down repeatedly until it hits execute_tools
  let p = base;
  const hcNode = walkLinearNodes(p).find(n => n.type === "history_compact");
  // Move down until we reach execute_tools — should throw when crossing slots
  let threw = false;
  try {
    for (let i = 0; i < 10; i++) {
      p = movePipelineNode(p, hcNode.id, "down");
    }
  } catch (e) {
    threw = true;
  }
  assert.ok(threw, "跨槽位移动应抛错");
});

// ── Scenario 2: reorder within pre-model slot (task_decompose ↔ history_compact) ──
check("S2: task_decompose 可与 history_compact 互换位置（同 pre-model 槽位）", () => {
  let p = base;
  const tdNode = walkLinearNodes(p).find(n => n.type === "task_decompose");
  // task_decompose should be after history_compact in default pipeline
  // Move it up (before history_compact) — same slot, should succeed
  p = movePipelineNode(p, tdNode.id, "up");
  const order = walkLinearNodes(p).map(n => n.type);
  const tdIdx = order.indexOf("task_decompose");
  const hcIdx = order.indexOf("history_compact");
  assert.ok(tdIdx < hcIdx, "task_decompose 应在 history_compact 之前");
});

// ── Scenario 3: disable a node → resolveMidStages skips it ──
check("S3: 禁用节点后 walkLinearNodes 仍包含但 enabled=false", () => {
  const p = base;
  const pvNode = walkLinearNodes(p).find(n => n.type === "post_verify");
  // Simulate disabling: set enabled=false
  const disabled = ModePipelineSchema.parse({
    nodes: p.nodes.map(n => n.id === pvNode.id ? { ...n, enabled: false } : n),
    edges: p.edges,
  });
  const pvInDisabled = walkLinearNodes(disabled).find(n => n.type === "post_verify");
  assert.ok(pvInDisabled && pvInDisabled.enabled === false, "post_verify 节点应存在但被禁用");
});

// ── Scenario 4: non-repeatable add → rejected ──
check("S4: 重复添加 history_compact（不可重复）→ 抛错", () => {
  let threw = false;
  try {
    addPipelineNode(base, "history_compact", "agent");
  } catch (e) {
    threw = true;
  }
  assert.ok(threw, "不可重复添加的节点类型应抛错");
});

// ── Scenario 4b: repeatable add → succeeds ──
check("S4b: 重复添加 execute_tools（可重复）→ 成功", () => {
  const p = addPipelineNode(base, "execute_tools", "agent");
  const count = walkLinearNodes(p).filter(n => n.type === "execute_tools").length;
  assert.equal(count, 2, "应有两个 execute_tools 节点");
});

// ── Scenario 5: non-deletable remove → rejected ──
check("S5: 删除 context_gather（不可删）→ 抛错", () => {
  const ctxNode = walkLinearNodes(base).find(n => n.type === "context_gather");
  let threw = false;
  try {
    removePipelineNode(base, ctxNode.id);
  } catch (e) {
    threw = true;
  }
  assert.ok(threw, "不可删除的节点应抛错");
});

// ── Scenario 6: deletable remove → succeeds ──
check("S6: 删除 post_verify（可删）→ 成功", () => {
  const pvNode = walkLinearNodes(base).find(n => n.type === "post_verify");
  const p = removePipelineNode(base, pvNode.id);
  assert.ok(!walkLinearNodes(p).some(n => n.type === "post_verify"), "post_verify 应被移除");
});

// ── Scenario 7: positionConstraints declared for all types ──
check("S7: 所有节点类型均有 positionConstraints 声明", () => {
  const types = ["start", "context_gather", "history_compact", "task_decompose",
    "explore_tools", "execute_tools", "verify", "post_verify", "present_changes", "end"];
  for (const t of types) {
    const c = positionConstraintsOf(t);
    assert.ok(c, `${t} 应有 positionConstraints`);
    assert.ok(typeof c.deletable === "boolean", `${t}.deletable 应为 boolean`);
    assert.ok(typeof c.repeatable === "boolean", `${t}.repeatable 应为 boolean`);
  }
});

// ── Scenario 8: slot ordering — pre-model < mid < post-model ──
check("S8: 槽位顺序 pre-model(0) < mid(1) < post-model(2)", () => {
  const slots = {
    "history_compact": positionConstraintsOf("history_compact")?.slot,
    "task_decompose": positionConstraintsOf("task_decompose")?.slot,
    "execute_tools": positionConstraintsOf("execute_tools")?.slot,
    "verify": positionConstraintsOf("verify")?.slot,
    "post_verify": positionConstraintsOf("post_verify")?.slot,
    "present_changes": positionConstraintsOf("present_changes")?.slot,
  };
  assert.equal(slots.history_compact, "pre-model");
  assert.equal(slots.task_decompose, "pre-model");
  assert.equal(slots.execute_tools, "mid");
  assert.equal(slots.verify, "post-model");
  assert.equal(slots.post_verify, "post-model");
  assert.equal(slots.present_changes, "post-model");
});

console.log(`\n全部 ${pass} 项验证通过 ✓`);