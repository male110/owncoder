import type { ToolContext, ToolResult } from "./types.ts";
import type { UserMemory, UserMemoryStore } from "../../user-memories.ts";
import { fail, ok, str } from "./shared.ts";

/**
 * Resolve the correct memory store based on scope.
 * "project" → projectMemoryStore; anything else → memoryStore (global).
 */
function resolveStore(ctx: ToolContext, scope: string): UserMemoryStore | null {
  if (scope === "project") return ctx.projectMemoryStore ?? null;
  return ctx.memoryStore ?? null;
}

/**
 * save_memory — persist a durable user preference expressed in conversation.
 *
 * The model should call this when the user states a long-lasting preference
 * (e.g. "reply in Chinese", "use tabs for indentation", "don't add comments").
 * Do NOT use this for ephemeral task state — only for preferences that should
 * survive across sessions and projects.
 */
export async function toolSaveMemory(
  ctx: ToolContext,
  title: string,
  content: string,
  category: string,
  keywords: string[],
  scope = "global",
): Promise<ToolResult> {
  const store = resolveStore(ctx, scope);
  if (!store) {
    return fail(scope === "project"
      ? "Project memory store is not available (no workspace open)."
      : "Global user memory store is not available.");
  }
  if (!title.trim() || !content.trim()) {
    return fail("title and content are required.");
  }
  const kw = Array.isArray(keywords) ? keywords.map((k) => str(k)) : [];
  const memory = store.add({
    title: str(title),
    content: str(content),
    category: str(category) || "general",
    keywords: kw,
  });
  return ok(
    `Saved ${scope} user memory ${memory.id} — "${memory.title}" (${memory.category}). ` +
      `It will be injected into future turns automatically.`,
  );
}

/**
 * update_memory — modify an existing memory (e.g. refine a preference).
 */
export async function toolUpdateMemory(
  ctx: ToolContext,
  id: string,
  title: string | undefined,
  content: string | undefined,
  category: string | undefined,
  keywords: string[] | undefined,
  scope = "global",
): Promise<ToolResult> {
  const store = resolveStore(ctx, scope);
  if (!store) {
    return fail(scope === "project"
      ? "Project memory store is not available (no workspace open)."
      : "Global user memory store is not available.");
  }
  if (!id) return fail("id is required.");
  if (content !== undefined && !content.trim()) {
    return fail("update_memory content must be non-empty; omit `content` to leave it unchanged.");
  }
  const patch: Record<string, unknown> = {};
  if (title !== undefined) patch.title = str(title);
  if (content !== undefined) patch.content = str(content);
  if (category !== undefined) patch.category = str(category);
  if (keywords !== undefined && Array.isArray(keywords)) {
    patch.keywords = keywords.map((k) => str(k));
  }
  const updated = store.update(id, patch as never);
  if (!updated) return fail(`No memory with id ${id}.`);
  return ok(`Updated memory ${updated.id} — "${updated.title}".`);
}

/**
 * forget_memory — remove a memory by id (e.g. user revoked a preference).
 */
export async function toolForgetMemory(ctx: ToolContext, id: string, scope = "global"): Promise<ToolResult> {
  const store = resolveStore(ctx, scope);
  if (!store) {
    return fail(scope === "project"
      ? "Project memory store is not available (no workspace open)."
      : "Global user memory store is not available.");
  }
  if (!id) return fail("id is required.");
  const removed = store.remove(id);
  if (!removed) return fail(`No memory with id ${id}.`);
  return ok(`Forgot memory ${id}.`);
}

/**
 * list_memories — return the currently active memories (ids + titles).
 * Useful when the model wants to update or forget an existing one.
 */
export async function toolListMemories(ctx: ToolContext, scope?: string): Promise<ToolResult> {
  // If a specific scope is requested, list only that store.
  if (scope === "global" || scope === "project") {
    const store = resolveStore(ctx, scope);
    if (!store) return ok(`No ${scope} memories available.`);
    const all = store.list();
    if (all.length === 0) return ok(`No active ${scope} memories.`);
    const lines = all.map(
      (m: UserMemory) => `- ${m.id} | ${m.title} (${m.category}): ${m.content}`,
    );
    return ok(`${scope} memories (${all.length}):\n${lines.join("\n")}`);
  }

  // No scope specified: list both stores.
  const parts: string[] = [];
  const globalStore = ctx.memoryStore;
  if (globalStore) {
    const all = globalStore.list();
    if (all.length > 0) {
      const lines = all.map(
        (m: UserMemory) => `- ${m.id} | ${m.title} (${m.category}): ${m.content}`,
      );
      parts.push(`[global] (${all.length}):\n${lines.join("\n")}`);
    }
  }
  const projStore = ctx.projectMemoryStore;
  if (projStore) {
    const all = projStore.list();
    if (all.length > 0) {
      const lines = all.map(
        (m: UserMemory) => `- ${m.id} | ${m.title} (${m.category}): ${m.content}`,
      );
      parts.push(`[project] (${all.length}):\n${lines.join("\n")}`);
    }
  }
  if (parts.length === 0) return ok("No active user memories.");
  return ok(`Active user memories:\n\n${parts.join("\n\n")}`);
}
