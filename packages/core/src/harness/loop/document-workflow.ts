import type { DocumentMetadata, DocumentWorkflowState, DocumentType } from "./types.ts";

/**
 * Staged spec workflow (spec → design → tasks) state, rendered for prompt
 * context.
 *
 * Each phase document is written by its save_* tool, which pauses the turn
 * until the user approves it (UI spec panel). The system prompt reads this
 * block to know which phase is under review and what comes next, so it never
 * races ahead of the user's approval.
 */

/** Which save_* tool writes which phase. */
const PHASE_OF_TOOL: Record<string, DocumentType> = {
  save_spec: "spec",
  save_design: "design",
  save_tasks: "tasks",
};

export function specPhaseOfTool(toolName: string): DocumentType | undefined {
  return PHASE_OF_TOOL[toolName];
}

/** Read-only workflow block for prompt context. */
export function documentIntentContext(state: DocumentWorkflowState): string {
  const next =
    state.stage === "awaiting_spec_confirmation"
      ? "design.md (technical design — only after the user approves spec.md)"
      : state.stage === "awaiting_design_confirmation"
        ? "tasks.md (implementation task list — only after the user approves design.md)"
        : state.stage === "awaiting_tasks_confirmation"
          ? "execution (Agent mode runs the approved tasks in order)"
          : "nothing — the spec workflow is complete";

  // Show document history if available
  let historyText = "";
  if (state.documents && state.documents.length > 0) {
    const approved = state.documents.filter((d) => d.status === "approved");
    if (approved.length > 0) {
      historyText = `\nPreviously approved documents: ${approved.map(d => `${d.path} (${d.type})`).join(", ")}`;
    }
  }

  return [
    `Workflow stage: ${state.stage}`,
    `Document awaiting the user's review: ${state.documentPath}`,
    `Next stage once the user approves: ${next}`,
    historyText,
  ].filter(Boolean).join("\n");
}

/**
 * Build the workflow state update for a save_spec / save_design / save_tasks
 * tool call. Keeps previously approved documents and marks the new one as
 * pending approval.
 */
export function buildSpecWorkflowUpdate(
  document: { feature: string; path: string; phase: DocumentType },
  existing: DocumentWorkflowState | null | undefined,
): DocumentWorkflowState {
  const stage: DocumentWorkflowState["stage"] =
    document.phase === "spec"
      ? "awaiting_spec_confirmation"
      : document.phase === "design"
        ? "awaiting_design_confirmation"
        : "awaiting_tasks_confirmation";

  // Preserve previously generated documents (compat with the allDocuments list).
  const previousDocs = [...(existing?.allDocuments ?? [])];
  if (previousDocs.length === 0 && existing?.documentPath) {
    previousDocs.push(existing.documentPath);
  }
  const allDocuments = previousDocs.includes(document.path)
    ? previousDocs
    : [...previousDocs, document.path];

  let migratedDocs: DocumentMetadata[] = existing?.documents ?? [];
  if (migratedDocs.length === 0 && previousDocs.length > 0) {
    migratedDocs = previousDocs.map((path) => ({
      type: "other" as const,
      path,
      createdAt: existing?.updatedAt ?? new Date().toISOString(),
      status: "approved" as const,
    }));
  }

  const existingIndex = migratedDocs.findIndex((d) => d.path === document.path);
  let documents: DocumentMetadata[];
  if (existingIndex >= 0) {
    documents = [...migratedDocs];
    documents[existingIndex] = {
      ...documents[existingIndex]!,
      type: document.phase,
      status: "pending_approval" as const,
    };
  } else {
    const basedOn = migratedDocs.filter((d) => d.status === "approved").map((d) => d.path);
    documents = [
      ...migratedDocs,
      {
        type: document.phase,
        path: document.path,
        createdAt: new Date().toISOString(),
        status: "pending_approval" as const,
        basedOn: basedOn.length > 0 ? basedOn : undefined,
      },
    ];
  }

  return {
    stage,
    documentPath: document.path,
    updatedAt: new Date().toISOString(),
    allDocuments,
    documents,
  };
}
