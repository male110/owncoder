export type RequestRouteMode =
  | "precise_single_file"
  | "simple_direct"
  | "normal"
  | "multi_task_candidate";

export interface RequestRoute {
  mode: RequestRouteMode;
  targetPaths: string[];
  startLine?: number;
  endLine?: number;
  confidence: number;
  evidence: string[];
}

const FILE_PATH_RE = /(?:^|[\s`"'(])((?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z0-9]{1,12})(?=$|[\s`"'):,])/g;
const LINE_RANGE_RE = /(?::|\bL|第\s*)(\d+)(?:\s*[-–~至]\s*(\d+))?(?:\s*行)?\b/i;
const EMBEDDED_TEXT_RE = /```[\s\S]*?```|`[^`\n]{4,}`|"[^"\n]{8,}"|“[^”\n]{8,}”/;
const BROAD_SCOPE_RE = /\b(?:all|every|multiple|across|repository-wide|cross-file|cross file|refactor|全仓|所有|全部|多个文件|跨文件|重构|审计|排查所有)\b/i;
const CHANGE_RE = /(?:改|修改|修复|实现|添加|删除|重构|fix|change|implement|add|remove|refactor|update|edit)/i;
const QUESTION_RE = /(?:为什么|如何|怎么|怎样|where|why|how|explain|what|哪里|是否)/i;

function uniquePaths(message: string): string[] {
  const paths = new Set<string>();
  for (const match of message.matchAll(FILE_PATH_RE)) {
    const path = match[1]?.replaceAll("\\", "/").replace(/^\.\//, "").trim();
    if (path) paths.add(path);
  }
  return [...paths];
}

export function routeRequest(message: string): RequestRoute {
  const text = message.trim();
  const targetPaths = uniquePaths(text);
  if (!text) {
    return { mode: "normal", targetPaths, confidence: 0, evidence: ["empty request"] };
  }

  const lineMatch = text.match(LINE_RANGE_RE);
  const hasAnchor = Boolean(lineMatch) || EMBEDDED_TEXT_RE.test(text);
  if (CHANGE_RE.test(text) && targetPaths.length === 1 && hasAnchor && !BROAD_SCOPE_RE.test(text)) {
    return {
      mode: "precise_single_file",
      targetPaths,
      startLine: lineMatch?.[1] ? Number(lineMatch[1]) : undefined,
      endLine: lineMatch?.[2] ? Number(lineMatch[2]) : lineMatch?.[1] ? Number(lineMatch[1]) : undefined,
      confidence: 0.98,
      evidence: ["one explicit file path", "line/range or replacement anchor", "no broad-scope wording"],
    };
  }

  if (BROAD_SCOPE_RE.test(text) || targetPaths.length > 1) {
    return {
      mode: "multi_task_candidate",
      targetPaths,
      confidence: targetPaths.length > 1 ? 0.9 : 0.75,
      evidence: [targetPaths.length > 1 ? "multiple file paths" : "broad-scope wording"],
    };
  }

  if (targetPaths.length === 1 && (CHANGE_RE.test(text) || QUESTION_RE.test(text))) {
    return {
      mode: "simple_direct",
      targetPaths,
      confidence: 0.82,
      evidence: ["one explicit file path"],
    };
  }

  return { mode: "normal", targetPaths, confidence: 0.5, evidence: ["insufficient deterministic location evidence"] };
}
