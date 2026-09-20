/**
 * Shared constants for stage handlers.
 */

/**
 * Char/token estimation safety factor. The `* 4` heuristic assumes pure ASCII
 * (4 chars ≈ 1 token), but CJK + code content averages ~3 chars/token.
 * Applying 0.75 prevents over-allocating budget and exceeding the real context
 * window. Used everywhere a token→char conversion feeds into a budget cap.
 * 
 * @example
 * ```typescript
 * // Convert token budget to safe character limit
 * const safeChars = tokenBudget * 4 * CHAR_TOKEN_SAFETY; // = tokenBudget * 3
 * ```
 */
export const CHAR_TOKEN_SAFETY = 0.75;

/**
 * Clip text to a maximum length, adding ellipsis if truncated.
 * 
 * @param text - The text to clip
 * @param max - Maximum length in characters
 * @returns Clipped text with ellipsis if needed
 * 
 * @example
 * ```typescript
 * clipBlock("Hello World", 5) // "Hello…"
 * clipBlock("Hi", 10)          // "Hi"
 * ```
 */
export function clipBlock(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
