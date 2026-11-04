export type BudgetKind =
  | "toolCalls"
  | "readCalls"
  | "readBytes"
  | "nestedCalls"
  | "subagents"
  | "taskNodes"
  | "modelCalls";

export interface BudgetLimits {
  toolCalls: number;
  readCalls: number;
  readBytes: number;
  nestedCalls: number;
  subagents: number;
  taskNodes: number;
  modelCalls: number;
}

export interface BudgetUsage extends BudgetLimits {}

export interface BudgetSnapshot {
  limits: BudgetLimits;
  used: BudgetUsage;
  remaining: BudgetUsage;
}

export interface BudgetCharge {
  ok: boolean;
  reason?: string;
}

const DEFAULT_LIMITS: BudgetLimits = {
  toolCalls: 160,
  readCalls: 48,
  readBytes: 2 * 1024 * 1024,
  nestedCalls: 80,
  subagents: 4,
  taskNodes: 8,
  modelCalls: 80,
};

/**
 * Request-scoped, monotonic budget ledger. Child loops share the same usage
 * counters, so task retries and nested scripts cannot reset the parent budget.
 */
export class BudgetLedger {
  readonly limits: BudgetLimits;
  private readonly used: BudgetUsage;

  constructor(limits: Partial<BudgetLimits> = {}, sharedUsed?: BudgetUsage) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.used = sharedUsed ?? {
      toolCalls: 0,
      readCalls: 0,
      readBytes: 0,
      nestedCalls: 0,
      subagents: 0,
      taskNodes: 0,
      modelCalls: 0,
    };
  }

  child(limits: Partial<BudgetLimits> = {}): BudgetLedger {
    const childLimits = Object.fromEntries(
      (Object.keys(this.limits) as BudgetKind[]).map((kind) => [
        kind,
        Math.min(this.remaining(kind), limits[kind] ?? this.remaining(kind)),
      ]),
    ) as Partial<BudgetLimits>;
    return new BudgetLedger(childLimits, this.used);
  }

  usedValue(kind: BudgetKind): number {
    return this.used[kind];
  }

  remaining(kind: BudgetKind): number {
    return Math.max(0, this.limits[kind] - this.used[kind]);
  }

  snapshot(): BudgetSnapshot {
    const used = { ...this.used };
    const remaining = Object.fromEntries(
      (Object.keys(this.limits) as BudgetKind[]).map((kind) => [kind, this.remaining(kind)]),
    ) as unknown as BudgetUsage;
    return { limits: { ...this.limits }, used, remaining };
  }

  charge(kind: BudgetKind, amount = 1): BudgetCharge {
    if (!Number.isFinite(amount) || amount < 0) return { ok: false, reason: "invalid budget amount" };
    if (this.remaining(kind) < amount) {
      return { ok: false, reason: `budget exhausted: ${kind} (${this.limits[kind]})` };
    }
    this.used[kind] += amount;
    return { ok: true };
  }

  chargeTool(name: string, nested = false): BudgetCharge {
    const tool = this.charge("toolCalls");
    if (!tool.ok) return tool;
    if (nested) {
      const nestedCharge = this.charge("nestedCalls");
      if (!nestedCharge.ok) {
        this.used.toolCalls = Math.max(0, this.used.toolCalls - 1);
        return nestedCharge;
      }
    }
    void name;
    return { ok: true };
  }

  chargeRead(outputBytes: number): BudgetCharge {
    const calls = this.charge("readCalls");
    if (!calls.ok) return calls;
    const bytes = Math.max(0, Math.ceil(outputBytes));
    const byteCharge = this.charge("readBytes", bytes);
    if (!byteCharge.ok) {
      this.used.readCalls = Math.max(0, this.used.readCalls - 1);
      return byteCharge;
    }
    return { ok: true };
  }
}

export function defaultBudgetLimits(): BudgetLimits {
  return { ...DEFAULT_LIMITS };
}
