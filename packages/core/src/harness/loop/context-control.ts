import upath from "upath";
import { isAbsolute, relative, resolve } from "node:path";
import { platform } from "node:os";
import type { ReadFileResultMetadata } from "../tools/types.ts";

/**
 * Raw history-filtering settings carried verbatim from pipeline node params.
 * Ranges are validated at the point of use (history_compact stage).
 */
export interface HistoryFilterSettings {
  enabled?: boolean;
  minHistoryChars?: number;
  filterTemperature?: number;
}

export interface ContextControlConfig {
  /** Add navigation guidance for index-derived source references. */
  progressiveExpansion: boolean;
  /** Retain ephemeral receipts for successful current-source reads. */
  freshnessTracking: boolean;
  /** Emit content-free decision, follow-up, and compression telemetry. */
  emitTelemetry: boolean;
  /** Task-aware history filtering settings, if configured on the pipeline node. */
  historyFilter?: HistoryFilterSettings;
}

export interface IndexedContextRegistration {
  path: string;
  source: string;
  selection: "selected" | "omitted";
}

export interface FreshnessFollowUp {
  action: "fresh_read" | "invalidated" | "invalidated_all";
  /** Workspace-relative path when the invalidation/read concerns one file. */
  path?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  /** Number of tracked files affected by an all-path invalidation. */
  affectedPaths?: number;
}

interface IndexedContextRecord {
  displayPath: string;
  sources: Set<string>;
  selections: Set<IndexedContextRegistration["selection"]>;
}

interface FreshReadReceipt {
  contentHash: string;
  totalLines: number;
  ranges: Array<{ startLine: number; endLine: number }>;
}

const CASE_INSENSITIVE_PATHS = platform() === "win32";

/**
 * Resolve an optional pipeline setting without making existing persisted
 * workflows invalid.
 */
export function resolveContextControlConfig(raw: unknown): ContextControlConfig {
  const record = isRecord(raw) ? raw : {};
  return {
    progressiveExpansion: record.progressiveExpansion !== false,
    freshnessTracking: record.freshnessTracking !== false,
    emitTelemetry: record.emitTelemetry !== false,
    historyFilter: isRecord(record.historyFilter)
      ? (record.historyFilter as HistoryFilterSettings)
      : undefined,
  };
}

/**
 * Per-turn state shared by context gathering and one or more ReAct stages.
 * It intentionally stores only paths, line ranges, and in-memory file-version
 * receipts: never candidate text, raw tool output, or any telemetry payload
 * containing a content hash.
 */
export class ContextControlState {
  private readonly indexedPaths = new Map<string, IndexedContextRecord>();
  private readonly freshReceipts = new Map<string, FreshReadReceipt>();

  constructor(
    private readonly workspaceRoot: string,
    readonly config: ContextControlConfig,
  ) {}

  get telemetryEnabled(): boolean {
    return this.config.emitTelemetry;
  }

  get indexedPathCount(): number {
    return this.indexedPaths.size;
  }

  registerIndexedCandidates(entries: readonly IndexedContextRegistration[]): void {
    for (const entry of entries) {
      const key = canonicalWorkspacePath(this.workspaceRoot, entry.path);
      if (!key) continue;
      const existing = this.indexedPaths.get(key) ?? {
        displayPath: entry.path,
        sources: new Set<string>(),
        selections: new Set<IndexedContextRegistration["selection"]>(),
      };
      existing.sources.add(entry.source);
      existing.selections.add(entry.selection);
      this.indexedPaths.set(key, existing);
    }
  }

  /**
   * Accept only a successful structured source read. A line whose visible text
   * was physically truncated cannot serve as a complete freshness receipt.
   */
  recordFreshRead(metadata: ReadFileResultMetadata): FreshnessFollowUp | null {
    if (!this.config.freshnessTracking || metadata.lineContentTruncated) return null;
    const key = canonicalWorkspacePath(this.workspaceRoot, metadata.path);
    if (!key) return null;
    const indexed = this.indexedPaths.get(key);
    if (!indexed) return null;

    let receipt = this.freshReceipts.get(key);
    const version = metadata.contentHash ?? `${metadata.size}:${metadata.mtimeMs}`;
    if (!receipt || receipt.contentHash !== version) {
      receipt = {
        contentHash: version,
        totalLines: metadata.totalLines,
        ranges: [],
      };
      this.freshReceipts.set(key, receipt);
    }

    if (rangeIsCovered(receipt.ranges, metadata.startLine, metadata.endLine)) return null;
    addCoveredRange(receipt.ranges, {
      startLine: metadata.startLine,
      endLine: metadata.endLine,
    });
    receipt.totalLines = metadata.totalLines;

    return {
      action: "fresh_read",
      path: indexed.displayPath,
      startLine: metadata.startLine,
      endLine: metadata.endLine,
      totalLines: metadata.totalLines,
    };
  }

  invalidatePath(inputPath: string): FreshnessFollowUp | null {
    if (!this.config.freshnessTracking) return null;
    const key = canonicalWorkspacePath(this.workspaceRoot, inputPath);
    if (!key || !this.freshReceipts.delete(key)) return null;
    return {
      action: "invalidated",
      path: this.indexedPaths.get(key)?.displayPath ?? inputPath,
    };
  }

  invalidateAll(): FreshnessFollowUp | null {
    if (!this.config.freshnessTracking || this.freshReceipts.size === 0) return null;
    const affectedPaths = this.freshReceipts.size;
    this.freshReceipts.clear();
    return { action: "invalidated_all", affectedPaths };
  }
}

function canonicalWorkspacePath(workspaceRoot: string, inputPath: string): string | null {
  const workspace = resolve(workspaceRoot);
  const absolute = resolve(workspace, inputPath || ".");
  const rel = relative(workspace, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const normalized = upath.normalize(rel).replace(/^\.\//, "");
  return CASE_INSENSITIVE_PATHS ? normalized.toLowerCase() : normalized;
}

function rangeIsCovered(
  ranges: ReadonlyArray<{ startLine: number; endLine: number }>,
  startLine: number,
  endLine: number,
): boolean {
  return ranges.some((range) => range.startLine <= startLine && range.endLine >= endLine);
}

function addCoveredRange(
  ranges: Array<{ startLine: number; endLine: number }>,
  incoming: { startLine: number; endLine: number },
): void {
  let startLine = incoming.startLine;
  let endLine = incoming.endLine;
  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index]!;
    if (range.endLine + 1 < startLine || endLine + 1 < range.startLine) continue;
    startLine = Math.min(startLine, range.startLine);
    endLine = Math.max(endLine, range.endLine);
    ranges.splice(index, 1);
  }
  ranges.push({ startLine, endLine });
  ranges.sort((left, right) => left.startLine - right.startLine);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
