import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { TerminalCompletionAcceptRequest, TerminalCompletionResult, TerminalShellContext } from "../../shared/terminal-completion";
import { CompletionProviders, UNSAFE_SHELL_QUOTES } from "./completions";
import { ACCEPT_CHORD, type PowerShellIntegration } from "./powershell";
import { ShellProtocol, type ShellFrame } from "./protocol";

interface Provider {
  complete(context: TerminalShellContext): Promise<TerminalCompletionResult | null>;
}

export class TerminalCompletionSession {
  readonly protocol: ShellProtocol;
  private context: TerminalShellContext | null = null;
  private sequence = 0;
  private revision = 0;
  private issued: TerminalCompletionResult | null = null;
  private queryGeneration = 0;
  private disposed = false;
  private providerInFlight: Promise<TerminalCompletionResult | null> | null = null;
  private query: { revision: number; promise: Promise<TerminalCompletionResult | null> } | null = null;

  constructor(
    private readonly integration: PowerShellIntegration,
    private readonly sendContext: (context: TerminalShellContext) => void,
    private readonly write: (data: string) => void,
    private readonly provider: Provider = new CompletionProviders(),
    private readonly timeoutMs = 1000,
  ) {
    this.protocol = new ShellProtocol(integration.nonce, frame => this.update(frame));
  }

  private update(frame: ShellFrame): void {
    if (this.disposed) return;
    this.sequence = frame.sequence;
    this.issued = null;
    this.queryGeneration++;
    this.context = { revision: ++this.revision, cwd: frame.cwd, line: frame.line, cursor: frame.cursor, active: frame.active };
    this.sendContext({ ...this.context });
  }

  getContext(): TerminalShellContext | null { return this.context ? { ...this.context } : null; }

  /** Forward terminal input without treating exact focus status reports as edits. */
  writeInput(data: string): void {
    if (this.disposed || !data) return;
    // ConPTY/PowerShell enables xterm focus reporting. PSReadLine consumes these
    // reports without an editor action or fresh state frame. Mixed input is NOT
    // exempt: it can contain real edits and must await authoritative refresh.
    if (data !== "\x1b[I" && data !== "\x1b[O") this.invalidate();
    this.write(data);
  }

  /** Any editor input can change state or enter a native application. Never infer its effect. */
  invalidate(): void {
    this.issued = null;
    this.queryGeneration++;
    this.removeEdit();
    if (!this.context) return;
    this.context = { ...this.context, revision: ++this.revision, active: false };
    this.sendContext({ ...this.context });
  }

  complete(revision: number): Promise<TerminalCompletionResult | null> {
    const context = this.context;
    if (this.disposed || !context?.active || context.revision !== revision || !Number.isSafeInteger(revision)) return Promise.resolve(null);
    if (this.query?.revision === revision) return this.query.promise;
    // A deadline is not cancellation of filesystem work. Hold the single slot
    // until it truly settles; never accumulate work behind timed-out requests.
    if (this.providerInFlight) return Promise.resolve(null);
    const operation = Promise.resolve().then(() => {
      if (this.disposed || this.context?.revision !== revision || !this.context.active) return null;
      return this.provider.complete({ ...context });
    });
    this.providerInFlight = operation;
    void operation.then(() => { if (this.providerInFlight === operation) this.providerInFlight = null; },
      () => { if (this.providerInFlight === operation) this.providerInFlight = null; });
    const promise = this.runQuery(context, operation);
    this.query = { revision, promise };
    void promise.then(() => { if (this.query?.promise === promise) this.query = null; });
    return promise;
  }

  private async runQuery(context: TerminalShellContext, operation: Promise<TerminalCompletionResult | null>): Promise<TerminalCompletionResult | null> {
    const revision = context.revision;
    const generation = ++this.queryGeneration;
    this.issued = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.timeoutMs); }),
      ]);
      if (this.disposed || generation !== this.queryGeneration || this.context?.revision !== revision || !this.context.active ||
          !result || result.revision !== revision || result.from < 0 || result.to < result.from || result.to > context.line.length) return null;
      this.issued = structuredClone(result);
      return result;
    } catch { return null; }
    finally { if (timer) clearTimeout(timer); }
  }

  accept(request: TerminalCompletionAcceptRequest): boolean {
    const context = this.context;
    const issued = this.issued;
    if (this.disposed || !context?.active || !issued || request.revision !== context.revision ||
        request.revision !== issued.revision || request.from !== issued.from || request.to !== issued.to ||
        typeof request.insertText !== "string" || request.insertText.length > 32768 ||
        /[\x00-\x1f\x7f]/.test(request.insertText) || UNSAFE_SHELL_QUOTES.test(request.insertText) ||
        !issued.items.some(item => item.insertText === request.insertText)) return false;
    try {
      const edit = JSON.stringify({ nonce: this.integration.nonce, sequence: this.sequence,
        cwd: context.cwd, line: context.line, cursor: context.cursor,
        from: request.from, to: request.to, text: request.insertText });
      // Atomic publication, no commands or selected text ever travel through PTY input.
      const temporary = `${this.integration.editPath}.tmp`;
      writeFileSync(temporary, edit, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.integration.editPath);
      this.issued = null;
      this.queryGeneration++;
      this.context = { ...context, revision: ++this.revision, active: false };
      this.sendContext({ ...this.context });
      this.write(ACCEPT_CHORD);
      return true;
    } catch { this.removeEdit(); return false; }
  }

  private removeEdit(): void {
    try { rmSync(this.integration.editPath, { force: true }); } catch { /* already consumed */ }
    try { rmSync(`${this.integration.editPath}.tmp`, { force: true }); } catch { /* ignore */ }
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
    this.integration.dispose();
  }
}
