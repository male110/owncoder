import assert from "node:assert/strict";
import {
  migratePipeline,
  builtinPlanPipeline,
  builtinAgentPipeline,
  ModePipelineSchema,
} from "../packages/settings/dist/index.js";

// 1. 含三种遗留节点的老 plan pipeline
const oldPlan = builtinPlanPipeline();
const withLegacy = ModePipelineSchema.parse({
  nodes: [
    ...oldPlan.nodes,
    { id: "la1", type: "load_anchors", label: "活动计划", enabled: true },
    { id: "dp1", type: "draft_plan", label: "计划提示", enabled: true, prompt: "DRAFT PROMPT", promptZh: "计划提示词" },
    { id: "sp1", type: "save_plan", label: "保存计划", enabled: true },
  ],
  edges: [
    { id: "e1", from: "start", to: "context" },
    { id: "e2", from: "context", to: "la1" },
    { id: "e3", from: "la1", to: "dp1" },
    { id: "e4", from: "dp1", to: "llm" },
    { id: "e5", from: "llm", to: "sp1" },
    { id: "e6", from: "sp1", to: "end" },
  ],
});
const { newPipeline, report } = migratePipeline(withLegacy);
assert.equal(report.moved.length, 3, "应迁移 3 个遗留节点");
assert.equal(report.dropped.length, 0, "无 dropped");
assert.ok(!newPipeline.nodes.some((n) => n.type === "load_anchors"), "load_anchors 已移除");
assert.ok(!newPipeline.nodes.some((n) => n.type === "draft_plan"), "draft_plan 已移除");
assert.ok(!newPipeline.nodes.some((n) => n.type === "save_plan"), "save_plan 已移除");
const ctx = newPipeline.nodes.find((n) => n.type === "context_gather");
assert.equal(ctx.params.injectAnchors, true, "load_anchors → injectAnchors");
const llm = newPipeline.nodes.find((n) => n.type === "explore_tools");
assert.equal(llm.params.allowPlanFiles, true, "save_plan → allowPlanFiles");

// 2. 无遗留节点 → 等价、report 空
const agent = builtinAgentPipeline();
const r2 = migratePipeline(agent);
assert.equal(r2.report.moved.length, 0, "无遗留时 moved 为空");
assert.equal(r2.report.dropped.length, 0, "无遗留时 dropped 为空");
assert.equal(r2.newPipeline.nodes.length, agent.nodes.length, "节点数不变");

// 3. 参数冲突：目标已有 prompt → 不覆盖
const conflict = ModePipelineSchema.parse({
  nodes: [
    { id: "start", type: "start", enabled: true },
    { id: "ctx", type: "context_gather", enabled: true },
    { id: "llm", type: "explore_tools", enabled: true, prompt: "EXISTING", promptZh: "现有", params: { maxIterations: 12, allowPlanFiles: true } },
    { id: "dp", type: "draft_plan", enabled: true, prompt: "DRAFT", promptZh: "草稿" },
    { id: "end", type: "end", enabled: true },
  ],
  edges: [
    { id: "e1", from: "start", to: "ctx" },
    { id: "e2", from: "ctx", to: "llm" },
    { id: "e3", from: "llm", to: "dp" },
    { id: "e4", from: "dp", to: "end" },
  ],
});
const r3 = migratePipeline(conflict);
const llm3 = r3.newPipeline.nodes.find((n) => n.type === "explore_tools");
assert.equal(llm3.prompt, "EXISTING", "目标已有 prompt 不被覆盖");
assert.equal(llm3.promptZh, "现有", "目标已有 promptZh 不被覆盖");

console.log("✅ migrator 验证通过（3 遗留节点 + 无遗留 + 参数冲突）");