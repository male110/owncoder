
import type { DocumentWorkflowState, DocumentType } from "./types.ts";

/**
 * Staged document workflow (PRD → TDD → implementation plan) state, rendered for
 * prompt context.
 *
 * A dedicated intent-classifier node used to decide "confirm / query / other"
 * here and then inject a hand-written transition instruction. That node is gone.
 * The Plan system prompt now reads this block and handles the transition itself,
 * which means the decision is made with the whole conversation in view instead of
 * by a separate call that saw one label's worth of context.
 */

/** Read-only workflow block for prompt context. */
export function documentIntentContext(state: DocumentWorkflowState): string {
  const next =
    state.stage === "awaiting_prd_confirmation"
      ? "Technical Design Document (TDD)"
      : "implementation plan";
  
  // Show document history if available
  let historyText = "";
  if (state.documents && state.documents.length > 0) {
    const approved = state.documents.filter(d => d.status === "approved");
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

export function documentStageFromArtifact(path: string, content = ""): DocumentWorkflowState["stage"] | null {
  const subject = `${path}\n${content.slice(0, 3000)}`.toLowerCase();
  if (/\btdd\b|technical\s+design|技术(?:设计|文档)/i.test(subject)) {
    return "awaiting_tdd_confirmation";
  }
  if (/\bprd\b|product\s+requirements?|产品(?:需求)?(?:文档)?|需求文档/i.test(subject)) {
    return "awaiting_prd_confirmation";
  }
  return null;
}

/** Infer document type from path and content. */
export function inferDocumentType(path: string, content = ""): DocumentType {
  const subject = `${path}\n${content.slice(0, 3000)}`.toLowerCase();
  
  if (/\bprd\b|product\s+requirements?|产品(?:需求)?(?:文档)?|需求文档/i.test(subject)) {
    return "prd";
  }
  if (/\btdd\b|technical\s+design|技术(?:设计|文档)/i.test(subject)) {
    return "tdd";
  }
  if (/\bdesign\b|设计文档|design\s+doc/i.test(subject)) {
    return "design";
  }
  if (/\barchitecture\b|架构(?:设计)?|arch\s+doc/i.test(subject)) {
    return "architecture";
  }
  
  return "other";
}

