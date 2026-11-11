export type BudgetKind =
  | "toolCalls"
  | "nestedCalls"
  | "subagents"
  | "taskNodes"
  | "modelCalls";

export interface BudgetLimits {
  toolCalls: number;
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

/**
 * Read traffic is evidence gathering, not a cost driver, so it is not metered
 * at all: `readCalls` / `readBytes` and `chargeRead()` were removed rather than
 * set to an infinite limit, so a large investigation can never be aborted with
 * "read budget exhausted". The counters below stay finite as runaway-loop
 * guards only; they are sized well above any realistic single request.
 */
const DEFAULT_LIMITS: BudgetLimits = {
  toolCalls: 600,
  nestedCalls: 300,
  subagents: 16,
  taskNodes: 32,
  modelCalls: 300,
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
      return {
        ok: false,
        reason: `${kind} budget exhausted: used ${this.used[kind]} / limit ${this.limits[kind]}`,
      };
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
}

export function defaultBudgetLimits(): BudgetLimits {
  return { ...DEFAULT_LIMITS };
}
