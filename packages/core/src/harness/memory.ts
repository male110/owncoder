/**
 * Layered Memory System
 * Implements a three-tier memory architecture for AI coding agents:
 *
 * Layer 1: Working Memory — current session context, tool results, active plan
 * Layer 2: Short-Term Memory — summarized conversation history, recent edits
 * Layer 3: Long-Term Memory — project knowledge graph, patterns, conventions
 *
 * Plus: Project Knowledge Graph for semantic code understanding
 */

// ── Types ──────────────────────────────────────────────────

export interface WorkingMemory {
  /** Current task goal */
  goal: string;
  /** Active plan steps and progress */
  activePlan: PlanMemory | null;
  /** Recently read files (path → summary) */
  recentReads: Map<string, FileMemory>;
  /** Recent tool outputs (toolName → output) */
  recentToolOutputs: Array<{ tool: string; output: string; timestamp: number }>;
  /** Current hypotheses / partial conclusions */
  hypotheses: string[];
  /** Context window budget tracking */
  contextBudget: { used: number; total: number };
}

export interface PlanMemory {
  id: string;
  goal: string;
  steps: PlanStepMemory[];
  currentStep: number;
  progress: string;
}

export interface PlanStepMemory {
  id: string;
  description: string;
  status: "pending" | "done" | "failed";
  result: string;
}

export interface FileMemory {
  path: string;
  summary: string;
  keySymbols: string[];
  lastRead: number;
  relevance: number; // 0-1
}

export interface ShortTermMemory {
  /** Conversation summaries grouped by topic */
  topicSummaries: TopicSummary[];
  /** Recent edits made in this session */
  recentEdits: EditMemory[];
  /** Decisions made and their rationale */
  decisions: DecisionMemory[];
  /** Errors encountered and resolutions */
  errorLog: ErrorMemory[];
  /** Maximum entries per category */
  maxEntries: number;
}

export interface TopicSummary {
  topic: string;
  summary: string;
  keyFiles: string[];
  timestamp: number;
  importance: number; // 0-1
}

export interface EditMemory {
  path: string;
  description: string;
  before: string; // short hash/summary
  after: string;
  timestamp: number;
}

export interface DecisionMemory {
  context: string;
  decision: string;
  rationale: string;
  timestamp: number;
}

export interface ErrorMemory {
  error: string;
  context: string;
  resolution: string;
  timestamp: number;
}

// ── Knowledge Graph ───────────────────────────────────────

export interface ProjectKnowledgeGraph {
  /** File dependency graph */
  dependencies: Map<string, FileNode>;
  /** Common patterns detected */
  patterns: CodePattern[];
  /** Project conventions */
  conventions: ProjectConvention[];
  /** Frequently modified hotspots */
  hotspots: HotspotNode[];
  /** Build/config structure */
  projectStructure: ProjectStructure;
}

export interface FileNode {
  path: string;
  imports: string[];
  importedBy: string[];
  symbols: SymbolNode[];
  category: "source" | "test" | "config" | "doc" | "other";
  complexity: number; // rough estimate
  lastModified: number;
}

export interface SymbolNode {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "variable" | "module";
  exported: boolean;
  references: string[]; // other symbols that reference this
  filePath: string;
  line: number;
}

export interface CodePattern {
  name: string;
  description: string;
  files: string[];
  frequency: number;
  example: string;
}

export interface ProjectConvention {
  category: "naming" | "structure" | "error-handling" | "testing" | "imports" | "other";
  description: string;
  confidence: number; // 0-1
  examples: string[];
}

export interface HotspotNode {
  path: string;
  changeFrequency: number;
  bugFrequency: number;
  complexity: number;
}

export interface ProjectStructure {
  framework?: string;
  buildTool?: string;
  testFramework?: string;
  packageManager?: string;
  languageBreakdown: Record<string, number>; // ext → file count
  topLevelDirs: string[];
}

// ── Memory Manager ─────────────────────────────────────────

import type { IndexClient } from "@owncoder/index";
import type { Tag } from "@owncoder/shared";

export class MemoryManager {
  working: WorkingMemory;
  shortTerm: ShortTermMemory;
  knowledge: ProjectKnowledgeGraph;
  private maxWorkingTools = 20;
  private maxWorkingReads = 50;
  private relevanceDecay = 0.9;

  constructor() {
    this.working = this.createWorkingMemory();
    this.shortTerm = this.createShortTermMemory();
    this.knowledge = this.createKnowledgeGraph();
  }

  // ── Working Memory ─────────────────────────────────────

  private createWorkingMemory(): WorkingMemory {
    return {
      goal: "",
      activePlan: null,
      recentReads: new Map(),
      recentToolOutputs: [],
      hypotheses: [],
      contextBudget: { used: 0, total: 128_000 },
    };
  }

  setGoal(goal: string): void {
    this.working.goal = goal;
  }

  setActivePlan(plan: PlanMemory): void {
    this.working.activePlan = plan;
  }

  addRead(path: string, content: string, symbols: string[]): void {
    const existing = this.working.recentReads.get(path);
    const summary = summarizeContent(content);

    this.working.recentReads.set(path, {
      path,
      summary,
      keySymbols: symbols,
      lastRead: Date.now(),
      relevance: existing ? Math.min(1, existing.relevance + 0.1) : 0.5,
    });

    // Decay older entries
    for (const [, mem] of this.working.recentReads) {
      if (mem.path !== path) {
        mem.relevance *= this.relevanceDecay;
      }
    }

    // Evict least relevant
    if (this.working.recentReads.size > this.maxWorkingReads) {
      let minKey = "";
      let minRel = Infinity;
      for (const [k, v] of this.working.recentReads) {
        if (v.relevance < minRel) {
          minRel = v.relevance;
          minKey = k;
        }
      }
      this.working.recentReads.delete(minKey);
    }
  }

  addToolOutput(tool: string, output: string): void {
    this.working.recentToolOutputs.push({
      tool,
      output: output.slice(0, 2000),
      timestamp: Date.now(),
    });
    if (this.working.recentToolOutputs.length > this.maxWorkingTools) {
      this.working.recentToolOutputs.shift();
    }
  }

  addHypothesis(h: string): void {
    if (this.working.hypotheses.length >= 5) {
      this.working.hypotheses.shift();
    }
    this.working.hypotheses.push(h);
  }

  getWorkingContext(): string {
    const parts: string[] = [];

    if (this.working.goal) {
      parts.push(`## Current Goal\n${this.working.goal}`);
    }

    if (this.working.activePlan) {
      const plan = this.working.activePlan;
      parts.push(`## Active Plan\nGoal: ${plan.goal}`);
      parts.push(`Progress: ${plan.progress}`);
      for (const step of plan.steps) {
        const icon = { pending: "⬜", done: "✅", failed: "❌" }[step.status];
        parts.push(`  ${icon} ${step.id}: ${step.description}`);
        if (step.result) parts.push(`    → ${step.result}`);
      }
    }

    if (this.working.hypotheses.length > 0) {
      parts.push(`## Current Hypotheses\n${this.working.hypotheses.map((h, i) => `${i + 1}. ${h}`).join("\n")}`);
    }

    // Recent reads (most relevant)
    const relevant = [...this.working.recentReads.values()]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 10);
    if (relevant.length > 0) {
      parts.push("## Recently Read Files");
      for (const f of relevant) {
        parts.push(`- ${f.path}: ${f.summary}`);
      }
    }

    return parts.join("\n\n");
  }

  // ── Short-Term Memory ──────────────────────────────────

  private createShortTermMemory(): ShortTermMemory {
    return {
      topicSummaries: [],
      recentEdits: [],
      decisions: [],
      errorLog: [],
      maxEntries: 50,
    };
  }

  addTopicSummary(topic: string, summary: string, files: string[]): void {
    this.shortTerm.topicSummaries.push({
      topic,
      summary,
      keyFiles: files,
      timestamp: Date.now(),
      importance: 0.5,
    });
    this.pruneShortTerm("topicSummaries");
  }

  addEdit(path: string, description: string, before: string, after: string): void {
    this.shortTerm.recentEdits.push({
      path,
      description,
      before: before.slice(0, 100),
      after: after.slice(0, 100),
      timestamp: Date.now(),
    });
    this.pruneShortTerm("recentEdits");
  }

  addDecision(context: string, decision: string, rationale: string): void {
    this.shortTerm.decisions.push({
      context,
      decision,
      rationale,
      timestamp: Date.now(),
    });
    this.pruneShortTerm("decisions");
  }

  addError(error: string, context: string, resolution: string): void {
    this.shortTerm.errorLog.push({
      error,
      context,
      resolution,
      timestamp: Date.now(),
    });
    this.pruneShortTerm("errorLog");
  }

  private pruneShortTerm(category: keyof ShortTermMemory): void {
    const arr = this.shortTerm[category] as Array<{ timestamp: number }>;
    if (arr.length > this.shortTerm.maxEntries) {
      arr.splice(0, arr.length - this.shortTerm.maxEntries);
    }
  }

  getShortTermContext(): string {
    const parts: string[] = [];

    // Recent edits
    const edits = this.shortTerm.recentEdits.slice(-10);
    if (edits.length > 0) {
      parts.push("## Recent Edits This Session");
      for (const e of edits.reverse()) {
        parts.push(`- ${e.path}: ${e.description}`);
      }
    }

    // Recent decisions
    const decisions = this.shortTerm.decisions.slice(-5);
    if (decisions.length > 0) {
      parts.push("## Key Decisions Made");
      for (const d of decisions.reverse()) {
        parts.push(`- ${d.decision} (${d.rationale.slice(0, 100)})`);
      }
    }

    // Recent errors
    const errors = this.shortTerm.errorLog.slice(-3);
    if (errors.length > 0) {
      parts.push("## Recent Errors & Resolutions");
      for (const e of errors.reverse()) {
        parts.push(`- Error: ${e.error.slice(0, 100)}`);
        parts.push(`  Resolution: ${e.resolution.slice(0, 100)}`);
      }
    }

    return parts.join("\n\n");
  }

  // ── Knowledge Graph ────────────────────────────────────

  private createKnowledgeGraph(): ProjectKnowledgeGraph {
    return {
      dependencies: new Map(),
      patterns: [],
      conventions: [],
      hotspots: [],
      projectStructure: {
        languageBreakdown: {},
        topLevelDirs: [],
      },
    };
  }

  addFileNode(node: FileNode): void {
    this.knowledge.dependencies.set(node.path, node);
    // Update reverse edges
    for (const imp of node.imports) {
      const target = this.knowledge.dependencies.get(imp);
      if (target && !target.importedBy.includes(node.path)) {
        target.importedBy.push(node.path);
      }
    }
  }

  /**
   * Populate the knowledge graph from the Rust indexer.
   * This is called at session start to build project understanding.
   */
  async populateFromIndex(index: IndexClient, _workspaceRoot: string): Promise<void> {
    try {
      const status = index.status();
      if (status.kind !== "ready" || (status.tagCount ?? 0) === 0) {
        return; // Index not ready or empty
      }

      // Build repo map to get the structured representation
      const mapText = await index.buildRepoMap({ mapTokens: 4000 });

      // Parse the map text to extract file structure
      const fileSections = this.parseRepoMap(mapText);
      for (const section of fileSections) {
        const tagMap = new Map<string, Tag[]>();
        try {
          const tags = await index.getTags(section.path);
          tagMap.set(section.path, tags);
        } catch {
          // Some files may not have tags
        }

        const symbols: SymbolNode[] = [];
        const tags = tagMap.get(section.path) ?? [];
        for (const tag of tags) {
          symbols.push({
            name: tag.name,
            kind: this.mapTagKind(tag.kind),
            exported: tag.kind.includes("export") || tag.kind === "public",
            references: [],
            filePath: tag.path,
            line: tag.line,
          });
        }

        const fileNode: FileNode = {
          path: section.path,
          imports: section.imports,
          importedBy: [],
          symbols,
          category: this.categorizeFile(section.path),
          complexity: symbols.length * 0.5,
          lastModified: Date.now(),
        };

        this.addFileNode(fileNode);
      }

      // Extract project structure from map
      this.knowledge.projectStructure = this.extractProjectStructure(mapText);
    } catch (e) {
      console.warn("[memory] populateFromIndex failed:", e);
    }
  }

  private parseRepoMap(mapText: string): Array<{ path: string; imports: string[] }> {
    const sections: Array<{ path: string; imports: string[] }> = [];
    const lines = mapText.split("\n");
    let currentPath = "";
    const currentImports: string[] = [];

    for (const line of lines) {
      // Match file paths (typically starts with path-like pattern)
      const fileMatch = line.match(/^[📄📜🔧📦]?\s*(src\/|packages\/|crates\/|lib\/|app\/|test\/|tests\/|\w+\/)?[\w.-]+\/[\w.-]+/);
      if (fileMatch) {
        if (currentPath) {
          sections.push({ path: currentPath, imports: [...currentImports] });
          currentImports.length = 0;
        }
        currentPath = fileMatch[0].trim();
      }
      // Match import patterns
      const importMatch = line.match(/import\s+.*from\s+["']([^"']+)["']/);
      if (importMatch && currentPath) {
        currentImports.push(importMatch[1]!);
      }
    }

    if (currentPath) {
      sections.push({ path: currentPath, imports: [...currentImports] });
    }

    return sections;
  }

  private mapTagKind(kind: string): SymbolNode["kind"] {
    const k = kind.toLowerCase();
    if (k.includes("function") || k.includes("method")) return "function";
    if (k.includes("class")) return "class";
    if (k.includes("interface")) return "interface";
    if (k.includes("type")) return "type";
    if (k.includes("enum")) return "enum";
    if (k.includes("variable") || k.includes("const") || k.includes("let")) return "variable";
    if (k.includes("module") || k.includes("namespace")) return "module";
    return "variable";
  }

  private categorizeFile(path: string): FileNode["category"] {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (/(test|spec)/i.test(path)) return "test";
    if (/(config|config|\.config|\.json|\.yaml|\.toml)/i.test(path) || ["json", "yaml", "toml"].includes(ext)) return "config";
    if (/(readme|docs?|\.md$)/i.test(path) || ext === "md") return "doc";
    return "source";
  }

  private extractProjectStructure(mapText: string): ProjectStructure {
    const structure: ProjectStructure = {
      languageBreakdown: {},
      topLevelDirs: [],
    };

    // Count file extensions
    const extPattern = /\.([a-zA-Z0-9]+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = extPattern.exec(mapText)) !== null) {
      const ext = match[1]!.toLowerCase();
      structure.languageBreakdown[ext] = (structure.languageBreakdown[ext] ?? 0) + 1;
    }

    // Detect framework/build tool
    if (mapText.includes("package.json")) {
      structure.packageManager = "npm/pnpm/yarn";
    }
    if (mapText.includes("Cargo.toml")) {
      structure.packageManager = "cargo";
    }
    if (mapText.includes("tsconfig.json")) {
      structure.buildTool = "TypeScript";
    }
    if (mapText.includes("vite.config")) {
      structure.buildTool = "Vite";
    }

    // Extract top-level directories
    const dirPattern = /^([a-zA-Z][\w-]+)\//gm;
    let dirMatch: RegExpExecArray | null;
    while ((dirMatch = dirPattern.exec(mapText)) !== null) {
      const dir = dirMatch[1]!;
      if (!structure.topLevelDirs.includes(dir)) {
        structure.topLevelDirs.push(dir);
      }
    }

    return structure;
  }

  getDependents(path: string): string[] {
    const node = this.knowledge.dependencies.get(path);
    return node?.importedBy ?? [];
  }

  getDependencies(path: string): string[] {
    const node = this.knowledge.dependencies.get(path);
    return node?.imports ?? [];
  }

  addPattern(pattern: CodePattern): void {
    const existing = this.knowledge.patterns.find((p) => p.name === pattern.name);
    if (existing) {
      existing.frequency += 1;
      existing.files = [...new Set([...existing.files, ...pattern.files])];
    } else {
      this.knowledge.patterns.push(pattern);
    }
  }

  addConvention(convention: ProjectConvention): void {
    const existing = this.knowledge.conventions.find(
      (c) => c.category === convention.category && c.description === convention.description,
    );
    if (existing) {
      existing.confidence = Math.min(1, existing.confidence + 0.1);
    } else {
      this.knowledge.conventions.push(convention);
    }
  }

  updateHotspot(path: string, changed: boolean, hasBug: boolean): void {
    let hotspot = this.knowledge.hotspots.find((h) => h.path === path);
    if (!hotspot) {
      hotspot = { path, changeFrequency: 0, bugFrequency: 0, complexity: 0 };
      this.knowledge.hotspots.push(hotspot);
    }
    if (changed) hotspot.changeFrequency += 1;
    if (hasBug) hotspot.bugFrequency += 1;
  }

  getRelevantFiles(query: string, maxResults = 10): FileNode[] {
    const queryLower = query.toLowerCase();
    const scored = [...this.knowledge.dependencies.values()]
      .map((node) => {
        let score = 0;
        if (node.path.toLowerCase().includes(queryLower)) score += 10;
        for (const sym of node.symbols) {
          if (sym.name.toLowerCase().includes(queryLower)) score += 5;
        }
        // Boost hotspots
        const hotspot = this.knowledge.hotspots.find((h) => h.path === node.path);
        if (hotspot) score += hotspot.changeFrequency * 0.5;
        return { node, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
    return scored.map(({ node }) => node);
  }

  getKnowledgeContext(query?: string): string {
    const parts: string[] = [];

    // Structure
    const ps = this.knowledge.projectStructure;
    if (ps.framework || ps.buildTool) {
      parts.push(`Framework: ${ps.framework ?? "unknown"} | Build: ${ps.buildTool ?? "unknown"} | Test: ${ps.testFramework ?? "unknown"}`);
    }

    // Conventions
    const highConfConventions = this.knowledge.conventions.filter((c) => c.confidence >= 0.5);
    if (highConfConventions.length > 0) {
      parts.push("### Project Conventions");
      for (const c of highConfConventions.slice(0, 10)) {
        parts.push(`- [${c.category}] ${c.description} (confidence: ${(c.confidence * 100).toFixed(0)}%)`);
      }
    }

    // Patterns
    const topPatterns = this.knowledge.patterns
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5);
    if (topPatterns.length > 0) {
      parts.push("### Common Patterns");
      for (const p of topPatterns) {
        parts.push(`- ${p.name} (used ${p.frequency}x): ${p.description}`);
      }
    }

    // Hotspots
    const topHotspots = this.knowledge.hotspots
      .sort((a, b) => b.changeFrequency - a.changeFrequency)
      .slice(0, 5);
    if (topHotspots.length > 0) {
      parts.push("### Change Hotspots");
      for (const h of topHotspots) {
        parts.push(`- ${h.path} (${h.changeFrequency} changes, ${h.bugFrequency} bugs)`);
      }
    }

    // Relevant files if query provided
    if (query) {
      const relevant = this.getRelevantFiles(query, 5);
      if (relevant.length > 0) {
        parts.push("### Relevant Files");
        for (const f of relevant) {
          const syms = f.symbols.slice(0, 5).map((s) => s.name).join(", ");
          parts.push(`- ${f.path}${syms ? ` [${syms}]` : ""}`);
        }
      }
    }

    // 没有任何子段时返回空串——避免产生只剩 `## Project Knowledge` 标题的空块。
    if (parts.length === 0) return "";
    return ["## Project Knowledge", ...parts].join("\n\n");
  }

  // ── Persistence ─────────────────────────────────────────

  serialize(): MemoryState {
    return {
      working: {
        ...this.working,
        recentReads: [...this.working.recentReads.entries()],
      },
      shortTerm: this.shortTerm,
      knowledge: {
        ...this.knowledge,
        dependencies: [...this.knowledge.dependencies.entries()],
      },
    };
  }

  static deserialize(state: MemoryState): MemoryManager {
    const mm = new MemoryManager();
    mm.working = {
      ...state.working,
      recentReads: new Map(state.working.recentReads),
    };
    mm.shortTerm = state.shortTerm;
    mm.knowledge = {
      ...state.knowledge,
      dependencies: new Map(state.knowledge.dependencies),
    };
    return mm;
  }

  /** Reset working memory for a new turn while keeping knowledge */
  resetWorking(): void {
    const kg = this.knowledge;
    const st = this.shortTerm;
    this.working = this.createWorkingMemory();
    this.knowledge = kg;
    this.shortTerm = st;
  }
}

// ── Serialization ─────────────────────────────────────────

export interface MemoryState {
  working: Omit<WorkingMemory, "recentReads"> & { recentReads: Array<[string, FileMemory]> };
  shortTerm: ShortTermMemory;
  knowledge: Omit<ProjectKnowledgeGraph, "dependencies"> & { dependencies: Array<[string, FileNode]> };
}

// ── Helpers ───────────────────────────────────────────────

function summarizeContent(content: string, maxLen = 120): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + "...";
}


