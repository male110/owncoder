/**
 * SEARCH/REPLACE Edit Format (Aider-style, hardened)
 *
 * Matching strategy mirrors Aider's `replace_most_similar_chunk`:
 *   1. Line-level exact match (with uniqueness check)
 *   2. Line-ending-equivalent match (LF/CRLF/CR treated as equal)
 *   3. Line-level leading-whitespace-flexible match (uniform indent drift)
 *   4. Line-level trailing-whitespace-flexible match (trailing spaces/tabs)
 *   5. FAIL — never silently apply a character-level fuzzy replacement.
 *
 * Character-level Levenshtein "fuzzy" matching was intentionally removed: it
 * could match a SEARCH block against a structurally similar but WRONG location
 * (e.g. a sibling method body), corrupting the file. Aider disables the same
 * path — `replace_closest_edit_distance` is dead code after an early `return`
 * in `replace_most_similar_chunk`. We follow that precedent: a clean failure
 * with a "Did you mean?" hint is safer than a dangerous guess.
 *
 * Marker parsing is line-based (regex on whole lines), so a `=======` that
 * appears inside SEARCH/REPLACE content is no longer mistaken for a divider.
 *
 * Reference: https://aider.chat/docs/more/edit-formats.html
 */

export interface SearchReplaceResult {
  success: boolean;
  content?: string;
  error?: string;
  replacements?: number;
}

interface SearchReplaceBlock {
  search: string;
  replace: string;
}

interface TextMatch {
  start: number;
  end: number;
}

/**
 * Detailed line-by-line difference information for diagnostic purposes.
 */
interface LineDiffDetail {
  lineNumber: number;       // 1-based line number in SEARCH text
  expected: string;         // Line from SEARCH block
  actual: string | null;    // Corresponding line from file (null if not found)
  diffType: 'exact' | 'content' | 'whitespace' | 'lineEnding' | 'missing';
}

interface LineDiffResult {
  matchedLines: number;      // Number of lines that matched
  totalLines: number;        // Total lines in SEARCH block
  firstMismatchLine: number | null;  // 1-based line number of first mismatch
  details: LineDiffDetail[];
  suggestedPattern?: string; // Detected common pattern (e.g., "indent-offset")
}

// --- marker patterns (line-level; a divider must occupy its own line) ---
const HEAD_RE = /^<{5,9}\s*SEARCH\s*$/i;
const DIVIDER_RE = /^={5,9}\s*$/;
const UPDATED_RE = /^>{5,9}\s*REPLACE\s*$/i;

/**
 * Split text into lines, keeping each line's line ending. Mirrors Python's
 * str.splitlines(keepends=True). Empty string yields no lines.
 */
function splitLinesKeepEnds(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== "\r" && text[j] !== "\n") j++;
    if (j < text.length) {
      if (text[j] === "\r" && text[j + 1] === "\n") j += 2;
      else j++;
    }
    lines.push(text.slice(i, j));
    i = j;
  }
  return lines;
}

/** Ensure text ends with a newline (Aider's `prep`). */
function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

/** Character offset of the start of each line (and one past the end). */
function lineStartOffsets(lines: string[]): number[] {
  const offsets = new Array<number>(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < lines.length; i++) offsets[i + 1] = offsets[i] + lines[i].length;
  return offsets;
}

/** Strip the trailing line ending from a single line. */
function stripEol(line: string): string {
  return line.replace(/\r\n|\r|\n$/, "");
}

/** Count leading whitespace of a line's body (excluding the line ending). */
function leadingWhitespaceOf(line: string): number {
  const body = stripEol(line);
  return body.length - body.trimStart().length;
}

// --- line-ending helpers (preserved from the previous implementation) ---

function lineEndingEnd(text: string, index: number): number | undefined {
  const char = text[index];
  if (char === "\r") return text[index + 1] === "\n" ? index + 2 : index + 1;
  if (char === "\n") return index + 1;
  return undefined;
}

function previousLineEnding(content: string, index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (content[i] === "\n") return content[i - 1] === "\r" ? "\r\n" : "\n";
    if (content[i] === "\r") return "\r";
  }
  return undefined;
}

function nextLineEnding(content: string, index: number): string | undefined {
  for (let i = index; i < content.length; i++) {
    if (content[i] === "\r") return content[i + 1] === "\n" ? "\r\n" : "\r";
    if (content[i] === "\n") return "\n";
  }
  return undefined;
}

function lineEndingForReplacement(content: string, match: TextMatch): string {
  const matchedEnding = content.slice(match.start, match.end).match(/\r\n|\r|\n/)?.[0];
  if (matchedEnding) return matchedEnding;
  // For a single-line SEARCH, the adjacent ending best reflects local style.
  return nextLineEnding(content, match.end) ?? previousLineEnding(content, match.start) ?? "\n";
}

// --- parsing (line-level state machine) ---

/**
 * Parse SEARCH/REPLACE blocks from patch content using a line-level scan.
 * A divider (`=======`) is only recognised on its own line, so markers that
 * appear inside SEARCH/REPLACE content are treated as literal content.
 */
function parseSearchReplaceBlocks(patch: string): SearchReplaceBlock[] {
  const lines = splitLinesKeepEnds(patch);
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    if (HEAD_RE.test(stripEol(lines[i]).trim())) {
      i++;
      const searchParts: string[] = [];
      while (i < lines.length && !DIVIDER_RE.test(stripEol(lines[i]).trim())) {
        searchParts.push(lines[i]);
        i++;
      }
      if (i >= lines.length || !DIVIDER_RE.test(stripEol(lines[i]).trim())) break;

      i++; // skip DIVIDER
      const replaceParts: string[] = [];
      while (
        i < lines.length &&
        !UPDATED_RE.test(stripEol(lines[i]).trim()) &&
        !DIVIDER_RE.test(stripEol(lines[i]).trim())
      ) {
        replaceParts.push(lines[i]);
        i++;
      }

      blocks.push({
        search: ensureTrailingNewline(searchParts.join("")),
        replace: ensureTrailingNewline(replaceParts.join("")),
      });

      if (i < lines.length && UPDATED_RE.test(stripEol(lines[i]).trim())) i++;
    } else {
      i++;
    }
  }

  return blocks;
}

// --- matching ---

/** Line-level exact matches. Returns every occurrence (for uniqueness checks). */
function findExactLineMatches(contentLines: string[], searchLines: string[]): TextMatch[] {
  const results: TextMatch[] = [];
  const n = contentLines.length;
  const m = searchLines.length;
  if (m === 0 || m > n) return results;
  const offsets = lineStartOffsets(contentLines);
  for (let i = 0; i + m <= n; i++) {
    let ok = true;
    for (let k = 0; k < m; k++) {
      if (contentLines[i + k] !== searchLines[k]) {
        ok = false;
        break;
      }
    }
    if (ok) results.push({ start: offsets[i], end: offsets[i + m] });
  }
  return results;
}

/**
 * Match treating LF/CRLF/CR as equivalent, but still line-aligned: the anchor
 * (first line of SEARCH) must begin at a line start in the file. This prevents
 * mid-line matches that would corrupt line structure.
 */
function findLineEndingEquivalentMatch(content: string, search: string): TextMatch | undefined {
  const firstLineEnding = search.search(/\r\n|\r|\n/);
  if (firstLineEnding === -1) return undefined;
  const anchor = search.slice(0, firstLineEnding);

  if (anchor) {
    let start = content.indexOf(anchor);
    while (start !== -1) {
      const atLineStart = start === 0 || content[start - 1] === "\n" || content[start - 1] === "\r";
      if (atLineStart) {
        const match = findLineEndingEquivalentMatchAt(content, search, start);
        if (match) return match;
      }
      start = content.indexOf(anchor, start + 1);
    }
  } else {
    for (let start = 0; start < content.length; start++) {
      if (lineEndingEnd(content, start) && !(content[start] === "\n" && content[start - 1] === "\r")) {
        const match = findLineEndingEquivalentMatchAt(content, search, start);
        if (match) return match;
      }
    }
  }
  return undefined;
}

function findLineEndingEquivalentMatchAt(
  content: string,
  search: string,
  start: number,
): TextMatch | undefined {
  let contentIndex = start;
  let searchIndex = 0;

  while (searchIndex < search.length) {
    const contentLineEndingEnd = lineEndingEnd(content, contentIndex);
    const searchLineEndingEnd = lineEndingEnd(search, searchIndex);

    if (contentLineEndingEnd || searchLineEndingEnd) {
      if (!contentLineEndingEnd || !searchLineEndingEnd) return undefined;
      contentIndex = contentLineEndingEnd;
      searchIndex = searchLineEndingEnd;
    } else if (content[contentIndex] === search[searchIndex]) {
      contentIndex++;
      searchIndex++;
    } else {
      return undefined;
    }
  }

  return { start, end: contentIndex };
}

interface WhitespaceFlexibleResult {
  match: TextMatch;
  replacement: string;
}

/**
 * Line-level match that tolerates a uniform leading-whitespace drift between
 * SEARCH and the file (models often mis-indent whole blocks uniformly). SEARCH
 * and REPLACE are outdented by their shared minimum indent, then REPLACE is
 * re-indented to the file's actual indent at the match. Mirrors Aider's
 * `replace_part_with_missing_leading_whitespace`.
 */
function findLeadingWhitespaceFlexibleMatch(
  content: string,
  search: string,
  replace: string,
): WhitespaceFlexibleResult | undefined {
  const contentLines = splitLinesKeepEnds(content);
  const searchLines = splitLinesKeepEnds(search);
  const replaceLines = splitLinesKeepEnds(replace);
  const m = searchLines.length;
  if (m === 0 || m > contentLines.length) return undefined;

  const searchLeads = searchLines.filter((l) => l.trim() !== "").map(leadingWhitespaceOf);
  const replaceLeads = replaceLines.filter((l) => l.trim() !== "").map(leadingWhitespaceOf);
  const allLeads = [...searchLeads, ...replaceLeads];
  if (allLeads.length === 0) return undefined;
  const minLead = Math.min(...allLeads);
  if (minLead <= 0) return undefined; // nothing to outdent uniformly

  const stripLead = (line: string): string => (line.trim() === "" ? line : line.slice(minLead));
  const strippedSearch = searchLines.map(stripLead);
  const strippedReplace = replaceLines.map(stripLead);

  const offsets = lineStartOffsets(contentLines);

  for (let i = 0; i + m <= contentLines.length; i++) {
    let ok = true;
    const addSet = new Set<number>();
    for (let k = 0; k < m; k++) {
      const cl = contentLines[i + k];
      const sl = strippedSearch[k];
      if (stripEol(cl).trimStart() !== stripEol(sl).trimStart()) {
        ok = false;
        break;
      }
      if (sl.trim() === "") continue;
      addSet.add(leadingWhitespaceOf(cl) - leadingWhitespaceOf(sl));
    }
    if (!ok || addSet.size !== 1) continue;
    const add = [...addSet][0];
    if (add < 0) continue;

    const replacement = strippedReplace
      .map((line) => {
        if (line.trim() === "") return line;
        const eol = line.match(/\r\n|\r|\n$/)?.[0] ?? "";
        const body = line.slice(0, line.length - eol.length);
        return " ".repeat(add) + body + eol;
      })
      .join("");

    return { match: { start: offsets[i], end: offsets[i + m] }, replacement };
  }
  return undefined;
}

/**
 * Line-level match that tolerates trailing whitespace on each line (spaces and
 * tabs after the last non-whitespace character). Editors, formatters and models
 * frequently add or strip trailing whitespace, which the exact and
 * line-ending-equivalent matchers reject but which is structurally harmless.
 * The anchor (first SEARCH line) still has to line up at a real line start, and
 * every line's non-whitespace body must still match exactly — only trailing
 * whitespace may differ. This mirrors the trailing-whitespace normalisation used
 * by mature edit tools and never guesses across different code.
 */
function findTrailingWhitespaceFlexibleMatch(content: string, search: string): TextMatch | undefined {
  const contentLines = splitLinesKeepEnds(content);
  const searchLines = splitLinesKeepEnds(search);
  const m = searchLines.length;
  if (m === 0 || m > contentLines.length) return undefined;

  const normalize = (line: string): string => {
    const eol = line.match(/\r\n|\r|\n$/)?.[0] ?? "";
    return stripEol(line).replace(/[ \t]+$/, "") + eol;
  };
  const normalizedSearch = searchLines.map(normalize);

  const offsets = lineStartOffsets(contentLines);

  for (let i = 0; i + m <= contentLines.length; i++) {
    let ok = true;
    for (let k = 0; k < m; k++) {
      if (normalize(contentLines[i + k]) !== normalizedSearch[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return { start: offsets[i], end: offsets[i + m] };
  }
  return undefined;
}

/** Line-level similarity ratio: 2*LCS / (len(a)+len(b)), treating lines as atoms. */
function lineRatio(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return 1;
  if (m === 0 || n === 0) return 0;
  const dp = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const cur = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = cur;
    }
  }
  return (2 * dp[n]) / (m + n);
}

/** Find the most similar actual line span, for a failure hint. Mirrors Aider. */
function findSimilarLines(search: string, content: string, threshold = 0.6): string {
  const searchLines = splitLinesKeepEnds(search).map(stripEol);
  const contentLines = splitLinesKeepEnds(content).map(stripEol);
  const m = searchLines.length;
  if (m === 0 || contentLines.length === 0) return "";

  let bestRatio = 0;
  let bestI = -1;
  for (let i = 0; i + m <= contentLines.length; i++) {
    const chunk = contentLines.slice(i, i + m);
    const ratio = lineRatio(searchLines, chunk);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestI = i;
    }
  }
  if (bestRatio < threshold || bestI < 0) return "";

  const N = 5;
  const start = Math.max(0, bestI - N);
  const end = Math.min(contentLines.length, bestI + m + N);
  return contentLines.slice(start, end).join("\n");
}

/**
 * Generate detailed line-by-line diff diagnostic for a failed SEARCH block.
 * Finds the most similar location and analyzes each line's difference.
 */
function generateLineDiff(search: string, content: string): LineDiffResult {
  const searchLines = splitLinesKeepEnds(search);
  const contentLines = splitLinesKeepEnds(content);
  const m = searchLines.length;

  if (m === 0) {
    return {
      matchedLines: 0,
      totalLines: 0,
      firstMismatchLine: null,
      details: [],
    };
  }

  // Find the most similar location (same algorithm as findSimilarLines)
  const searchLinesStripped = searchLines.map(stripEol);
  const contentLinesStripped = contentLines.map(stripEol);
  let bestRatio = 0;
  let bestI = -1;
  for (let i = 0; i + m <= contentLines.length; i++) {
    const chunk = contentLinesStripped.slice(i, i + m);
    const ratio = lineRatio(searchLinesStripped, chunk);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestI = i;
    }
  }

  const details: LineDiffDetail[] = [];
  let matchedLines = 0;
  let firstMismatchLine: number | null = null;

  if (bestI >= 0) {
    // Compare line by line at the best matching location
    for (let k = 0; k < m; k++) {
      const searchLine = searchLines[k];
      const actualLine = contentLines[bestI + k];
      const lineNumber = k + 1;

      // Check various levels of matching
      if (searchLine === actualLine) {
        details.push({
          lineNumber,
          expected: stripEol(searchLine),
          actual: stripEol(actualLine),
          diffType: 'exact',
        });
        matchedLines++;
      } else if (stripEol(searchLine) === stripEol(actualLine)) {
        details.push({
          lineNumber,
          expected: stripEol(searchLine),
          actual: stripEol(actualLine),
          diffType: 'lineEnding',
        });
        if (firstMismatchLine === null) firstMismatchLine = lineNumber;
      } else if (stripEol(searchLine).replace(/[ \t]+$/, '') === stripEol(actualLine).replace(/[ \t]+$/, '')) {
        details.push({
          lineNumber,
          expected: stripEol(searchLine),
          actual: stripEol(actualLine),
          diffType: 'whitespace',
        });
        if (firstMismatchLine === null) firstMismatchLine = lineNumber;
      } else {
        details.push({
          lineNumber,
          expected: stripEol(searchLine),
          actual: stripEol(actualLine),
          diffType: 'content',
        });
        if (firstMismatchLine === null) firstMismatchLine = lineNumber;
      }
    }
  } else {
    // No similar location found - just list the expected lines
    for (let k = 0; k < m; k++) {
      details.push({
        lineNumber: k + 1,
        expected: stripEol(searchLines[k]),
        actual: null,
        diffType: 'missing',
      });
    }
    firstMismatchLine = 1;
  }

  // Detect common patterns
  const suggestedPattern = detectDiffPattern(details);

  return {
    matchedLines,
    totalLines: m,
    firstMismatchLine,
    details,
    suggestedPattern,
  };
}

/**
 * Detect common difference patterns to provide actionable hints.
 */
function detectDiffPattern(details: LineDiffDetail[]): string | undefined {
  if (details.length === 0) return undefined;

  // Check if all non-exact lines have only whitespace differences
  const nonExact = details.filter((d) => d.diffType !== 'exact');
  if (nonExact.length === 0) return undefined;

  const allWhitespace = nonExact.every((d) => d.diffType === 'whitespace' || d.diffType === 'lineEnding');
  if (allWhitespace) {
    const hasLineEnding = nonExact.some((d) => d.diffType === 'lineEnding');
    const hasWhitespace = nonExact.some((d) => d.diffType === 'whitespace');
    if (hasLineEnding && hasWhitespace) return 'mixed-whitespace';
    if (hasLineEnding) return 'line-ending';
    if (hasWhitespace) return 'trailing-whitespace';
  }

  // Check for consistent leading whitespace offset
  const indentOffsets: number[] = [];
  for (const detail of details) {
    if (detail.diffType === 'content' && detail.actual !== null) {
      const expectedIndent = leadingWhitespaceOf(detail.expected + '\n');
      const actualIndent = leadingWhitespaceOf(detail.actual + '\n');
      if (detail.expected.trimStart() === detail.actual.trimStart()) {
        indentOffsets.push(actualIndent - expectedIndent);
      }
    }
  }

  if (indentOffsets.length > 0 && indentOffsets.every((off) => off === indentOffsets[0])) {
    const offset = indentOffsets[0];
    if (offset !== 0) return `indent-offset-${offset > 0 ? 'more' : 'less'}-${Math.abs(offset)}`;
  }

  return undefined;
}

/**
 * Format line diff result into a human-readable diagnostic message.
 */
function formatLineDiff(diff: LineDiffResult): string {
  const { matchedLines, totalLines, firstMismatchLine, details, suggestedPattern } = diff;

  let msg = '';

  if (matchedLines > 0) {
    msg += `Matched ${matchedLines} out of ${totalLines} lines.`;
    if (firstMismatchLine !== null) {
      msg += ` First mismatch at line ${firstMismatchLine}:\n\n`;
    }
  } else {
    msg += `No lines matched.\n\n`;
  }

  // Show first few mismatches
  const mismatches = details.filter((d) => d.diffType !== 'exact').slice(0, 3);
  for (const detail of mismatches) {
    msg += `Line ${detail.lineNumber}:\n`;
    msg += `  Expected: │${detail.expected}│\n`;
    if (detail.actual !== null) {
      msg += `  Actual:   │${detail.actual}│\n`;
      switch (detail.diffType) {
        case 'lineEnding':
          msg += `  Issue: Line ending differs (CRLF vs LF)\n`;
          break;
        case 'whitespace':
          msg += `  Issue: Trailing whitespace differs\n`;
          break;
        case 'content':
          const expIndent = leadingWhitespaceOf(detail.expected + '\n');
          const actIndent = leadingWhitespaceOf(detail.actual + '\n');
          if (expIndent !== actIndent) {
            msg += `  Issue: Leading whitespace (expected ${expIndent} spaces, actual ${actIndent} spaces)\n`;
          } else {
            msg += `  Issue: Content differs\n`;
          }
          break;
      }
    } else {
      msg += `  Actual:   (not found in file)\n`;
    }
    msg += '\n';
  }

  // Add pattern-specific hint
  if (suggestedPattern) {
    switch (suggestedPattern) {
      case 'line-ending':
        msg += `Pattern detected: Line endings differ (CRLF vs LF). This should be handled automatically.\n`;
        break;
      case 'trailing-whitespace':
        msg += `Pattern detected: Trailing whitespace differs. This should be handled automatically.\n`;
        break;
      case 'mixed-whitespace':
        msg += `Pattern detected: Mixed whitespace issues (line endings and trailing spaces).\n`;
        break;
      default:
        if (suggestedPattern.startsWith('indent-offset-')) {
          const match = suggestedPattern.match(/indent-offset-(more|less)-(\d+)/);
          if (match) {
            const dir = match[1] === 'more' ? 'more indented' : 'less indented';
            const amount = match[2];
            msg += `Pattern detected: All lines in file are ${dir} by ${amount} spaces.\n`;
          }
        }
    }
  }

  return msg;
}

/** Normalise the replacement's line endings to the matched region's style. */
function buildReplacement(content: string, match: TextMatch, replace: string): string {
  const lineEnding = lineEndingForReplacement(content, match);
  return replace.replace(/\r\n|\r|\n/g, lineEnding);
}

/** Apply a single SEARCH/REPLACE block to content. */
function applyBlock(
  content: string,
  block: SearchReplaceBlock,
  blockIndex: number,
): SearchReplaceResult {
  const { search, replace } = block;

  if (!search.trim()) {
    return {
      success: false,
      error: `Block #${blockIndex + 1}: SEARCH section is empty. Cannot find what to replace.`,
      replacements: 0,
    };
  }

  const contentLines = splitLinesKeepEnds(content);
  const searchLines = splitLinesKeepEnds(search);

  // 1. Line-level exact match (+ uniqueness check)
  const exacts = findExactLineMatches(contentLines, searchLines);
  if (exacts.length > 1) {
    return {
      success: false,
      error:
        `Block #${blockIndex + 1}: SEARCH text is not unique — found ${exacts.length} matches.\n\n` +
        `Add more surrounding lines to the SEARCH block so it matches exactly one location.\n\n` +
        `SEARCH text (first 200 chars):\n${search.slice(0, 200)}`,
      replacements: 0,
    };
  }
  if (exacts.length === 1) {
    const match = exacts[0];
    return {
      success: true,
      content:
        content.slice(0, match.start) +
        buildReplacement(content, match, replace) +
        content.slice(match.end),
      replacements: 1,
    };
  }

  // 2. Line-ending-equivalent match (CRLF/LF/CR)
  const eolMatch = findLineEndingEquivalentMatch(content, search);
  if (eolMatch) {
    return {
      success: true,
      content:
        content.slice(0, eolMatch.start) +
        buildReplacement(content, eolMatch, replace) +
        content.slice(eolMatch.end),
      replacements: 1,
    };
  }

  // 3. Leading-whitespace-flexible match (uniform indent drift)
  const ws = findLeadingWhitespaceFlexibleMatch(content, search, replace);
  if (ws) {
    return {
      success: true,
      content:
        content.slice(0, ws.match.start) +
        buildReplacement(content, ws.match, ws.replacement) +
        content.slice(ws.match.end),
      replacements: 1,
    };
  }

  // 4. Trailing-whitespace-flexible match (trailing spaces/tabs)
  const tw = findTrailingWhitespaceFlexibleMatch(content, search);
  if (tw) {
    return {
      success: true,
      content:
        content.slice(0, tw.start) +
        buildReplacement(content, tw, replace) +
        content.slice(tw.end),
      replacements: 1,
    };
  }

  // 5. Fail with enhanced diagnostic — do NOT fuzzy-replace.
  const lineDiff = generateLineDiff(search, content);
  const diffDiagnostic = formatLineDiff(lineDiff);
  
  let error =
    `Block #${blockIndex + 1}: Could not find SEARCH text in file.\n\n` +
    diffDiagnostic +
    `\nThis usually means:\n` +
    `1. The file content has changed since you read it\n` +
    `2. The SEARCH text has typos or doesn't match exactly\n` +
    `3. You're editing the wrong file\n\n` +
    `TIP: Use read_file first to see current content, then copy exact text for SEARCH.`;
  
  // Add similar lines suggestion (always show to help locate the intended match)
  const suggestion = findSimilarLines(search, content);
  if (suggestion) {
    error += `\n\nSimilar content found in file:\n\n${suggestion}\n`;
  }
  
  return { success: false, error, replacements: 0 };
}

/**
 * Apply SEARCH/REPLACE blocks to file content.
 *
 * Aider's "diff" edit format — more reliable than unified diff because it does
 * not require precise line numbers, and (after hardening) never applies a
 * character-level fuzzy replacement that could land in the wrong place.
 *
 * @param originalContent Original file content
 * @param patchContent Patch with SEARCH/REPLACE blocks
 * @returns Result with updated content or error
 */
export function applySearchReplace(
  originalContent: string,
  patchContent: string,
): SearchReplaceResult {
  const blocks = parseSearchReplaceBlocks(patchContent);

  if (blocks.length === 0) {
    return {
      success: false,
      error:
        "No SEARCH/REPLACE blocks found in patch.\n\n" +
        "Expected format:\n" +
        "<<<<<<< SEARCH\n" +
        "exact text to find\n" +
        "=======\n" +
        "replacement text\n" +
        ">>>>>>> REPLACE\n\n" +
        "Make sure:\n" +
        "- Markers are on their own lines\n" +
        "- SEARCH text matches file content exactly\n" +
        "- Don't include extra spaces or blank lines in markers",
      replacements: 0,
    };
  }

  let content = originalContent;
  let totalReplacements = 0;

  for (let i = 0; i < blocks.length; i++) {
    const result = applyBlock(content, blocks[i], i);
    if (!result.success) {
      return { success: false, error: result.error, replacements: totalReplacements };
    }
    content = result.content!;
    totalReplacements += result.replacements!;
  }

  return { success: true, content, replacements: totalReplacements };
}
