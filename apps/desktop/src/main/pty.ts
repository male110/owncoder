import { homedir } from "node:os";
import * as pty from "node-pty";
import { sendToRenderer, type RendererSink } from "./renderer-send";
import type { TerminalCompletionAcceptRequest, TerminalCompletionRequest, TerminalShellContext } from "../shared/terminal-completion";
import { createPowerShellIntegration } from "./terminal/powershell";
import { TerminalCompletionSession } from "./terminal/session";

export interface CreatePtyOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
}

interface PtySession {
  id: string;
  proc: pty.IPty;
  completion?: TerminalCompletionSession;
}

const sessions = new Map<string, PtySession>();
let seq = 0;

/** Pick a sensible interactive shell for the current platform. */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: [] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: [] };
}

/**
 * Spawn a new interactive PTY. Output is streamed to the renderer via
 * `pty:data`, and exit is reported via `pty:exit`.
 */
export function createPty(sink: RendererSink, opts: CreatePtyOptions): string {
  const { file, args } = defaultShell();
  const id = `pty-${++seq}`;
  let integration: ReturnType<typeof createPowerShellIntegration> | undefined;
  if (process.platform === "win32") {
    try { integration = createPowerShellIntegration(); } catch { /* Native terminal remains available. */ }
  }
  let proc: pty.IPty;
  try {
    proc = pty.spawn(file, integration?.args ?? args, {
      name: "xterm-color",
      cols: opts.cols && opts.cols > 0 ? opts.cols : 80,
      rows: opts.rows && opts.rows > 0 ? opts.rows : 24,
      cwd: opts.cwd || homedir(),
      env: process.env as Record<string, string>,
    });
  } catch (error) { integration?.dispose(); throw error; }
  const completion = integration ? new TerminalCompletionSession(integration,
    context => sendToRenderer(sink, "terminal:context", { id, context }), data => proc.write(data)) : undefined;

  proc.onData((data) => {
    const visible = completion ? completion.protocol.push(data) : data;
    if (visible) sendToRenderer(sink, "pty:data", { id, data: visible });
  });
  proc.onExit(({ exitCode }) => {
    const remaining = completion?.protocol.flush();
    if (remaining) sendToRenderer(sink, "pty:data", { id, data: remaining });
    completion?.dispose();
    sessions.delete(id);
    sendToRenderer(sink, "pty:exit", { id, code: exitCode });
  });

  sessions.set(id, { id, proc, completion });
  return id;
}

export function writePty(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session || typeof data !== "string" || !data) return;
  if (session.completion) session.completion.writeInput(data);
  else session.proc.write(data);
}

export function getTerminalContext(id: string): TerminalShellContext | null {
  return sessions.get(id)?.completion?.getContext() ?? null;
}

export async function completeTerminal(request: TerminalCompletionRequest) {
  if (!request || typeof request.id !== "string") return null;
  return sessions.get(request.id)?.completion?.complete(request.revision) ?? null;
}

export function acceptTerminalCompletion(request: TerminalCompletionAcceptRequest): boolean {
  if (!request || typeof request.id !== "string") return false;
  return sessions.get(request.id)?.completion?.accept(request) ?? false;
}

export function resizePty(id: string, cols: number, rows: number): void {
  if (cols <= 0 || rows <= 0) return;
  try {
    sessions.get(id)?.proc.resize(cols, rows);
  } catch {
    /* resize can throw if the pty just exited; ignore */
  }
}

export function killPty(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.completion?.dispose();
  try {
    s.proc.kill();
  } catch {
    /* already gone */
  }
}

/** Kill every live pty. Call on window close / app quit. */
export function disposeAllPty(): void {
  for (const s of sessions.values()) {
    s.completion?.dispose();
    try {
      s.proc.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
