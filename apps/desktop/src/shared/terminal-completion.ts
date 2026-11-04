/** Authoritative PSReadLine state. Offsets and revisions use UTF-16 JS string units. */
export interface TerminalShellContext {
  revision: number;
  cwd: string;
  line: string;
  cursor: number;
  /** False while executing, in an interactive program, or awaiting shell confirmation. */
  active: boolean;
}

export interface TerminalCompletionItem {
  label: string;
  insertText: string;
  kind: "branch" | "directory" | "file" | "command" | "option";
  detail?: string;
}

export interface TerminalCompletionResult {
  revision: number;
  from: number;
  to: number;
  items: TerminalCompletionItem[];
}

export interface TerminalContextEvent {
  id: string;
  context: TerminalShellContext;
}

export interface TerminalCompletionRequest {
  id: string;
  revision: number;
}

/** A selected item must exactly match an item in the last issued result. */
export interface TerminalCompletionAcceptRequest extends TerminalCompletionRequest {
  from: number;
  to: number;
  insertText: string;
}
