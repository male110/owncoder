/**
 * User Memory Store
 *
 * Global (cross-project) persistent storage for user preferences / memories
 * expressed during conversations. The model can save / update / forget durable
 * preferences via the `save_memory` / `update_memory` / `forget_memory` tools,
 * and the active memories are injected into the system prompt each turn when
 * the "收集上下文" pipeline node has `injectMemories` enabled (default).
 *
 * Storage: a single JSON file at a configurable path (typically
 * `<userData>/owncoder/memories.json`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UserMemory {
  id: string;
  title: string;
  content: string;
  category: string;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
  /** "global" = cross-project; "project" = current workspace only. */
  scope?: "global" | "project";
}

export type UserMemoryInput = Omit<UserMemory, "id" | "createdAt" | "updatedAt">;

interface MemoryFileShape {
  version: 1;
  memories: UserMemory[];
}

const MAX_MEMORIES = 200;

function newMemoryId(): string {
  // Lightweight unique id without external deps.
  const rand = Math.random().toString(36).slice(2, 10);
  return `mem_${Date.now().toString(36)}_${rand}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class UserMemoryStore {
  private readonly filePath: string;
  private memories: UserMemory[] = [];
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      if (!existsSync(this.filePath)) {
        this.memories = [];
        this.loaded = true;
        return;
      }
      const raw = readFileSync(this.filePath, "utf8");
      if (!raw.trim()) {
        this.memories = [];
        this.loaded = true;
        return;
      }
      const parsed = JSON.parse(raw) as Partial<MemoryFileShape>;
      const list = Array.isArray(parsed?.memories) ? parsed.memories : [];
      this.memories = list.filter(isUserMemory);
      this.loaded = true;
    } catch {
      // Corrupted file — start empty rather than throwing.
      this.memories = [];
      this.loaded = true;
    }
  }

  list(): UserMemory[] {
    return this.memories.map((m) => ({ ...m, keywords: [...m.keywords] }));
  }

  get(id: string): UserMemory | null {
    const m = this.memories.find((x) => x.id === id);
    return m ? { ...m, keywords: [...m.keywords] } : null;
  }

  add(input: UserMemoryInput): UserMemory {
    const now = nowIso();
    const memory: UserMemory = {
      id: newMemoryId(),
      title: input.title.trim().slice(0, 120) || "Untitled memory",
      content: input.content.trim().slice(0, 2000),
      category: (input.category || "general").trim().slice(0, 60),
      keywords: (input.keywords ?? [])
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 8),
      createdAt: now,
      updatedAt: now,
    };
    this.memories = [memory, ...this.memories].slice(0, MAX_MEMORIES);
    this.persist();
    return { ...memory, keywords: [...memory.keywords] };
  }

  update(id: string, patch: Partial<UserMemoryInput>): UserMemory | null {
    const idx = this.memories.findIndex((m) => m.id === id);
    if (idx < 0) return null;
    const current = this.memories[idx]!;
    const next: UserMemory = {
      ...current,
      title: patch.title !== undefined ? patch.title.trim().slice(0, 120) || current.title : current.title,
      content: patch.content !== undefined ? patch.content.trim().slice(0, 2000) : current.content,
      category: patch.category !== undefined ? patch.category.trim().slice(0, 60) : current.category,
      keywords:
        patch.keywords !== undefined
          ? patch.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 8)
          : current.keywords,
      updatedAt: nowIso(),
    };
    this.memories[idx] = next;
    this.persist();
    return { ...next, keywords: [...next.keywords] };
  }

  remove(id: string): boolean {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => m.id !== id);
    if (this.memories.length === before) return false;
    this.persist();
    return true;
  }

  clear(): number {
    const count = this.memories.length;
    if (count === 0) return 0;
    this.memories = [];
    this.persist();
    return count;
  }

  /**
   * Format active memories into a markdown block suitable for injection
   * into the system prompt. Returns empty string when there are no memories.
   */
  formatForPrompt(maxChars = 2000, header = "User preferences (memories)"): string {
    if (this.memories.length === 0) return "";
    const lines: string[] = [`## ${header}`, ""];
    for (const m of this.memories) {
      const kw = m.keywords.length ? ` [${m.keywords.join(", ")}]` : "";
      lines.push(`- **${m.title}** (${m.category}${kw}): ${m.content}`);
    }
    let out = lines.join("\n");
    if (out.length > maxChars) {
      out = `${out.slice(0, maxChars - 1)}…`;
    }
    return out;
  }

  private persist(): void {
    try {
      const dir = dirname(this.filePath);
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const payload: MemoryFileShape = {
        version: 1,
        memories: this.memories.map((m) => ({ ...m, keywords: [...m.keywords] })),
      };
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    } catch {
      // Best-effort persistence — never throw from the hot path.
    }
  }
}

function isUserMemory(m: unknown): m is UserMemory {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    typeof o.content === "string" &&
    typeof o.category === "string" &&
    Array.isArray(o.keywords) &&
    typeof o.createdAt === "string" &&
    typeof o.updatedAt === "string"
  );
}
