import { homedir } from "node:os";
import * as pty from "node-pty";
import { sendToRenderer, type RendererSink } from "./renderer-send";

export interface CreatePtyOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
}

interface PtySession {
  id: string;
  proc: pty.IPty;
}

const sessions = new Map<string, PtySession>();
let seq = 0;

/** Pick a sensible interactive shell for the current platform. */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const ps = "powershell.exe";
    return { file: process.env.ComSpec && !ps ? process.env.ComSpec : ps, args: [] };
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
  const proc = pty.spawn(file, args, {
    name: "xterm-color",
    cols: opts.cols && opts.cols > 0 ? opts.cols : 80,
    rows: opts.rows && opts.rows > 0 ? opts.rows : 24,
    cwd: opts.cwd || homedir(),
    env: process.env as Record<string, string>,
  });

  proc.onData((data) => {
    sendToRenderer(sink, "pty:data", { id, data });
  });
  proc.onExit(({ exitCode }) => {
    sessions.delete(id);
    sendToRenderer(sink, "pty:exit", { id, code: exitCode });
  });

  sessions.set(id, { id, proc });
  return id;
}

export function writePty(id: string, data: string): void {
  sessions.get(id)?.proc.write(data);
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
  try {
    s.proc.kill();
  } catch {
    /* already gone */
  }
}

/** Kill every live pty. Call on window close / app quit. */
export function disposeAllPty(): void {
  for (const s of sessions.values()) {
    try {
      s.proc.kill();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
