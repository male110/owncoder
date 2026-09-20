/**
 * Observability System — Trace, Span, Token tracking
 * 
 * Provides OpenTelemetry-style tracing for agent execution:
 * - Hierarchical spans for each stage/tool call/LLM invocation
 * - Token counting and cost estimation
 * - Performance metrics
 * - Structured logging
 */

// ── Types ──────────────────────────────────────────────────

export interface TraceSpan {
  id: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  children: TraceSpan[];
}

export type SpanKind =
  | "agent_loop"
  | "stage"
  | "llm_call"
  | "tool_call"
  | "context_gather"
  | "verification"
  | "internal";

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, unknown>;
}

export type SpanStatus = "unset" | "ok" | "error";

export interface TokenUsage {
  /** Tokens sent in the prompt */
  promptTokens: number;
  /** Tokens generated in the completion */
  completionTokens: number;
  /** Total tokens */
  totalTokens: number;
  /** Estimated cost in USD */
  estimatedCost: number;
}

export interface TraceReport {
  traceId: string;
  rootSpan: TraceSpan;
  totalDuration: number;
  tokenUsage: TokenUsage;
  spans: TraceSpan[]; // flattened
  errors: Array<{ span: string; message: string }>;
  metrics: ExecutionMetrics;
}

export interface ExecutionMetrics {
  totalLLMCalls: number;
  totalToolCalls: number;
  totalTokens: number;
  totalCost: number;
  averageLLMLatency: number;
  averageToolLatency: number;
  stagesCompleted: number;
  stagesFailed: number;
  correctionsMade: number;
  parallelToolBatches: number;
}

// ── Tracer ─────────────────────────────────────────────────

let nextSpanId = 0;
let nextTraceId = 0;

export class Tracer {
  private spans: Map<string, TraceSpan> = new Map();
  private activeSpans: string[] = []; // stack of active span IDs
  private traceId: string;
  private tokenUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
  };
  private errors: Array<{ span: string; message: string }> = [];

  constructor() {
    nextTraceId += 1;
    this.traceId = `trace_${Date.now().toString(36)}_${nextTraceId}`;
  }

  /** Start a new span (child of current active span, if any) */
  startSpan(name: string, kind: SpanKind, attributes?: Record<string, unknown>): string {
    nextSpanId += 1;
    const id = `span_${nextSpanId}`;
    const parentId = this.activeSpans.length > 0
      ? this.activeSpans[this.activeSpans.length - 1]
      : undefined;

    const span: TraceSpan = {
      id,
      parentId,
      name,
      kind,
      startTime: performance.now(),
      status: "unset",
      attributes: attributes ?? {},
      events: [],
      children: [],
    };

    this.spans.set(id, span);

    if (parentId) {
      const parent = this.spans.get(parentId);
      if (parent) {
        parent.children.push(span);
      }
    }

    this.activeSpans.push(id);
    return id;
  }

  /** End a span with a status */
  endSpan(spanId: string, status: SpanStatus = "ok", attributes?: Record<string, unknown>): void {
    const span = this.spans.get(spanId);
    if (!span) return;

    span.endTime = performance.now();
    span.status = status;
    if (attributes) {
      Object.assign(span.attributes, attributes);
    }

    // Remove from active stack
    const idx = this.activeSpans.lastIndexOf(spanId);
    if (idx >= 0) {
      this.activeSpans.splice(idx, 1);
    }
  }

  /** Add an event to a span */
  addEvent(spanId: string, eventName: string, attributes?: Record<string, unknown>): void {
    const span = this.spans.get(spanId);
    if (!span) return;

    span.events.push({
      name: eventName,
      timestamp: performance.now(),
      attributes: attributes ?? {},
    });
  }

  /** Record token usage from an LLM call */
  recordTokenUsage(promptTokens: number, completionTokens: number): void {
    this.tokenUsage.promptTokens += promptTokens;
    this.tokenUsage.completionTokens += completionTokens;
    this.tokenUsage.totalTokens += promptTokens + completionTokens;

    // Estimate cost (rough heuristic: $0.002/1K tokens for input, $0.01/1K for output)
    this.tokenUsage.estimatedCost +=
      (promptTokens / 1000) * 0.002 +
      (completionTokens / 1000) * 0.01;
  }

  /** Record an error */
  recordError(spanId: string, message: string): void {
    this.errors.push({ span: spanId, message });
    const span = this.spans.get(spanId);
    if (span) {
      span.status = "error";
    }
  }

  /** Get the root span */
  getRootSpan(): TraceSpan | undefined {
    for (const span of this.spans.values()) {
      if (!span.parentId) return span;
    }
    return undefined;
  }

  /** Flatten all spans */
  flattenSpans(): TraceSpan[] {
    const result: TraceSpan[] = [];
    const root = this.getRootSpan();
    if (!root) return result;

    const walk = (span: TraceSpan) => {
      result.push(span);
      for (const child of span.children) {
        walk(child);
      }
    };
    walk(root);
    return result;
  }

  /** Generate a full trace report */
  generateReport(): TraceReport {
    const spans = this.flattenSpans();
    const root = this.getRootSpan();
    const totalDuration = root?.endTime && root?.startTime
      ? root.endTime - root.startTime
      : 0;

    const llmSpans = spans.filter((s) => s.kind === "llm_call");
    const toolSpans = spans.filter((s) => s.kind === "tool_call");
    const stageSpans = spans.filter((s) => s.kind === "stage");

    const metrics: ExecutionMetrics = {
      totalLLMCalls: llmSpans.length,
      totalToolCalls: toolSpans.length,
      totalTokens: this.tokenUsage.totalTokens,
      totalCost: this.tokenUsage.estimatedCost,
      averageLLMLatency: llmSpans.length > 0
        ? llmSpans.reduce((sum, s) => sum + (s.endTime && s.startTime ? s.endTime - s.startTime : 0), 0) / llmSpans.length
        : 0,
      averageToolLatency: toolSpans.length > 0
        ? toolSpans.reduce((sum, s) => sum + (s.endTime && s.startTime ? s.endTime - s.startTime : 0), 0) / toolSpans.length
        : 0,
      stagesCompleted: stageSpans.filter((s) => s.status === "ok").length,
      stagesFailed: stageSpans.filter((s) => s.status === "error").length,
      correctionsMade: 0,
      parallelToolBatches: 0,
    };

    return {
      traceId: this.traceId,
      rootSpan: root!,
      totalDuration,
      tokenUsage: { ...this.tokenUsage },
      spans,
      errors: [...this.errors],
      metrics,
    };
  }

  /** Format the trace as a human-readable summary */
  formatSummary(): string {
    const report = this.generateReport();
    const lines: string[] = [];

    lines.push(`## Trace Report \`${report.traceId}\``);
    lines.push(`Duration: ${(report.totalDuration / 1000).toFixed(2)}s`);
    lines.push(`Tokens: ${report.tokenUsage.totalTokens} (in: ${report.tokenUsage.promptTokens}, out: ${report.tokenUsage.completionTokens})`);
    lines.push(`Est. Cost: $${report.tokenUsage.estimatedCost.toFixed(4)}`);
    lines.push(`LLM calls: ${report.metrics.totalLLMCalls} | Tools: ${report.metrics.totalToolCalls}`);
    lines.push(`Errors: ${report.errors.length}`);
    lines.push("");

    lines.push("### Span Timeline");
    for (const span of report.spans) {
      const indent = "  ".repeat(this.getDepth(span, report.spans));
      const duration = span.endTime && span.startTime
        ? `${(span.endTime - span.startTime).toFixed(0)}ms`
        : "?";
      const icon = span.status === "error" ? "❌" : span.status === "ok" ? "✅" : "⏳";
      lines.push(`${indent}${icon} [${span.kind}] ${span.name} (${duration})`);
    }

    if (report.errors.length > 0) {
      lines.push("");
      lines.push("### Errors");
      for (const err of report.errors) {
        lines.push(`- ${err.span}: ${err.message}`);
      }
    }

    return lines.join("\n");
  }

  private getDepth(span: TraceSpan, allSpans: TraceSpan[]): number {
    let depth = 0;
    let current = span;
    while (current.parentId) {
      depth++;
      current = allSpans.find((s) => s.id === current.parentId)!;
      if (!current) break;
    }
    return depth;
  }
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: "provider" | "estimated";
}

export function normalizeUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  promptText: string,
  completionText: string,
): NormalizedUsage {
  const promptTokens = Number.isFinite(usage?.prompt_tokens)
    ? Math.max(0, Math.floor(usage!.prompt_tokens!))
    : estimateTokens(promptText);
  const completionTokens = Number.isFinite(usage?.completion_tokens)
    ? Math.max(0, Math.floor(usage!.completion_tokens!))
    : estimateTokens(completionText);
  const totalTokens = Number.isFinite(usage?.total_tokens)
    ? Math.max(0, Math.floor(usage!.total_tokens!))
    : promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    source: usage?.prompt_tokens !== undefined || usage?.completion_tokens !== undefined
      ? "provider"
      : "estimated",
  };
}


/**
 * Rough token count estimator (4 chars ≈ 1 token for English,
 * 1-2 chars ≈ 1 token for Chinese).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fff]/.test(char)) {
      tokens += 1; // CJK characters ≈ 1-2 tokens each
    } else {
      tokens += 0.25; // Latin ≈ 0.25 tokens per char
    }
  }
  return Math.ceil(tokens);
}

// ── Performance Timing ────────────────────────────────────

export class PerformanceTimer {
  private start: number;

  constructor() {
    this.start = performance.now();
  }

  elapsed(): number {
    return performance.now() - this.start;
  }

  elapsedFormatted(): string {
    const ms = this.elapsed();
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  reset(): void {
    this.start = performance.now();
  }
}

// ── Structured Event Logger ───────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

export class AgentLogger {
  private entries: LogEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      data,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.log("debug", component, message, data);
  }

  info(component: string, message: string, data?: Record<string, unknown>): void {
    this.log("info", component, message, data);
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.log("warn", component, message, data);
  }

  error(component: string, message: string, data?: Record<string, unknown>): void {
    this.log("error", component, message, data);
  }

  getEntries(level?: LogLevel): LogEntry[] {
    if (!level) return [...this.entries];
    return this.entries.filter((e) => e.level === level);
  }

  getErrors(): LogEntry[] {
    return this.getEntries("error");
  }

  getWarnings(): LogEntry[] {
    return this.getEntries("warn");
  }

  clear(): void {
    this.entries = [];
  }

  /** Export as structured JSON for external analysis */
  export(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  /** Format recent entries for display */
  formatRecent(count = 20): string {
    const recent = this.entries.slice(-count);
    return recent
      .map((e) => `[${e.timestamp.slice(11, 19)}] ${e.level.toUpperCase()} [${e.component}] ${e.message}`)
      .join("\n");
  }
}
