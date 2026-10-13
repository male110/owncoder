import { describe, it, expect } from "vitest";
import {
  checkTermination,
  createLoopState,
  updateStateAfterResponse,
  updateStateAfterTools,
  resetOutputTrackingForNewTask,
  createTerminationConfig,
  DEFAULT_TERMINATION_CONFIG,
  type TerminationConfig,
  type TerminationResult,
} from "./termination.js";
// Type guard helper
function assertTerminated(result: { shouldTerminate: boolean }): asserts result is TerminationResult {
  expect(result.shouldTerminate).toBe(true);
}
describe("Termination Logic", () => {
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  // Hard Limits Tests
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  describe("Hard Limits", () => {
    it("should terminate on max iterations", () => {
      const state = createLoopState();
      state.iteration = DEFAULT_TERMINATION_CONFIG.maxIterations + 1;
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result); expect(result.reason).toContain("maximum iterations");
    });
    it("should terminate on max tool calls", () => {
      const state = createLoopState();
      state.totalToolCalls = 100;
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result); expect(result.reason).toContain("maximum tool calls");
    });
    it("should not terminate on high token usage (token budget check disabled)", () => {
      const state = createLoopState();
      state.totalTokens = 50_001;
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("should terminate on cost budget exceeded", () => {
      const state = createLoopState();
      state.totalCost = 15.1;
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result); expect(result.reason).toContain("Cost budget exceeded");
    });
  });
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  // Natural Completion Tests
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  describe("Natural Completion", () => {
    it("should terminate on finish_reason=stop with text and no tools", () => {
      const state = createLoopState();
      state.lastFinishReason = "stop";
      state.lastContent = "Task completed successfully.";
      state.lastToolCalls = [];
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result); expect(result.reason).toContain("Natural completion");
    });
    it("should terminate on finish_reason=stop when there is no current task", () => {
      // �?tasks / �?turn information plan锛歝urrentTask 涓虹┖锛岀函鏂囨湰 stop 蹇呴』鑳借嚜鐒剁粨鏉熴€?
      const state = createLoopState();
      expect(state.currentTask).toBeUndefined();
      state.lastFinishReason = "stop";
      state.lastContent = "宸插鐞嗗畬姣曪紝娌℃湁鏇村宸ヤ綔�?";
      state.lastToolCalls = [];
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result);
      expect(result.reason).toContain("Natural completion");
    });
    it("should NOT terminate on finish_reason=stop if no content", () => {
      const state = createLoopState();
      state.lastFinishReason = "stop";
      state.lastContent = "";
      state.lastToolCalls = [];
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("should NOT terminate on finish_reason=stop if tools present", () => {
      const state = createLoopState();
      state.lastFinishReason = "stop";
      state.lastContent = "Calling a tool...";
      state.lastToolCalls = [
        { id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }
      ];
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("should terminate after 2 consecutive text-only turns", () => {
      const state = createLoopState();
      state.lastContent = "Task is done.";
      state.lastToolCalls = [];
      state.consecutiveTextOnlyTurns = 2;
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result); expect(result.reason).toContain("consecutive text-only");
    });
    it("should NOT terminate after 1 text-only turn", () => {
      const state = createLoopState();
      state.lastContent = "Let me check something...";
      state.lastToolCalls = [];
      state.consecutiveTextOnlyTurns = 1;
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("treats finish_reason=stop as completion even while information needs are unmet", () => {
      const state = createLoopState({
        id: "step_1",
        description: "Inspect login",
        status: "in_progress",
        dependsOn: [],
        retryCount: 0,
        maxRetries: 0,
      });
      state.lastFinishReason = "stop";
      state.lastContent = "I think I understand the login flow.";
      state.lastToolCalls = [];
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.reason).toContain("Natural completion");
      }
    });
    it("terminates on similar outputs even while information needs are unmet", () => {
      const state = createLoopState({
        id: "step_1",
        description: "Inspect login",
        status: "in_progress",
        dependsOn: [],
        retryCount: 0,
        maxRetries: 0,
      });
      state.lastContent = "I still need to read src/login.ts";
      state.lastToolCalls = [];
      state.consecutiveSimilarOutputs = 1;
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
    });
    it("should terminate repeated tools without progress even while information needs are unmet", () => {
      const state = createLoopState({
        id: "step_1",
        description: "Inspect login",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 0,
      });
      state.toolCallHistory.push(
        { name: "read_file", arguments: { file_path: "src/login.ts" }, result: "same", iteration: 0 },
        { name: "read_file", arguments: { file_path: "src/login.ts" }, result: "same", iteration: 1 },
        { name: "read_file", arguments: { file_path: "src/login.ts" }, result: "same", iteration: 2 },
      );
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) expect(result.metadata?.noProgress).toBe(true);
    });
    it("should allow repeated reads when their ranges or results show progress", () => {
      const state = createLoopState({
        id: "step_1",
        description: "Inspect login",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 0,
      });
      state.toolCallHistory.push(
        { name: "read_file", arguments: { file_path: "src/login.ts", offset: 1 }, result: "line 1", iteration: 0 },
        { name: "read_file", arguments: { file_path: "src/login.ts", offset: 2 }, result: "line 2", iteration: 1 },
        { name: "read_file", arguments: { file_path: "src/login.ts", offset: 3 }, result: "line 3", iteration: 2 },
      );
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
  });
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  // Tool Loop Detection Tests
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  describe("Tool Loop Detection", () => {
    it("should detect tool loop after 2 repetitions (same tool + args)", () => {
      const state = createLoopState();
      // Simulate calling read_file 3 times with identical arguments
      for (let i = 0; i < 3; i++) {
        state.toolCallHistory.push({
          name: "read_file",
          arguments: { file_path: "src/foo.ts", offset: 0 },
          result: "file content...",
          iteration: i,
        });
      }
      state.lastToolCalls = [
        { id: "x", type: "function", function: { name: "read_file", arguments: "{}" } }
      ];
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result); expect(result.reason).toContain("Tool loop detected");
      expect(result.reason).toContain("read_file");
    });
    it("should NOT detect loop for legitimate pagination (different offsets)", () => {
      const state = createLoopState();
      // Different offsets = legitimate pagination
      state.toolCallHistory.push(
        { name: "read_file", arguments: { file_path: "src/foo.ts", offset: 0 }, result: "...", iteration: 0 },
        { name: "read_file", arguments: { file_path: "src/foo.ts", offset: 100 }, result: "...", iteration: 1 },
        { name: "read_file", arguments: { file_path: "src/foo.ts", offset: 200 }, result: "...", iteration: 2 },
      );
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("should NOT detect loop for different files (same tool)", () => {
      const state = createLoopState();
      state.toolCallHistory.push(
        { name: "read_file", arguments: { file_path: "src/foo.ts" }, result: "...", iteration: 0 },
        { name: "read_file", arguments: { file_path: "src/bar.ts" }, result: "...", iteration: 1 },
        { name: "read_file", arguments: { file_path: "src/baz.ts" }, result: "...", iteration: 2 },
      );
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("should detect loop only in recent window (not across entire history)", () => {
      const state = createLoopState();
      // Old calls (outside window)
      state.toolCallHistory.push(
        { name: "read_file", arguments: { file_path: "src/old.ts" }, result: "...", iteration: 0 },
        { name: "read_file", arguments: { file_path: "src/old.ts" }, result: "...", iteration: 1 },
      );
      // Recent calls (inside window) - different tool
      state.toolCallHistory.push(
        { name: "grep", arguments: { query: "test" }, result: "...", iteration: 2 },
        { name: "grep", arguments: { query: "test" }, result: "...", iteration: 3 },
        { name: "grep", arguments: { query: "test" }, result: "...", iteration: 4 },
      );
      state.lastToolCalls = [
        { id: "x", type: "function", function: { name: "grep", arguments: "{}" } }
      ];
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result); expect(result.reason).toContain("grep");
    });
  });
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  // Output Similarity Detection Tests (NEW)
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  describe("Output Similarity Detection", () => {
    it("should detect when model repeats same output twice", () => {
      const state = createLoopState();
      // First iteration
      updateStateAfterResponse(state, {
        content: "The task is complete. I have successfully finished all the work.",
        toolCalls: [],
        finishReason: null,  // Don't trigger natural completion
        tokens: 100,
        cost: 0.01,
      });
      // Second iteration - nearly identical output
      updateStateAfterResponse(state, {
        content: "The task is complete. I have finished all the work successfully.",
        toolCalls: [],
        finishReason: null,  // Don't trigger natural completion
        tokens: 100,
        cost: 0.01,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result);
      // Will terminate via text-only or similarity detection
      expect(result.reason).toMatch(/consecutive (similar outputs|text-only responses)/);
    });
    it("should detect when model keeps saying the same thing", () => {
      const state = createLoopState();
      // Model keeps repeating "I need more information"
      updateStateAfterResponse(state, {
        content: "I need more information to complete this task.",
        toolCalls: [],
        finishReason: null,  // Don't trigger natural completion
        tokens: 50,
        cost: 0.005,
      });
      updateStateAfterResponse(state, {
        content: "I still need more information to complete the task.",
        toolCalls: [],
        finishReason: null,  // Don't trigger natural completion
        tokens: 50,
        cost: 0.005,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result);
      // Will terminate via text-only or similarity detection
      expect(result.reason).toMatch(/consecutive (similar outputs|text-only responses)/);
    });
    it("should NOT terminate on genuinely different outputs", () => {
      const state = createLoopState();
      updateStateAfterResponse(state, {
        content: "Let me read the authentication module first.",
        toolCalls: [{ id: "1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ file_path: "auth.ts" }) } }],
        finishReason: null,
        tokens: 50,
        cost: 0.005,
      });
      updateStateAfterResponse(state, {
        content: "Now I'll check the database connection logic.",
        toolCalls: [],
        finishReason: null,
        tokens: 50,
        cost: 0.005,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("should NOT terminate when output similarity is below threshold", () => {
      const state = createLoopState();
      // 50% similar - below 80% threshold
      updateStateAfterResponse(state, {
        content: "The authentication module uses JWT tokens for session management.",
        toolCalls: [{ id: "1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ file_path: "auth.ts" }) } }],
        finishReason: null,
        tokens: 50,
        cost: 0.005,
      });
      updateStateAfterResponse(state, {
        content: "JWT tokens ensure secure authentication across different services.",
        toolCalls: [],
        finishReason: null,
        tokens: 50,
        cost: 0.005,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      // Should not terminate - similarity is around 40-50%
      expect(result.shouldTerminate).toBe(false);
    });
    it("should allow disabling similarity check via config", () => {
      const state = createLoopState();
      updateStateAfterResponse(state, {
        content: "Task completed.",
        toolCalls: [],
        finishReason: null,  // Don't trigger natural completion yet
        tokens: 50,
        cost: 0.005,
      });
      updateStateAfterResponse(state, {
        content: "Task completed.",
        toolCalls: [],
        finishReason: null,  // Don't trigger natural completion yet
        tokens: 50,
        cost: 0.005,
      });
      const config: TerminationConfig = {
        ...DEFAULT_TERMINATION_CONFIG,
        enableOutputSimilarityCheck: false,
      };
      const result = checkTermination(state, config);
      // Should not terminate because similarity check is disabled
      // (will terminate on consecutiveTextOnlyTurns instead)
      assertTerminated(result); expect(result.reason).toContain("text-only");
    });
  });
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  // State Update Tests
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  describe("State Updates", () => {
    it("should track consecutive text-only turns", () => {
      const state = createLoopState();
      // Turn 1: text only
      updateStateAfterResponse(state, {
        content: "Analyzing...",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0.001,
      });
      expect(state.consecutiveTextOnlyTurns).toBe(1);
      // Turn 2: text only
      updateStateAfterResponse(state, {
        content: "Done.",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0.001,
      });
      expect(state.consecutiveTextOnlyTurns).toBe(2);
    });
    it("should reset consecutive text-only turns on tool call", () => {
      const state = createLoopState();
      // Turn 1: text only
      updateStateAfterResponse(state, {
        content: "Analyzing...",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0.001,
      });
      expect(state.consecutiveTextOnlyTurns).toBe(1);
      // Turn 2: with tools
      updateStateAfterResponse(state, {
        content: "Reading file...",
        toolCalls: [
          { id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }
        ],
        finishReason: "stop",
        tokens: 10,
        cost: 0.001,
      });
      expect(state.consecutiveTextOnlyTurns).toBe(0);
    });
    it("should accumulate tokens and cost", () => {
      const state = createLoopState();
      updateStateAfterResponse(state, {
        content: "Step 1",
        toolCalls: [],
        finishReason: "stop",
        tokens: 100,
        cost: 0.01,
      });
      updateStateAfterResponse(state, {
        content: "Step 2",
        toolCalls: [],
        finishReason: "stop",
        tokens: 150,
        cost: 0.015,
      });
      expect(state.totalTokens).toBe(250);
      expect(state.totalCost).toBeCloseTo(0.025);
    });
    it("should track tool call history", () => {
      const state = createLoopState();
      updateStateAfterTools(state, [
        {
          name: "read_file",
          arguments: { file_path: "src/foo.ts" },
          result: "file content",
        },
        {
          name: "grep",
          arguments: { query: "test" },
          result: "3 matches",
        },
      ]);
      expect(state.totalToolCalls).toBe(2);
      expect(state.toolCallHistory).toHaveLength(2);
      expect(state.toolCallHistory[0]?.name).toBe("read_file");
      expect(state.toolCallHistory[1]?.name).toBe("grep");
    });
  });
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  // Edge Cases Tests
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  describe("Edge Cases", () => {
    describe("calculateSimilarity edge cases", () => {
      it("should handle both empty strings (100% similar)", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          tokens: 0,
          cost: 0,
        });
        updateStateAfterResponse(state, {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          tokens: 0,
          cost: 0,
        });
        // Both empty �?should not increment similarity counter
        // (because hasCurrentContent and hasPreviousContent are both false)
        expect(state.consecutiveSimilarOutputs).toBe(0);
      });
      it("should handle one empty, one non-empty (0% similar)", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "Task completed",
          toolCalls: [],
          finishReason: "stop",
          tokens: 10,
          cost: 0.001,
        });
        updateStateAfterResponse(state, {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          tokens: 0,
          cost: 0,
        });
        expect(state.consecutiveSimilarOutputs).toBe(0);
      });
      it("should handle only whitespace (treated as empty)", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "   \n\t  ",
          toolCalls: [],
          finishReason: "stop",
          tokens: 0,
          cost: 0,
        });
        updateStateAfterResponse(state, {
          content: "  \n  ",
          toolCalls: [],
          finishReason: "stop",
          tokens: 0,
          cost: 0,
        });
        // Both trim to empty �?should not increment
        expect(state.consecutiveSimilarOutputs).toBe(0);
      });
      it("should handle very long texts efficiently", () => {
        const state = createLoopState();
        // Create a 5000-word text
        const longText1 = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
        const longText2 = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
        const startTime = Date.now();
        updateStateAfterResponse(state, {
          content: longText1,
          toolCalls: [],
          finishReason: "stop",
          tokens: 5000,
          cost: 0.5,
        });
        updateStateAfterResponse(state, {
          content: longText2,
          toolCalls: [],
          finishReason: "stop",
          tokens: 5000,
          cost: 0.5,
        });
        const elapsed = Date.now() - startTime;
        // Should complete in < 50ms even for 5k words
        expect(elapsed).toBeLessThan(50);
        // Should detect as identical
        expect(state.consecutiveSimilarOutputs).toBe(1);
      });
      it("should handle texts with only special characters", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "@#$%^&*()",
          toolCalls: [],
          finishReason: "stop",
          tokens: 10,
          cost: 0.001,
        });
        updateStateAfterResponse(state, {
          content: "!@#$%^&*()",
          toolCalls: [],
          finishReason: "stop",
          tokens: 10,
          cost: 0.001,
        });
        // Special chars are treated as separate words
        // Some overlap �?should calculate similarity
        expect(state.consecutiveSimilarOutputs).toBeGreaterThanOrEqual(0);
      });
      it("should handle text with length difference > 50%", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "short",
          toolCalls: [],
          finishReason: "stop",
          tokens: 10,
          cost: 0.001,
        });
        updateStateAfterResponse(state, {
          content: "This is a much much much longer text with many more words",
          toolCalls: [],
          finishReason: "stop",
          tokens: 20,
          cost: 0.002,
        });
        // Fast path should kick in �?similarity = 0 �?reset counter
        expect(state.consecutiveSimilarOutputs).toBe(0);
      });
      it("should handle medium similarity (50-80% range)", () => {
        const state = createLoopState();
        // ~60% similar (some words overlap)
        updateStateAfterResponse(state, {
          content: "The authentication module uses JWT tokens for secure access",
          toolCalls: [],
          finishReason: "stop",
          tokens: 50,
          cost: 0.005,
        });
        // First update sets consecutiveSimilarOutputs = 0 (no previous)
        expect(state.consecutiveSimilarOutputs).toBe(0);
        updateStateAfterResponse(state, {
          content: "JWT tokens provide authentication and authorization capabilities",
          toolCalls: [],
          finishReason: "stop",
          tokens: 50,
          cost: 0.005,
        });
        // Medium similarity �?counter should stay at 0 (not increment, not reset)
        // But since we start from 0, it stays 0
        expect(state.consecutiveSimilarOutputs).toBe(0);
      });
      it("should detect near-duplicate Chinese reports as similar", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "宸插畬鎴愬寰幆缁堟閫昏緫鐨勪慨澶嶏紝涓枃杩戦噸澶嶈緭鍑轰細琚浜屽眰鎶撲綇�?",
          toolCalls: [],
          finishReason: null,
          tokens: 40,
          cost: 0.004,
        });
        expect(state.consecutiveSimilarOutputs).toBe(0);
        updateStateAfterResponse(state, {
          content: "宸插畬鎴愬寰幆缁堟閫昏緫鐨勪慨澶嶏紝涓枃杩戦噸澶嶈緭鍑轰細琚浜屽眰鎶撲綇�?",
          toolCalls: [],
          finishReason: null,
          tokens: 40,
          cost: 0.004,
        });
        expect(state.consecutiveSimilarOutputs).toBe(1);
        const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
        assertTerminated(result);
        expect(result.reason).toMatch(/consecutive similar outputs/);
        // Similar outputs = model converged on a final answer �?normal completion,
        // must not surface as aborted / "Task may be incomplete".
        expect(result.aborted).toBe(false);
        expect(result.metadata?.normalCompletion).toBe(true);
        expect(result.reason).not.toContain("Task may be incomplete");
      });
      it("should detect paraphrased Chinese reports as similar", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "鏈€缁堟姤鍛婂彧灞曠ず涓€娆★紝涓嶈鎶婂惊鐜唴鍐欏叆鐨勫唴瀹瑰啀灞曠ず涓€閬嶃€?",
          toolCalls: [],
          finishReason: null,
          tokens: 40,
          cost: 0.004,
        });
        expect(state.consecutiveSimilarOutputs).toBe(0);
        updateStateAfterResponse(state, {
          content: "鏈€缁堟姤鍛婂彧灞曠ず涓€娆★紝涓嶈鎶婂惊鐜唴鍐欏叆鐨勫唴瀹瑰啀娆″睍绀轰竴閬嶃�?",
          toolCalls: [],
          finishReason: null,
          tokens: 40,
          cost: 0.004,
        });
        expect(state.consecutiveSimilarOutputs).toBe(1);
      });
      it("should not treat unrelated Chinese reports as similar", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "宸插畾浣嶅埌鐩镐技搴﹁绠楀涓枃绌虹櫧鍒嗚瘝澶辨晥鐨勯棶棰樸�?",
          toolCalls: [],
          finishReason: null,
          tokens: 30,
          cost: 0.003,
        });
        expect(state.consecutiveSimilarOutputs).toBe(0);
        updateStateAfterResponse(state, {
          content: "鎺ヤ笅鏉ヤ細鍦ㄥ伐鍏锋墽琛屽悗鐨勭户缁矾寰勯噷琛ヤ笂鐘舵€佹洿鏂般�?",
          toolCalls: [],
          finishReason: null,
          tokens: 30,
          cost: 0.003,
        });
        expect(state.consecutiveSimilarOutputs).toBe(0);
      });
    });
    describe("resetOutputTrackingForNewTask", () => {
      it("clears similarity and stop signals so the next task is not treated as finished", () => {
        const state = createLoopState({
          id: "task_a",
          description: "First task",
          status: "completed",
          dependsOn: [],retryCount: 0,
          maxRetries: 0,
        });
        updateStateAfterResponse(state, {
          content: "宸插畬鎴愬寰幆缁堟閫昏緫鐨勪慨澶嶏紝涓枃杩戦噸澶嶈緭鍑轰細琚浜屽眰鎶撲綇�?",
          toolCalls: [],
          finishReason: "stop",
          tokens: 40,
          cost: 0.004,
        });
        updateStateAfterResponse(state, {
          content: "宸插畬鎴愬寰幆缁堟閫昏緫鐨勪慨澶嶏紝涓枃杩戦噸澶嶈緭鍑轰細琚浜屽眰鎶撲綇�?",
          toolCalls: [],
          finishReason: "stop",
          tokens: 40,
          cost: 0.004,
        });
        expect(state.consecutiveSimilarOutputs).toBe(1);
        expect(checkTermination(state, DEFAULT_TERMINATION_CONFIG).shouldTerminate).toBe(true);
        state.currentTask = {
          id: "task_b",
          description: "Second task that should continue",
          status: "in_progress",
          dependsOn: [],retryCount: 0,
          maxRetries: 0,
        };
        resetOutputTrackingForNewTask(state);
        expect(state.consecutiveSimilarOutputs).toBe(0);
        expect(state.consecutiveTextOnlyTurns).toBe(0);
        expect(state.lastContent).toBe("");
        expect(state.previousContent).toBe("");
        expect(state.lastFinishReason).toBeNull();
        expect(state.lastToolCalls).toEqual([]);
        expect(state.explorationSkipCount).toBe(0);
        expect(state.lastIterationHadExplorationSkip).toBe(false);
        const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
        expect(result.shouldTerminate).toBe(false);
      });
    });
    describe("detectToolLoop edge cases", () => {
      it("should detect loop at exact threshold (3 calls with maxRepeat=2)", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxSameToolRepeat: 2 };
        // Call 1
        updateStateAfterTools(state, [
          { name: "read_file", arguments: { file_path: "foo.ts" }, result: "..." }
        ]);
        // Call 2 (repeat 1)
        updateStateAfterTools(state, [
          { name: "read_file", arguments: { file_path: "foo.ts" }, result: "..." }
        ]);
        // Call 3 (repeat 2) - should trigger at exactly 3 calls
        updateStateAfterTools(state, [
          { name: "read_file", arguments: { file_path: "foo.ts" }, result: "..." }
        ]);
        state.lastToolCalls = [
          { id: "x", type: "function", function: { name: "read_file", arguments: "{}" } }
        ];
        const result = checkTermination(state, config);
        assertTerminated(result); expect(result.reason).toContain("Tool loop detected");
      });
      it("should NOT detect loop at threshold - 1 (2 calls with maxRepeat=2)", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxSameToolRepeat: 2 };
        // Call 1
        updateStateAfterTools(state, [
          { name: "read_file", arguments: { file_path: "foo.ts" }, result: "..." }
        ]);
        // Call 2 (repeat 1) - should NOT trigger yet
        updateStateAfterTools(state, [
          { name: "read_file", arguments: { file_path: "foo.ts" }, result: "..." }
        ]);
        state.lastToolCalls = [
          { id: "x", type: "function", function: { name: "read_file", arguments: "{}" } }
        ];
        const result = checkTermination(state, config);
        expect(result.shouldTerminate).toBe(false);
      });
      it("should handle case-insensitive query normalization", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxSameToolRepeat: 2 };
        // Same query, different cases
        updateStateAfterTools(state, [
          { name: "grep", arguments: { query: "Authentication" }, result: "..." }
        ]);
        updateStateAfterTools(state, [
          { name: "grep", arguments: { query: "authentication" }, result: "..." }
        ]);
        updateStateAfterTools(state, [
          { name: "grep", arguments: { query: "AUTHENTICATION" }, result: "..." }
        ]);
        state.lastToolCalls = [
          { id: "x", type: "function", function: { name: "grep", arguments: "{}" } }
        ];
        const result = checkTermination(state, config);
        // Should detect as loop (all normalized to same query)
        assertTerminated(result); expect(result.reason).toContain("grep");
      });
      it("should handle floating point number normalization", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxSameToolRepeat: 2 };
        // Same number with floating point noise
        updateStateAfterTools(state, [
          { name: "custom_tool", arguments: { threshold: 0.5 }, result: "..." }
        ]);
        updateStateAfterTools(state, [
          { name: "custom_tool", arguments: { threshold: 0.500001 }, result: "..." }
        ]);
        updateStateAfterTools(state, [
          { name: "custom_tool", arguments: { threshold: 0.5 }, result: "..." }
        ]);
        state.lastToolCalls = [
          { id: "x", type: "function", function: { name: "custom_tool", arguments: "{}" } }
        ];
        const result = checkTermination(state, config);
        // Should detect as loop (normalized to 3 decimals)
        expect(result.shouldTerminate).toBe(true);
      });
      it("should handle empty history", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxSameToolRepeat: 2 };
        // No tools called yet
        state.lastToolCalls = [];
        const result = checkTermination(state, config);
        expect(result.shouldTerminate).toBe(false);
      });
      it("should handle history length exactly at window size", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxSameToolRepeat: 2 };
        // Fill history with exactly 6 calls (window size)
        for (let i = 0; i < 6; i++) {
          updateStateAfterTools(state, [
            { name: "read_file", arguments: { file_path: `file${i}.ts` }, result: "..." }
          ]);
        }
        state.lastToolCalls = [
          { id: "x", type: "function", function: { name: "read_file", arguments: "{}" } }
        ];
        const result = checkTermination(state, config);
        // All different files �?no loop
        expect(result.shouldTerminate).toBe(false);
      });
    });
    describe("updateStateAfterResponse edge cases", () => {
      it("should handle consecutive empty responses", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          tokens: 0,
          cost: 0,
        });
        updateStateAfterResponse(state, {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          tokens: 0,
          cost: 0,
        });
        updateStateAfterResponse(state, {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          tokens: 0,
          cost: 0,
        });
        // Empty responses shouldn't increment consecutiveTextOnlyTurns
        expect(state.consecutiveTextOnlyTurns).toBe(0);
        expect(state.consecutiveSimilarOutputs).toBe(0);
      });
      it("should handle alternating content and empty", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "Step 1",
          toolCalls: [],
          finishReason: "stop",
          tokens: 10,
          cost: 0.001,
        });
        updateStateAfterResponse(state, {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          tokens: 0,
          cost: 0,
        });
        updateStateAfterResponse(state, {
          content: "Step 2",
          toolCalls: [],
          finishReason: "stop",
          tokens: 10,
          cost: 0.001,
        });
        // consecutiveTextOnlyTurns should reset on empty
        expect(state.consecutiveTextOnlyTurns).toBe(1);
      });
      it("should accumulate tokens and cost correctly", () => {
        const state = createLoopState();
        updateStateAfterResponse(state, {
          content: "A",
          toolCalls: [],
          finishReason: "stop",
          tokens: 100,
          cost: 0.01,
        });
        updateStateAfterResponse(state, {
          content: "B",
          toolCalls: [],
          finishReason: "stop",
          tokens: 200,
          cost: 0.02,
        });
        updateStateAfterResponse(state, {
          content: "C",
          toolCalls: [],
          finishReason: "stop",
          tokens: 300,
          cost: 0.03,
        });
        expect(state.totalTokens).toBe(600);
        expect(state.totalCost).toBeCloseTo(0.06);
        expect(state.iteration).toBe(3);
      });
    });
    describe("Boundary conditions", () => {
      it("should handle iteration count at exact limit", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxIterations: 5 };
        state.iteration = 5;
        const result = checkTermination(state, config);
        assertTerminated(result); expect(result.reason).toContain("maximum iterations");
      });
      it("should handle tool calls at exact limit", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxTotalToolCalls: 10 };
        state.totalToolCalls = 10;
        const result = checkTermination(state, config);
        assertTerminated(result); expect(result.reason).toContain("maximum tool calls");
      });
      it("should ignore tokens at configured maxTokensPerTurn (token budget check disabled)", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxTokensPerTurn: 1000 };
        state.totalTokens = 1000;
        const result = checkTermination(state, config);
        expect(result.shouldTerminate).toBe(false);
      });
      it("should handle cost at exact limit", () => {
        const state = createLoopState();
        const config = { ...DEFAULT_TERMINATION_CONFIG, maxCostPerTurn: 1.0 };
        state.totalCost = 1.0;
        const result = checkTermination(state, config);
        assertTerminated(result); expect(result.reason).toContain("Cost budget exceeded");
      });
      it("should handle all limits disabled", () => {
        const state = createLoopState();
        const config: TerminationConfig = {
          maxIterations: Number.MAX_SAFE_INTEGER,
          maxTotalToolCalls: Number.MAX_SAFE_INTEGER,
          maxTokensPerTurn: Number.MAX_SAFE_INTEGER,
          maxCostPerTurn: Number.MAX_SAFE_INTEGER,
          maxSameToolRepeat: Number.MAX_SAFE_INTEGER,
          maxConsecutiveTextOnly: Number.MAX_SAFE_INTEGER,
          explorationTermination: {
            ...DEFAULT_TERMINATION_CONFIG.explorationTermination,
            baseSkipThreshold: 0,
          },
          enableStuckDetection: false,
          enableBudgetLimits: false,
          enableTaskValidation: false,
          enableOutputSimilarityCheck: false,
        };
        state.iteration = 1000;
        state.totalToolCalls = 1000;
        state.totalTokens = 1_000_000;
        state.totalCost = 100.0;
        const result = checkTermination(state, config);
        // Should not terminate (all limits disabled)
        expect(result.shouldTerminate).toBe(false);
      });
    });
  });
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  // Integration Tests (Realistic Scenarios)
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
  describe("Realistic Scenarios", () => {
    it("scenario: model completes task in 5 iterations", () => {
      const state = createLoopState();
      // Turn 1: read file
      updateStateAfterResponse(state, {
        content: "Let me read the file",
        toolCalls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        finishReason: "stop",
        tokens: 50,
        cost: 0.005,
      });
      expect(checkTermination(state, DEFAULT_TERMINATION_CONFIG).shouldTerminate).toBe(false);
      // Turn 2: analyze
      updateStateAfterResponse(state, {
        content: "I see the issue, let me fix it",
        toolCalls: [{ id: "2", type: "function", function: { name: "apply_patch", arguments: "{}" } }],
        finishReason: "stop",
        tokens: 50,
        cost: 0.005,
      });
      expect(checkTermination(state, DEFAULT_TERMINATION_CONFIG).shouldTerminate).toBe(false);
      // Turn 3: verify
      updateStateAfterResponse(state, {
        content: "Running type check",
        toolCalls: [{ id: "3", type: "function", function: { name: "type_check", arguments: "{}" } }],
        finishReason: "stop",
        tokens: 50,
        cost: 0.005,
      });
      expect(checkTermination(state, DEFAULT_TERMINATION_CONFIG).shouldTerminate).toBe(false);
      // Turn 4: final response
      updateStateAfterResponse(state, {
        content: "Task completed. The bug has been fixed and tests pass.",
        toolCalls: [],
        finishReason: "stop",
        tokens: 50,
        cost: 0.005,
      });
      // Should terminate on finish_reason=stop + no tools
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result); expect(result.reason).toContain("Natural completion");
    });
    it("scenario: model gets stuck in read loop", () => {
      const state = createLoopState();
      // Keeps reading the same file
      for (let i = 0; i < 3; i++) {
        updateStateAfterResponse(state, {
          content: `Reading file (attempt ${i + 1})`,
          toolCalls: [{ id: `${i}`, type: "function", function: { name: "read_file", arguments: '{"file_path":"src/foo.ts"}' } }],
          finishReason: "stop",
          tokens: 50,
          cost: 0.005,
        });
        updateStateAfterTools(state, [
          {
            name: "read_file",
            arguments: { file_path: "src/foo.ts", offset: 0 },
            result: "same file content",
          },
        ]);
      }
      // Should detect loop after 3 repetitions
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result); expect(result.reason).toContain("Tool loop detected");
    });
    it("scenario: model keeps saying it needs more info", () => {
      const state = createLoopState();
      // Turn 1
      updateStateAfterResponse(state, {
        content: "I need more information about the authentication module.",
        toolCalls: [],
        finishReason: null,  // Don't trigger natural completion
        tokens: 50,
        cost: 0.005,
      });
      // Turn 2 - similar response
      updateStateAfterResponse(state, {
        content: "I still need more information about the authentication module.",
        toolCalls: [],
        finishReason: null,  // Don't trigger natural completion
        tokens: 50,
        cost: 0.005,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      assertTerminated(result);
      // Will terminate via text-only or similarity detection
      expect(result.reason).toMatch(/consecutive (similar outputs|text-only responses)/);
    });
  });
});
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // Exploration Skip Detection Tests (NEW)
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  describe("Exploration skip detection", () => {
    it("should converge normally when exploration is skipped N times", () => {
      const state = createLoopState();
      state.explorationSkipCount = 2; // 杈惧埌闃堝€?
      state.lastContent = "Let me read the file...";
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.aborted).toBe(false);
        expect(result.reason).toContain("Exploration complete");
        expect(result.reason).not.toContain("Task may be incomplete");
        expect(result.reason).not.toContain("model attempted");
        expect(result.reason).toContain("2");
        expect(result.metadata?.explorationSkipCount).toBe(2);
        expect(result.metadata?.normalCompletion).toBe(true);
      }
    });
    it("converges on exploration-skip even while information needs are unmet", () => {
      const state = createLoopState({
        id: "step_1",
        description: "Inspect login",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 0,
      });
      state.explorationSkipCount = 5;
      state.lastContent = "Let me read the file...";
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.reason).toContain("Exploration complete");
      }
    });
    it("should not terminate before threshold", () => {
      const state = createLoopState();
      state.explorationSkipCount = 1; // 鏈揪鍒伴槇�?
      state.lastContent = "I need to read...";
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("should reset skip count on non-exploration turn", () => {
      const state = createLoopState();
      state.explorationSkipCount = 2;
      state.lastIterationHadExplorationSkip = true;
      // 妯℃�?react.ts 涓殑閲嶇疆閫昏�?
      // 鏈疆娌℃湁璺宠�?�?閲嶇疆鏍囪鍜岃鏁?
      state.lastIterationHadExplorationSkip = false;
      state.explorationSkipCount = 0;  // 馃敟 閲嶇疆璁℃暟
      // 涓嬩竴杞鏌ュ簲璇ヤ笉缁堟�?
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("should respect explorationTermination.baseSkipThreshold", () => {
      const state = createLoopState();
      state.explorationSkipCount = 3;
      const config = createTerminationConfig({
        explorationTermination: { baseSkipThreshold: 3, complexityMultipliers: { medium: 1, high: 1 } },
      });
      const result = checkTermination(state, config);
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.aborted).toBe(false);
        expect(result.reason).toContain("3");
        expect(result.metadata?.normalCompletion).toBe(true);
      }
    });
    it("should be disabled when baseSkipThreshold is 0", () => {
      const state = createLoopState();
      state.explorationSkipCount = 10;
      const config = createTerminationConfig({
        explorationTermination: { baseSkipThreshold: 0 },
      });
      const result = checkTermination(state, config);
      // baseSkipThreshold=0 琛ㄧず绂佺敤妫€�?
      expect(result.shouldTerminate).toBe(false);
    });
    it("should scale skip threshold with task complexity", () => {
      const state = createLoopState({
        id: "t1",
        description: "complex task",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 1,
        estimatedComplexity: "high",
      });
      state.explorationSkipCount = 2;
      state.lastContent = "Let me keep reading...";
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
      state.explorationSkipCount = 4;
      const converged = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(converged.shouldTerminate).toBe(true);
      if (converged.shouldTerminate) {
        expect(converged.metadata?.complexity).toBe("high");
        expect(converged.metadata?.normalCompletion).toBe(true);
      }
    });
    it("terminates on exploration-skip even while information needs remain unmet", () => {
      const state = createLoopState({
        id: "t1",
        description: "needs more evidence",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 1,
      });
      state.explorationSkipCount = 5;
      state.lastContent = "Still gathering context";
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.reason).toContain("Exploration complete");
      }
    });
    it("should NOT terminate when semantic similarity is below threshold (negative)", () => {
      const state = createLoopState({
        id: "t1",
        description: "task with low similarity",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 1,
      });
      state.explorationSkipCount = 5;
      state.lastContent = "Now I will proceed to implement the new feature based on what I learned.";
      state.previousContent = "Let me check the database schema and migration files for compatibility.";
      state.consecutiveSimilarOutputs = 0;
      const config = createTerminationConfig({
        explorationTermination: {
          enableSemanticCheck: true,
          semanticSimilarityThreshold: 0.85,
          requireProgressEvidence: false,
        },
      });
      const result = checkTermination(state, config);
      // Different content (low similarity) + semantic check enabled �?NOT stuck �?no terminate
      expect(result.shouldTerminate).toBe(false);
    });
    it("should NOT block termination when previous content is empty (defaults to stuck)", () => {
      const state = createLoopState({
        id: "t1",
        description: "task with empty previous",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 1,
      });
      state.explorationSkipCount = 5;
      state.lastContent = "Some exploration content";
      state.previousContent = "";
      state.consecutiveSimilarOutputs = 0;
      const config = createTerminationConfig({
        explorationTermination: {
          enableSemanticCheck: true,
          semanticSimilarityThreshold: 0.85,
          requireProgressEvidence: false,
        },
      });
      const result = checkTermination(state, config);
      // Empty previous �?can't compare �?defaults to "stuck" �?terminates
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.metadata?.normalCompletion).toBe(true);
      }
    });
    it("should skip semantic check when enableSemanticCheck is false", () => {
      const state = createLoopState({
        id: "t1",
        description: "task with semantic check disabled",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 1,
      });
      state.explorationSkipCount = 5;
      state.lastContent = "Completely new and different content that should not match.";
      state.previousContent = "Totally unrelated previous content for comparison.";
      state.consecutiveSimilarOutputs = 0;
      const config = createTerminationConfig({
        explorationTermination: {
          enableSemanticCheck: false,
          requireProgressEvidence: false,
        },
      });
      const result = checkTermination(state, config);
      // Semantic check disabled �?always semanticallyStuck �?terminates
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.metadata?.normalCompletion).toBe(true);
      }
    });
    it("should use threshold=3 for medium complexity (base=2 * medium=1.5)", () => {
      const state = createLoopState({
        id: "t1",
        description: "medium complexity task",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 1,
        estimatedComplexity: "medium",
      });
      state.explorationSkipCount = 2;
      state.lastContent = "Still exploring...";
      // base=2, medium=1.5 �?threshold=round(2*1.5)=3 �?skipCount=2 < 3 �?no terminate
      const result1 = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result1.shouldTerminate).toBe(false);
      state.explorationSkipCount = 3;
      const result2 = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result2.shouldTerminate).toBe(true);
      if (result2.shouldTerminate) {
        expect(result2.metadata?.complexity).toBe("medium");
        expect(result2.metadata?.normalCompletion).toBe(true);
      }
    });
    it("should deep-merge explorationTermination sub-fields", () => {
      const overrides = {
        explorationTermination: {
          baseSkipThreshold: 5,
          // Other fields should retain defaults
        },
      };
      const config = createTerminationConfig(overrides);
      // Explicit override
      expect(config.explorationTermination.baseSkipThreshold).toBe(5);
      // Default preserved (deep merge)
      expect(config.explorationTermination.enableSemanticCheck).toBe(true);
      expect(config.explorationTermination.semanticSimilarityThreshold).toBe(0.85);
      expect(config.explorationTermination.requireProgressEvidence).toBe(true);
      expect(config.explorationTermination.enableReflectionPrompt).toBe(true);
      expect(config.explorationTermination.complexityMultipliers.medium).toBe(1.5);
      expect(config.explorationTermination.complexityMultipliers.high).toBe(2.0);
    });
    it("should skip needs guard when requireProgressEvidence is false", () => {
      const state = createLoopState({
        id: "t1",
        description: "needs more evidence",
        status: "in_progress",
        dependsOn: [],retryCount: 0,
        maxRetries: 1,
      });
      state.explorationSkipCount = 5;
      state.lastContent = "Still gathering context";
      state.previousContent = "";
      state.consecutiveSimilarOutputs = 0;
      const config = createTerminationConfig({
        explorationTermination: {
          requireProgressEvidence: false,
        },
      });
      const result = checkTermination(state, config);
      // requireProgressEvidence=false �?skip needs guard �?terminate despite unmet needs
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.metadata?.normalCompletion).toBe(true);
      }
    });
  });
  describe("Action announcements are not natural completion", () => {
    it("does not terminate on a continuation-intent text-only response", () => {
      const state = createLoopState();
      updateStateAfterResponse(state, {
        content: "娈嬬暀鍧囦负鏈夋剰淇濈暀椤广€傜幇鍦ㄨ窇娴嬭瘯濂椾欢楠岃瘉琛屼负鏈牬鍧忋€?",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("does not terminate an English action announcement either", () => {
      const state = createLoopState();
      updateStateAfterResponse(state, {
        content: "Changes are in place. Now I will run the test suite to verify.",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
    it("still terminates on a report-style final response", () => {
      const state = createLoopState();
      updateStateAfterResponse(state, {
        content: "浠ヤ笂鏄湰娆′慨鏀圭殑鎬荤粨锛氬叡鏀瑰姩 3 涓枃浠讹紝娴嬭瘯鍏ㄩ儴閫氳繃銆?",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
    });
    it("does not terminate via consecutive-text-only while announcing actions", () => {
      const state = createLoopState();
      // 鎺緸浜掍笉鐩镐技锛岄伩鍏嶈Е鍙戔€滆緭鍑虹浉浼煎害鈥濆崱姝绘娴嬶紙閭ｆ槸鍙︿竴鏉″厹搴曡矾寰勶級�?
      const announcements = [
        "缂栬緫宸茬粡钀界洏銆傜幇鍦ㄨ窇涓€閬嶇被鍨嬫鏌ョ‘璁ゆ病鏈夊紩鍏ラ敊璇�?",
        "鎺ヤ笅鏉ユ妸 packages 涓嬬殑娴嬭瘯濂椾欢鍏ㄩ儴璺戜竴閬嶏紝鐪嬬湅鏄惁鏈夊洖褰掋€?",
        "鏈€鍚庡啀鏍稿涓€娆?lint 涓庢牸寮忚緭鍑猴紝椹笂寮€濮嬭窇鍐掔儫娴嬭瘯銆?",
      ];
      for (const content of announcements) {
        updateStateAfterResponse(state, {
          content,
          toolCalls: [],
          finishReason: "stop",
          tokens: 10,
          cost: 0,
        });
      }
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(false);
    });
  });
  describe("Unmet information needs no longer veto completion", () => {
    const unmetTask = {
      id: "step_1",
      description: "Fix loop termination",
      status: "in_progress" as const,
      dependsOn: [],
      retryCount: 0,
      maxRetries: 0,
    };
    it("terminates on a report-style response even when information needs are unmet", () => {
      const state = createLoopState(unmetTask);
      updateStateAfterResponse(state, {
        content: "浠ヤ笂鏄湰娆′慨鏀圭殑鎬荤粨锛氬凡�?react.ts 涓烘湭婊¤冻鍒嗘敮澧炲姞鎶ュ憡鍑哄彛涓庣画璺戦绠椼€?",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.reason).toContain("Natural completion");
      }
    });
    it("terminates on non-report text even while information needs are unmet", () => {
      const state = createLoopState(unmetTask);
      updateStateAfterResponse(state, {
        content: "I think I understand the exit path.",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0,
      });
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
      if (result.shouldTerminate) {
        expect(result.reason).toContain("Natural completion");
      }
    });
    it("terminates similar report-style outputs even when information needs are unmet", () => {
      const state = createLoopState(unmetTask);
      updateStateAfterResponse(state, {
        content: "鏈€缁堟姤鍛婏細寰幆缁堟鏉′欢宸蹭慨澶嶏紝鎶ュ憡浜у嚭鍚庝笉鍐嶇┖杞€?",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0,
      });
      updateStateAfterResponse(state, {
        content: "鏈€缁堟姤鍛婏細寰幆缁堟鏉′欢宸蹭慨澶嶏紝鎶ュ憡浜у嚭鍚庝笉鍐嶇┖杞€?",
        toolCalls: [],
        finishReason: "stop",
        tokens: 10,
        cost: 0,
      });
      expect(state.consecutiveSimilarOutputs).toBeGreaterThanOrEqual(1);
      const result = checkTermination(state, DEFAULT_TERMINATION_CONFIG);
      expect(result.shouldTerminate).toBe(true);
    });
  });

