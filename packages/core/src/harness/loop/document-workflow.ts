import type { DocumentMetadata, DocumentWorkflowState, DocumentType } from "./types.ts";

/**
 * Staged Spec workflow context. Persisted stage and status names are retained.
 * Saving ends the turn for review; it does not start the next phase.
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
      ? "Requirements review: draft the technical design only when the user asks to continue. Revise the requirements if asked."
      : state.stage === "awaiting_design_confirmation"
        ? "Design review: draft tasks.md only when the user asks to continue. Revise the design if asked."
        : state.stage === "awaiting_tasks_confirmation"
          ? "Task list ready for review: start one task with 执行 or run the list with 全部执行 in its preview."
          : "The Spec document workflow is complete.";
  const previous = state.documents?.filter((doc) => doc.path !== state.documentPath).map((doc) => doc.path);

  return [
    `Current Spec document: ${state.documentPath}`,
    next,
    previous?.length ? `Previously saved documents: ${previous.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Build the workflow state update for a save_spec / save_design / save_tasks
 * tool call, preserving previous documents and recording the one just saved.
 */
export function buildSpecWorkflowUpdate(
  document: { feature: string; path: string; phase: DocumentType },
  existing: DocumentWorkflowState | null | undefined,
  sessionId: string,
): DocumentWorkflowState {
  if (existing?.sessionId !== sessionId) existing = null;
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
    sessionId,
    stage,
    documentPath: document.path,
    updatedAt: new Date().toISOString(),
    allDocuments,
    documents,
  };
}
