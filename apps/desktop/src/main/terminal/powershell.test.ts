import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type { TerminalShellContext } from "../../shared/terminal-completion";
import { createPowerShellIntegration } from "./powershell";
import { TerminalCompletionSession } from "./session";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(process.platform !== "win32")("real powershell.exe PSReadLine integration", () => {
  it("preserves original printable/custom and multi-chord handlers", async () => {
    const integration = createPowerShellIntegration();
    const args = [...integration.args];
    const startup = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
    const prelude = `Import-Module PSReadLine; Set-PSReadLineKeyHandler -Chord q -ScriptBlock { [Microsoft.PowerShell.PSConsoleReadLine]::Insert('Q') }; Set-PSReadLineKeyHandler -Chord 'Ctrl+x,Ctrl+q' -ScriptBlock { [Microsoft.PowerShell.PSConsoleReadLine]::Insert('CUSTOM') }; Set-PSReadLineKeyHandler -Chord F2 -ScriptBlock { [Microsoft.PowerShell.PSConsoleReadLine]::Insert(([string][char]39) * 30000) }; `;
    args[args.length - 1] = Buffer.from(prelude + startup, "utf16le").toString("base64");
    const proc = pty.spawn("powershell.exe", args, { cols: 100, rows: 30, env: process.env as Record<string, string> });
    let exited = false;
    proc.onExit(() => { exited = true; });
    const session = new TerminalCompletionSession(integration, () => {}, data => proc.write(data));
    let visible = "";
    proc.onData(data => { visible += session.protocol.push(data); });
    const wait = async (line: string) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        const context = session.getContext();
        if (context?.active && context.line === line) return;
        await pause(20);
      }
      throw new Error(`Missing custom editor state ${line}; last=${JSON.stringify(session.getContext())}; visible=${JSON.stringify(visible.slice(-1000))}`);
    };
    try {
      await wait("");
      session.invalidate(); proc.write("q");
      await wait("Q");
      session.invalidate(); proc.write("\x18\x11");
      await wait("QCUSTOM");
      session.invalidate(); proc.write("\x03");
      await wait("");
      // Apostrophes expand to \\u0027 in PS 5.1 JSON. A 30k buffer must emit a
      // bounded inactive frame, never leak a truncated OSC/base64 into output.
      const revision = session.getContext()!.revision;
      const visibleBeforeLarge = visible.length;
      session.writeInput("\x1bOQ"); // F2
      const largeDeadline = Date.now() + 7000;
      while ((session.getContext()!.revision <= revision + 1 || session.getContext()!.active) && Date.now() < largeDeadline) await pause(20);
      expect(session.getContext()).toMatchObject({ active: false, line: "", cwd: "" });
      expect(visible.slice(visibleBeforeLarge)).not.toContain(integration.nonce);
      session.writeInput("\x03");
      await wait("");
      proc.write("exit\r");
      const deadline = Date.now() + 2000;
      while (!exited && Date.now() < deadline) await pause(20);
    } finally {
      if (!exited) proc.kill();
      await pause(50);
      session.dispose();
    }
  }, 20000);

  it("reports real text/editing/native Tab, safely accepts, and isolates execution/cwd/input", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "owncoder-ps-test-"));
    mkdirSync(path.join(root, "child folder"));
    mkdirSync(path.join(root, "TabFallbackDirectory"));
    const integration = createPowerShellIntegration();
    const proc = pty.spawn("powershell.exe", integration.args, {
      name: "xterm-color", cols: 140, rows: 40, cwd: root, env: process.env as Record<string, string>,
    });
    const states: TerminalShellContext[] = [];
    let exited = false;
    proc.onExit(() => { exited = true; });
    let visible = "";
    let deferChord = false;
    let deferredChord = "";
    const session = new TerminalCompletionSession(integration, state => states.push(state), data => {
      if (deferChord) deferredChord = data;
      else proc.write(data);
    });
    proc.onData(data => { visible += session.protocol.push(data); });
    const waitFor = async (predicate: (state: TerminalShellContext) => boolean, timeout = 8000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const state = session.getContext();
        if (state && predicate(state)) return state;
        await pause(20);
      }
      throw new Error(`No expected shell state. Last=${JSON.stringify(session.getContext())}\nVisible=${JSON.stringify(visible.slice(-5000))}`);
    };
    const input = (text: string) => session.writeInput(text);
    try {
      await waitFor(s => s.active && s.line === "");
      input("git switch fea");
      await waitFor(s => s.active && s.line === "git switch fea" && s.cursor === 14);
      const beforeFocus = session.getContext()!;
      input("\x1b[O");
      await pause(80);
      input("\x1b[I");
      await pause(80);
      input("\x1b[O");
      await pause(80);
      input("\x1b[I");
      await pause(80);
      expect(session.getContext()).toEqual(beforeFocus);
      expect(await session.complete(beforeFocus.revision)).not.toBeNull();
      input("\x1b[D\x7f");
      await waitFor(s => s.active && s.line === "git switch fa" && s.cursor === 12);
      input("\x03");
      await waitFor(s => s.active && s.line === "");
      input("cd TabF\t");
      await waitFor(s => s.active && s.line.includes("TabFallbackDirectory"));
      input("\x1b");
      await waitFor(s => s.active && s.line === "");
      input("cd 'child f");
      const before = await waitFor(s => s.active && s.line === "cd 'child f");
      const result = await session.complete(before.revision);
      expect(result?.items.some(item => item.label.includes("child folder"))).toBe(true);
      const item = result!.items.find(item => item.kind === "directory")!;
      expect(session.accept({ id: "test", revision: before.revision, from: result!.from, to: result!.to, insertText: item.insertText })).toBe(true);
      const accepted = await waitFor(s => s.active && s.line === `cd ${item.insertText}`);
      expect(accepted.cwd.toLowerCase()).toBe(root.toLowerCase()); // Accept did not execute.
      input("\r");
      await waitFor(s => s.active && s.line === "" && s.cwd.toLowerCase() === path.join(root, "child folder").toLowerCase());
      expect(states.some(s => !s.active)).toBe(true);
      input("Start-Sleep -Milliseconds 700\r");
      await pause(200);
      expect(session.getContext()?.active).toBe(false);
      await waitFor(s => s.active && s.line === "");
      input("$null = Read-Host 'input-test'\r");
      await pause(400);
      expect(session.getContext()?.active).toBe(false);
      input("secret-text");
      await pause(200);
      expect(session.getContext()?.active).toBe(false);
      input("\r");
      await waitFor(s => s.active && s.line === "");
      expect(visible).not.toContain(integration.nonce);
      // Shell-side validation rejects a previously dispatched edit if the buffer
      // changed before its private chord arrived, even without backend invalidation.
      input("gi");
      const raceContext = await waitFor(s => s.active && s.line === "gi");
      const raceResult = await session.complete(raceContext.revision);
      deferChord = true;
      expect(session.accept({ id: "test", revision: raceContext.revision, from: raceResult!.from, to: raceResult!.to, insertText: "git" })).toBe(true);
      proc.write("x");
      await waitFor(s => s.active && s.line === "gix");
      const raceRevision = session.getContext()!.revision;
      proc.write(deferredChord);
      await waitFor(s => s.active && s.line === "gix" && s.revision > raceRevision);
      deferChord = false;
      input("\x1b");
      await waitFor(s => s.active && s.line === "");
      // Rebinding editor handlers after startup disables integration rather than
      // reporting a stale buffer through an unobserved handler.
      const seen = states.length;
      input("Set-PSReadLineKeyHandler -Chord F2 -ScriptBlock { }\r");
      const disableDeadline = Date.now() + 3000;
      while (states.length <= seen + 2 && Date.now() < disableDeadline) await pause(20);
      await pause(100);
      expect(session.getContext()?.active).toBe(false);
      input("ignored-by-autocomplete");
      await pause(100);
      expect(session.getContext()?.active).toBe(false);
      input("\x1bexit\r");
      const exitDeadline = Date.now() + 2000;
      while (!exited && Date.now() < exitDeadline) await pause(20);
    } finally {
      if (!exited) proc.kill();
      await pause(100);
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
