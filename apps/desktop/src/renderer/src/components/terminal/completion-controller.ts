import type {
  TerminalCompletionAcceptRequest,
  TerminalCompletionRequest,
  TerminalCompletionResult,
  TerminalShellContext,
} from "../../../../shared/terminal-completion";

export interface CompletionMenuState {
  result: TerminalCompletionResult;
  selected: number;
}

interface CompletionApi {
  complete(request: TerminalCompletionRequest): Promise<TerminalCompletionResult | null>;
  accept(request: TerminalCompletionAcceptRequest): Promise<boolean>;
}

export type CompletionKeyAction = "next" | "previous" | "accept" | "dismiss" | null;

export function completionKeyAction(event: Pick<KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "isComposing"
>): CompletionKeyAction {
  if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key === "Tab" && event.shiftKey) return "previous";
  if (event.shiftKey) return null;
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "previous";
  if (event.key === "Tab" || event.key === "Enter") return "accept";
  if (event.key === "Escape") return "dismiss";
  return null;
}

export class TerminalCompletionController {
  private context: TerminalShellContext | null = null;
  private menu: CompletionMenuState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private disposed = false;
  private enabled = true;

  constructor(
    private readonly id: string,
    private readonly api: CompletionApi,
    private readonly onChange: (menu: CompletionMenuState | null) => void,
    private readonly delayMs = 90,
  ) {}

  update(context: TerminalShellContext): void {
    if (this.disposed || (this.context && context.revision <= this.context.revision)) return;
    this.context = context;
    this.refresh();
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.refresh();
  }

  private refresh(): void {
    this.invalidate();
    const context = this.context;
    if (!this.enabled || !context?.active || !context.line.trim() || /[\r\n]/.test(context.line)) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.query(context.revision, generation);
    }, this.delayMs);
  }

  invalidate(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.publish(null);
  }

  private async query(revision: number, generation: number): Promise<void> {
    try {
      const result = await this.api.complete({ id: this.id, revision });
      if (this.disposed || !this.enabled || generation !== this.generation || !this.context?.active ||
          this.context.revision !== revision || result?.revision !== revision) return;
      if (result.items.length > 0) this.publish({ result, selected: 0 });
    } catch {
      // Completion is optional; query failures must not interrupt the PTY.
    }
  }

  move(delta: number): boolean {
    if (!this.menu) return false;
    const count = this.menu.result.items.length;
    this.publish({ ...this.menu, selected: (this.menu.selected + delta + count) % count });
    return true;
  }

  accept(index = this.menu?.selected): boolean {
    const menu = this.menu;
    const context = this.context;
    if (!menu || index === undefined || !menu.result.items[index] || !context?.active ||
        context.revision !== menu.result.revision) return false;
    const { revision, from, to, items } = menu.result;
    this.invalidate();
    void this.api.accept({ id: this.id, revision, from, to, insertText: items[index].insertText })
      .catch(() => false);
    return true;
  }

  handleKey(event: Parameters<typeof completionKeyAction>[0]): boolean {
    if (!this.menu) return false;
    switch (completionKeyAction(event)) {
      case "next": return this.move(1);
      case "previous": return this.move(-1);
      case "accept": return this.accept();
      case "dismiss": this.invalidate(); return true;
      default: return false;
    }
  }

  private publish(menu: CompletionMenuState | null): void {
    if (this.menu === menu) return;
    this.menu = menu;
    this.onChange(menu);
  }

  dispose(): void {
    this.invalidate();
    this.disposed = true;
  }
}
