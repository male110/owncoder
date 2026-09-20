import { runReActLoop } from "./react.ts";
import type { ReActLoopArgs } from "./types.ts";

interface LoopStrategyResult {
  lastAssistant: string;
  aborted: boolean;
  /** A document deliverable was written and requires user confirmation. */
  awaitingUserConfirmation?: boolean;
  /** Control was handed back to the user via report_blocker (successful stop). */
  handoffRequested?: boolean;
  /** Defined when the strategy changes the persisted PRD/TDD workflow state. */
  documentWorkflow?: import("./types.ts").DocumentWorkflowState | null;
  /** The strategy stopped because required exploration could not proceed. */
  blocked?: boolean;
  blockedReason?: string;
  correctionCount: number;
  /** 本轮结束时的统一任务运行状态。 */
  taskRunState?: import("../../task-run.ts").TaskRunState | null;
  /** 成功门禁拒绝时为 true。 */
  successRejected?: boolean;
}

interface LoopStrategy {
  name: string;
  run(args: ReActLoopArgs): Promise<LoopStrategyResult>;
}

/** Default strategy: the existing ReAct (Reasoning + Acting) tool-calling loop. */
const ReactStrategy: LoopStrategy = {
  name: "react",
  run: (args) => runReActLoop(args),
};

const LOOP_STRATEGIES = new Map<string, LoopStrategy>([["react", ReactStrategy]]);


/** Resolve a strategy by name; falls back to ReactStrategy when unknown/missing. */
export function resolveLoopStrategy(name?: string): LoopStrategy {
  if (name) {
    const s = LOOP_STRATEGIES.get(name);
    if (s) return s;
  }
  return ReactStrategy;
}