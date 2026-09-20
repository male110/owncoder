import type { IndexClient, CodemapImpact, CodemapSearchHit } from "@owncoder/index";
import type { SystemWorkflowConfig } from "@owncoder/settings";
import type { AgentMode } from "@owncoder/shared";
import type { ChangeFile } from "../../changes.ts";
import type { FileSnapshot } from "../checkpoint.ts";

import type { McpManager } from "../../mcp/client.ts";
import type { TerminalEntry } from "../terminal.ts";
import type { MemoryManager } from "../memory.ts";
import type { UserMemoryStore } from "../../user-memories.ts";

/** Session pending-change surface shared with the UI Changes bar. */
export interface SessionChangesApi {
  getPendingChanges(): Promise<{
    checkpointId: string | null;
    files: ChangeFile[];
    expired?: boolean;
  }>;
  /** Undo exactly one pending file (same as UI single-file undo). */
  undoChange(path: string): Promise<void>;
}

/** A selectable option presented to the user in an ask_user prompt. */
export interface AskUserOption {
  label: string;
  value: string;
  description?: string;
}

/** Structured request for the ask_user tool: a question plus choices. */
export interface AskUserRequest {
  question: string;
  options: AskUserOption[];
  /** When true the user may type a free-text answer instead of picking an option. */
  allowFreeText?: boolean;
  /** Placeholder hint shown in the free-text input when allowFreeText is true. */
  placeholder?: string;
}

/** Narrow event sink — avoids importing loop (prevents circular dependencies). */
export type ToolEventSink = (ev: {
  type: string;
  id?: string;
  prompt?: string;
  ok?: boolean;
  summary?: string;
  [key: string]: unknown;
}) => void;

export interface ToolContext {
  workspaceRoot: string;
  mode: AgentMode;
  workflow: SystemWorkflowConfig;
  /** Owning chat session id; tags artifacts (e.g. plan files) for per-session scoping. */
  sessionId?: string;
  index: IndexClient;
  /** Current-workspace Codemap service supplied by the session. */
  codemap?: {
    search(query: string, limit?: number): Promise<CodemapSearchHit[]>;
    impact(nodeId: string, depth?: number): Promise<CodemapImpact>;
  };
  /** Paths successfully read this session (for read-before-write). */
  readSet: Set<string>;
  /** mtime of each file when it was last read (for cross-session modification detection). */
  readMtTimes?: Map<string, number>;
  maxOutputChars: number;
  /** Separate cap for bash/type_check output (default lower than maxOutputChars). */
  bashMaxChars: number;
  /** Last plan path written this turn (for approve UX). */
  lastPlanPath?: string;
  /** Mutable file snapshots for the active turn checkpoint. */
  fileSnapshots?: FileSnapshot[];
  touchedPaths?: string[];
  /** Confirm dangerous bash when settings require it. */
  confirmDangerousBash?: (command: string) => Promise<boolean>;
  /** Ask the user a question and await their answer (options or free text). */
  askUser?: (request: AskUserRequest) => Promise<string>;
  onTerminal?: (entry: TerminalEntry) => void;
  onEvent?: ToolEventSink;

  mcp?: McpManager;
  projectRules?: string | null;
  llmApiKey?: string | null;
  signal?: AbortSignal;
  /** Memory manager for knowledge graph updates */
  memory?: MemoryManager;
  /** Global user memory store (cross-project preferences). */
  memoryStore?: UserMemoryStore;
  /** Project-scoped user memory store (current workspace only). */
  projectMemoryStore?: UserMemoryStore;
  /**
   * Pending session file changes (checkpoint-backed), same source as the UI
   * Changes bar. Injected by SessionOrchestrator so tools can list/undo.
   */
  sessionChanges?: SessionChangesApi;
}

export interface ReadFileResultMetadata {
  kind: "read_file";
  /** Canonical workspace-relative path (forward slashes). */
  path: string;
  /** Actual 1-based line range returned to the model. */
  startLine: number;
  endLine: number;
  totalLines: number;
  hasMore: boolean;
  /** Offset for the next page when hasMore is true. */
  nextOffset?: number;
  /** Filesystem metadata captured when the read completed. */
  size: number;
  mtimeMs: number;
  /** Compatibility version key derived from size and mtime. */
  contentHash?: string;
  /** Optional source symbol selected by read_symbol. */
  symbol?: string;
  /** Deprecated: ranged reads are no longer character-truncated. */
  lineContentTruncated?: boolean;
  /** Evidence semantics used by task completion: source or navigation. */
  evidenceKind?: "source" | "navigation";
}

export interface ReadOutlineResultMetadata {
  kind: "read_outline";
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  hasMore: false;
  size: number;
  mtimeMs: number;
  contentHash?: string;
  outline: true;
  evidenceKind: "navigation";
}

export interface FileMutationResultMetadata {
  kind: "file_mutation";
  /** Canonical workspace-relative paths changed by the tool. */
  paths: string[];
}

export type ToolResultMetadata = ReadFileResultMetadata | ReadOutlineResultMetadata | FileMutationResultMetadata;

export interface ToolResult {
  ok: boolean;
  output: string;
  /** Structured metadata for loop control; never sent to the model directly. */
  metadata?: ToolResultMetadata;
}
