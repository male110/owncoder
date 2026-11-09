const READERS = new Set(["readFileSync", "readdirSync"]);

function maskCode(code: string): string {
  return code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (text) => text.replace(/[^\n]/g, " "));
}

function matchBracket(code: string, start: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = start; i < code.length; i++) {
    const ch = code[i]!;
    if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

function splitArgs(code: string, start: number, end: number): string[] {
  const masked = maskCode(code);
  const args: string[] = [];
  let from = start;
  for (let i = start; i < end; i++) {
    if ("([{".includes(masked[i]!)) {
      const close = matchBracket(masked, i);
      if (close < 0) return [];
      i = close;
    } else if (masked[i] === ",") {
      args.push(code.slice(from, i).trim());
      from = i + 1;
    }
  }
  const last = code.slice(from, end).trim();
  if (last) args.push(last);
  return args;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(code: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  }
  return code;
}

interface FnRegion {
  start: number;
  bodyStart: number;
  end: number;
  isAsync: boolean;
  name?: string;
}

function functionRegions(code: string): FnRegion[] {
  const masked = maskCode(code);
  const regions: FnRegion[] = [];
  for (const m of masked.matchAll(/\bfunction\s*(?:([\w$]+)\s*)?\(/g)) {
    const open = m.index! + m[0].lastIndexOf("(");
    const close = matchBracket(masked, open);
    const bodyStart = close + 1 + (masked.slice(close + 1).match(/^\s*/)?.[0].length ?? 0);
    if (close < 0 || masked[bodyStart] !== "{") continue;
    const end = matchBracket(masked, bodyStart);
    if (end < 0) continue;
    const before = masked.slice(0, m.index);
    const assigned = before.match(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?$/);
    regions.push({
      start: m.index!, bodyStart, end,
      isAsync: /\basync\s*$/.test(before),
      name: assigned?.[1] ?? m[1],
    });
  }
  for (const m of masked.matchAll(/=>/g)) {
    const arrow = m.index!;
    let start = arrow - 1;
    while (/\s/.test(masked[start] ?? "") && start >= 0) start--;
    if (masked[start] === ")") {
      let open = start;
      while (open >= 0 && !(masked[open] === "(" && matchBracket(masked, open) === start)) open--;
      start = open;
    } else {
      while (start >= 0 && /[\w$]/.test(masked[start]!)) start--;
      start++;
    }
    if (start < 0) continue;
    const bodyStart = arrow + 2 + (masked.slice(arrow + 2).match(/^\s*/)?.[0].length ?? 0);
    let end = bodyStart;
    if (masked[bodyStart] === "{") end = matchBracket(masked, bodyStart);
    else {
      for (; end < masked.length; end++) {
        const ch = masked[end]!;
        if ("([{".includes(ch)) {
          const close = matchBracket(masked, end);
          if (close < 0) break;
          end = close;
        } else if (",;)]}".includes(ch)) break;
      }
    }
    if (end < 0) continue;
    const before = masked.slice(0, start);
    regions.push({
      start, bodyStart, end,
      isAsync: /\basync\s*$/.test(before),
      name: before.match(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?$/)?.[1],
    });
  }
  return regions;
}

function propagateAsync(code: string): string | null {
  const converted = new Set<string>();
  for (let round = 0; round <= code.length; round++) {
    const masked = maskCode(code);
    const regions = functionRegions(code);
    const edits: Edit[] = [];
    for (const m of masked.matchAll(/\bawait\b/g)) {
      const region = regions.filter((r) => r.bodyStart <= m.index! && m.index! < r.end)
        .sort((a, b) => b.bodyStart - a.bodyStart)[0];
      if (!region || region.isAsync || edits.some((e) => e.start === region.start)) continue;
      if (!region.name) return null;
      converted.add(region.name);
      edits.push({ start: region.start, end: region.start, text: "async " });
    }
    if (edits.length) {
      code = applyEdits(code, edits);
      continue;
    }
    for (const m of masked.matchAll(/(?<![\w$])([\w$]+)\s*\(/g)) {
      if (masked[m.index! - 1] === "." && masked.slice(m.index! - 3, m.index) !== "...") continue;
      if (!converted.has(m[1]!)) continue;
      const before = masked.slice(0, m.index);
      if (/\b(?:function|await)\s*$/.test(before)) continue;
      const open = m.index! + m[0].lastIndexOf("(");
      const close = matchBracket(masked, open);
      if (close < 0) return null;
      edits.push({ start: m.index!, end: m.index!, text: "(await " });
      edits.push({ start: close + 1, end: close + 1, text: ")" });
    }
    if (!edits.length) return code;
    code = applyEdits(code, edits);
  }
  return null;
}

export function rewriteFsReads(code: string): string {
  let masked = maskCode(code);
  const imports: Edit[] = [];
  for (const m of code.matchAll(/\bimport\s*\(\s*(['"])(?:node:)?fs(?:\/promises)?\1\s*\)/g)) {
    if (masked.slice(m.index, m.index! + 6) !== "import") continue;
    imports.push({ start: m.index!, end: m.index! + 6, text: "require" });
  }
  code = applyEdits(code, imports);
  masked = maskCode(code);
  const bindings = new Set<string>();
  const bare: Record<string, string> = Object.create(null);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*(?:await\s+)?require\s*\(\s*(['"])(?:node:)?fs\2\s*\)/g)) {
    if (!/^(?:const|let|var)\b/.test(masked.slice(m.index))) continue;
    if (!m[1]!.startsWith("{")) bindings.add(m[1]!);
    else {
      for (const part of m[1]!.slice(1, -1).split(",")) {
        const match = part.trim().match(/^(readFileSync|readdirSync)(?:\s*:\s*([\w$]+))?$/);
        if (match) bare[match[2] ?? match[1]!] = match[1]!;
      }
    }
  }
  const edits: Edit[] = [];
  for (const m of masked.matchAll(/(?<![\w$.])([\w$]+)(?:\s*\.\s*([\w$]+))?\s*\(/g)) {
    const reader = m[2] ? (bindings.has(m[1]!) ? m[2] : undefined) : bare[m[1]!];
    if (!reader || !READERS.has(reader)) continue;
    if (/\bfunction\s*$/.test(masked.slice(0, m.index))) continue;
    const start = m.index!;
    const open = start + m[0].lastIndexOf("(");
    const close = matchBracket(masked, open);
    if (close < 0) return code;
    const args = splitArgs(code, open + 1, close);
    if (!args.length || args.length > 2 || args[0]!.startsWith("...")) continue;
    let helper = "__readFileTool";
    if (reader === "readFileSync") {
      if (args[1] && !/^(['"])utf-?8\1$/i.test(args[1])) continue;
    } else {
      helper = "__readDirNamesTool";
      if (args[1]) {
        const option = args[1].replace(/\s/g, "");
        if (option === "{withFileTypes:true}") helper = "__readDirTool";
        else if (option !== "{withFileTypes:false}" && !/^(['"])utf-?8\1$/i.test(option)) continue;
      }
    }
    edits.push({ start, end: open + 1, text: `(await ${helper}(` });
    const comma = (() => {
      for (let i = open + 1; i < close; i++) {
        if ("([{".includes(masked[i]!)) i = matchBracket(masked, i);
        else if (masked[i] === ",") return i;
      }
      return close;
    })();
    edits.push({ start: comma, end: close + 1, text: "))" });
  }
  if (!edits.length) return code;
  return propagateAsync(applyEdits(code, edits)) ?? code;
}
