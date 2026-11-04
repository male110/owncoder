export type SemanticSearchErrorCode =
  | "embedding_not_configured"
  | "vector_index_unavailable"
  | "search_failed";

/** 区分语义检索不可用或失败与正常的零命中。 */
export class SemanticSearchError extends Error {
  constructor(
    readonly code: SemanticSearchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SemanticSearchError";
  }
}
