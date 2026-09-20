/**
 * Unified Diff Patch Application
 * 
 * Uses the battle-tested 'diff' npm library directly.
 * 
 * NOTE: Unified diff format is strict and AI often generates wrong line numbers.
 * For better reliability, use SEARCH/REPLACE format (see search-replace.ts).
 * 
 * This format is kept as an option for:
 * - Tools that generate correct diffs programmatically
 * - Cases where exact positioning is needed
 * - Compatibility with standard git diff output
 */

import { applyPatch, createPatch } from "diff";

export interface PatchResult {
  success: boolean;
  content?: string;
  error?: string;
  preview?: string;
  format?: "unified-diff" | "search-replace";
}

/**
 * Apply a unified diff patch to file content.
 * 
 * @param originalContent The original file content
 * @param diffContent The unified diff string (git diff format)
 * @returns Result with new content or error message
 * 
 * @example
 * ```typescript
 * const result = applyUnifiedDiff(original, `
 * --- a/file.py
 * +++ b/file.py
 * @@ -1,3 +1,4 @@
 * +import math
 *  from flask import Flask
 * `);
 * 
 * if (result.success) {
 *   await fs.writeFile(path, result.content);
 * }
 * ```
 */
export function applyUnifiedDiff(
  originalContent: string,
  diffContent: string,
): PatchResult {
  try {
    // Let the 'diff' library do ALL the work!
    // It handles:
    // - Parsing the diff format
    // - Finding the right lines (with fuzzy matching)
    // - Applying the changes
    // - Handling edge cases
    const result = applyPatch(originalContent, diffContent, {
      fuzzFactor: 2, // Allow some context mismatch (fuzzy matching)
    });

    // applyPatch returns false if it couldn't apply the patch
    if (result === false) {
      return {
        success: false,
        error: 
          "Unified diff failed to apply. Common causes:\n\n" +
          "1. Context lines don't match file content\n" +
          "   → The lines around your changes must match the current file\n" +
          "   → Re-read the file to get current content\n\n" +
          "2. Line numbers in @@ -x,y +a,b @@ are incorrect\n" +
          "   → The numbers must match actual line counts\n" +
          "   → If unsure, use write_file for new files or large rewrites\n\n" +
          "3. Diff format is malformed\n" +
          "   → Check that lines start with space, +, or -\n" +
          "   → Make sure hunk headers start with @@\n\n" +
          "TIP: For large files or complex changes, use write_file instead of apply_patch.",
      };
    }

    // Success! Generate a preview diff
    const preview = createPatch(
      "file",
      originalContent,
      result,
      "original",
      "modified",
    );

    return {
      success: true,
      content: result,
      preview,
      format: "unified-diff",
    };
  } catch (error) {
    return {
      success: false,
      error: `Patch application failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Generate a unified diff between two file contents.
 * Useful for creating preview diffs or generating patches programmatically.
 * 
 * @param filePath File path (used in diff headers)
 * @param originalContent Original file content
 * @param newContent New file content
 * @returns Unified diff string
 */
export function generateUnifiedDiff(
  filePath: string,
  originalContent: string,
  newContent: string,
): string {
  return createPatch(
    filePath,
    originalContent,
    newContent,
    "original",
    "modified",
  );
}
