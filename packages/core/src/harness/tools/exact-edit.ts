/**
 * 精确片段改写器 —— apply_patch 的核心编辑引擎。
 *
 * 设计概述：
 * 1. 调用方给出"待查片段"(probe) 与"写入片段"(insert)。待查片段按纯子串
 *    方式在正文中定位，不要求行对齐；所有比对都在统一为 LF 的文本上进行，
 *    写回时再恢复文件原本的换行风格，避免 CRLF 文件被悄悄改成 LF。
 * 2. 逐字查找失败后，按"定位器表"依次尝试更宽松的定位手段：弯引号拉直、
 *    读取器行号前缀剥离、可见转义还原、码点转义还原、逐行空白忽略、
 *    公共缩进对齐、首尾行夹取。全局替换(replaceAll)时禁用后三种宽松
 *    定位器——批量替换不能建立在模糊位置上。
 * 3. 每个定位器产出若干命中；只有全部命中指向同一段正文时才算定位成功，
 *    否则按多目标歧义拒绝。即便定位器给出唯一片段，该片段在文中出现
 *    多次仍须拒绝，除非显式要求全局替换。
 * 4. 宽松定位只负责"找到位置"，真正写入的内容始终取自文件原文，本模块
 *    不对正文做字符级模糊修补。
 *
 * 本模块为纯字符串输入输出，不接触文件系统；读写由调用方负责。
 */

/** 失败类别：供调用方做程序化分支（例如目标缺失时可重读文件后重试）。 */
export type PatchEditFaultKind =
  | "bad_request"
  | "nothing_to_do"
  | "missing_target"
  | "multiple_targets";

export interface PatchEditOutcome {
  ok: boolean;
  /** 改写后的完整文件内容（仅成功时存在）。 */
  text?: string;
  /** 面向模型的诊断说明（仅失败时存在）。 */
  message?: string;
  /** 失败类别（仅失败时存在）。"missing_target" 多因读取内容过期，值得
   *  重读一次；"multiple_targets" 缺少的是上下文，重读无济于事。 */
  fault?: PatchEditFaultKind;
  /** 实际替换处数（单次为 1，全局替换为 N）。 */
  replaced?: number;
  /** 命中的定位器名称，便于诊断与测试。 */
  via?: string;
}

/** 定位器标识，按从严到宽排列；命名仅用于诊断输出。 */
type LocatorKind =
  | "verbatim"
  | "smart_quotes"
  | "gutter_stripped"
  | "visible_escapes"
  | "codepoint_escapes"
  | "whitespace_insensitive"
  | "dedent_aligned"
  | "bookend_fenced";

type LocatorVerdict =
  | { outcome: "located"; span: string; via: LocatorKind; hits: number }
  | { outcome: "ambiguous"; via: LocatorKind; hits: number }
  | { outcome: "absent" };

/** 一次定位命中：value 为文件中的真实片段，at 为其字符偏移。 */
interface SpanHit {
  value: string;
  at: number;
}

interface LocatorSpec {
  kind: LocatorKind;
  /** 宽松定位器在全局替换模式下会被跳过。 */
  loose: boolean;
  gather: (text: string, probe: string) => SpanHit[];
}

/** 首尾行夹取时，中间行平均相似度不得低于该阈值。 */
const BOOKEND_MIDDLE_FLOOR = 0.8;

const OPEN_SINGLE_GLYPH = "‘";
const CLOSE_SINGLE_GLYPH = "’";
const OPEN_DOUBLE_GLYPH = "“";
const CLOSE_DOUBLE_GLYPH = "”";

// ---------------------------------------------------------------------------
// 定位入口
// ---------------------------------------------------------------------------

function locateSpan(text: string, probe: string, everywhere: boolean): LocatorVerdict {
  const direct = scanLiteral(text, probe);
  if (direct.length > 0) return adjudicate("verbatim", direct);

  for (const locator of LOCATOR_TABLE) {
    if (everywhere && locator.loose) continue;
    const hits = locator.gather(text, probe);
    if (hits.length === 0) continue;
    return adjudicate(locator.kind, hits);
  }

  return { outcome: "absent" };
}

/**
 * 定位器表：顺序即从严到宽的降级次序。逐字匹配不在此表中，它永远最先
 * 单独尝试。
 */
const LOCATOR_TABLE: LocatorSpec[] = [
  { kind: "smart_quotes", loose: false, gather: (t, p) => scanMapped(t, p, straightenQuotes) },
  { kind: "gutter_stripped", loose: false, gather: scanGutterHits },
  { kind: "visible_escapes", loose: false, gather: scanVisibleEscapeHits },
  { kind: "codepoint_escapes", loose: false, gather: scanCodepointEscapeHits },
  { kind: "whitespace_insensitive", loose: true, gather: scanBlankInsensitiveHits },
  { kind: "dedent_aligned", loose: true, gather: scanDedentHits },
  { kind: "bookend_fenced", loose: true, gather: scanBookendHits },
];

/** 所有命中必须收敛到同一段正文，否则即为歧义。 */
function adjudicate(kind: LocatorKind, hits: SpanHit[]): LocatorVerdict {
  const distinct = [...new Set(hits.map((h) => h.value))];
  if (distinct.length !== 1) {
    return { outcome: "ambiguous", via: kind, hits: hits.length };
  }
  return { outcome: "located", span: distinct[0] ?? "", via: kind, hits: hits.length };
}

// ---------------------------------------------------------------------------
// 各定位器的命中扫描
// ---------------------------------------------------------------------------

/** 逐字子串扫描，记录全部出现位置。 */
function scanLiteral(text: string, probe: string): SpanHit[] {
  if (probe.length === 0) return [];
  const hits: SpanHit[] = [];
  let cursor = 0;
  for (;;) {
    const at = text.indexOf(probe, cursor);
    if (at === -1) return hits;
    hits.push({ value: probe, at });
    cursor = at + Math.max(probe.length, 1);
  }
}

/** 先对正文与探针施加同一映射，再在映射后的文本上逐字扫描；命中的真实
 *  片段从原正文切出，长度以探针原文长度为准。 */
function scanMapped(
  text: string,
  probe: string,
  map: (value: string) => string,
): SpanHit[] {
  const mappedText = map(text);
  const mappedProbe = map(probe);
  const hits: SpanHit[] = [];
  let cursor = 0;
  for (;;) {
    const at = mappedText.indexOf(mappedProbe, cursor);
    if (at === -1) return hits;
    hits.push({ value: text.slice(at, at + probe.length), at });
    cursor = at + Math.max(mappedProbe.length, 1);
  }
}

function scanGutterHits(text: string, probe: string): SpanHit[] {
  const peeled = peelGutterPrefixes(probe);
  if (peeled === null || peeled === probe) return [];
  return scanLiteral(text, peeled);
}

function scanVisibleEscapeHits(text: string, probe: string): SpanHit[] {
  const decoded = decodeVisibleEscapes(probe);
  if (decoded === probe) return [];
  return scanLiteral(text, decoded);
}

function scanCodepointEscapeHits(text: string, probe: string): SpanHit[] {
  const decoded = decodeCodepointEscapes(probe);
  if (decoded === probe) return [];
  return scanLiteral(text, decoded);
}

/** 逐行比较：忽略每一行首尾空白；探针末尾的空行不计入行数。 */
function scanBlankInsensitiveHits(text: string, probe: string): SpanHit[] {
  const textLines = text.split("\n");
  const probeLines = dropTerminalBlank(probe.split("\n"));
  if (probeLines.length === 0) return [];

  const hits: SpanHit[] = [];
  for (let start = 0; start <= textLines.length - probeLines.length; start += 1) {
    const window = textLines.slice(start, start + probeLines.length);
    const linewiseEqual = window.every((line, i) => line.trim() === probeLines[i]!.trim());
    if (linewiseEqual) hits.push(hitFromWindow(textLines, start, probeLines.length));
  }
  return hits;
}

/** 至少两行；先对探针与候选窗口各自去除公共缩进，再要求整体一致。 */
function scanDedentHits(text: string, probe: string): SpanHit[] {
  const textLines = text.split("\n");
  const probeLines = dropTerminalBlank(probe.split("\n"));
  if (probeLines.length < 2) return [];

  const probeDedented = dedent(probeLines);
  const hits: SpanHit[] = [];
  for (let start = 0; start <= textLines.length - probeLines.length; start += 1) {
    const window = textLines.slice(start, start + probeLines.length);
    if (dedent(window) === probeDedented) {
      hits.push(hitFromWindow(textLines, start, probeLines.length));
    }
  }
  return hits;
}

/** 至少三行：首尾行 trim 后必须分别相等，中间各行平均相似度达到阈值。 */
function scanBookendHits(text: string, probe: string): SpanHit[] {
  const textLines = text.split("\n");
  const probeLines = dropTerminalBlank(probe.split("\n"));
  if (probeLines.length < 3) return [];

  const head = probeLines[0]!.trim();
  const tail = probeLines[probeLines.length - 1]!.trim();
  const hits: SpanHit[] = [];
  for (let start = 0; start <= textLines.length - probeLines.length; start += 1) {
    const window = textLines.slice(start, start + probeLines.length);
    if (window[0]!.trim() !== head) continue;
    if (window[window.length - 1]!.trim() !== tail) continue;
    if (meanInnerResemblance(window, probeLines) < BOOKEND_MIDDLE_FLOOR) continue;
    hits.push(hitFromWindow(textLines, start, probeLines.length));
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 文本规整小工具
// ---------------------------------------------------------------------------

/** CRLF 统一拍平为 LF。 */
function flattenEol(value: string): string {
  return value.split("\r\n").join("\n");
}

/** 统计 LF 与 CRLF 数量，返回占主导的换行风格（平手按 LF 处理）。 */
function dominantEol(value: string): "\n" | "\r\n" {
  let crlf = 0;
  let loneLf = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "\n") continue;
    if (i > 0 && value[i - 1] === "\r") crlf += 1;
    else loneLf += 1;
  }
  return crlf > loneLf ? "\r\n" : "\n";
}

/**
 * 剥离读取器输出的行号前缀（"123: 文本" 或 "123\t文本"）。只要有一行
 * 不带此前缀即返回 null（说明探针并非整段来自读取器）。
 */
function peelGutterPrefixes(probe: string): string | null {
  const peeled = probe.split("\n").map((line) => {
    const colon = line.match(/^[0-9]+: (.*)$/);
    if (colon) return colon[1] ?? "";
    const tab = line.match(/^[0-9]+\t(.*)$/);
    if (tab) return tab[1] ?? "";
    return null;
  });
  return peeled.every((line): line is string => line !== null) ? peeled.join("\n") : null;
}

/** 还原肉眼可见的常见转义：\n \t \r 转为真实控制字符；引号、反斜杠与
 *  $ 保持原样（它们在正文里本就如此书写）。 */
function decodeVisibleEscapes(probe: string): string {
  return probe.replace(/\\([ntr"'`\\$])/g, (whole, token: string) => {
    if (token === "n") return "\n";
    if (token === "t") return "\t";
    if (token === "r") return "\r";
    if (token === '"' || token === "'" || token === "`" || token === "\\" || token === "$") {
      return token;
    }
    return whole;
  });
}

/** 还原 \uXXXX 码点转义；\\\\ 形式（转义掉的反斜杠）保持不动。 */
function decodeCodepointEscapes(probe: string): string {
  return probe.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (whole, escapedSlash, hex: string) => {
    if (escapedSlash !== undefined) return whole;
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}

function hitFromWindow(lines: string[], startLine: number, lineCount: number): SpanHit {
  return { value: lines.slice(startLine, startLine + lineCount).join("\n"), at: lineStartOffset(lines, startLine) };
}

function lineStartOffset(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) {
    offset += lines[i]!.length + 1;
  }
  return offset;
}

function dropTerminalBlank(lines: string[]): string[] {
  return lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

/** 去除所有非空行共享的最小公共缩进；空行保持原样。 */
function dedent(lines: string[]): string {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return lines.join("\n");
  const floor = Math.min(...nonEmpty.map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0));
  return lines.map((line) => (line.trim().length === 0 ? line : line.slice(floor))).join("\n");
}

/** 中间各行（去掉首尾）相似度的平均值。 */
function meanInnerResemblance(actual: string[], expected: string[]): number {
  if (actual.length <= 2) return 1;
  let total = 0;
  let samples = 0;
  for (let i = 1; i < actual.length - 1; i += 1) {
    total += resemblanceRatio(actual[i]!.trim(), expected[i]!.trim());
    samples += 1;
  }
  return samples === 0 ? 1 : total / samples;
}

/** 两行文本的相似比例：1 减去编辑距离占较长行长度的比例。 */
function resemblanceRatio(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/** 经典莱文斯坦编辑距离（两行之间）。 */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const penalty = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + penalty);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

// ---------------------------------------------------------------------------
// 写入片段的风格适配
// ---------------------------------------------------------------------------

/** 若探针靠"可见转义还原"才命中，写入片段也要做同样的还原。 */
function adaptInsertion(via: LocatorKind, insert: string): string {
  return via === "visible_escapes" ? decodeVisibleEscapes(insert) : insert;
}

/**
 * 探针经过弯引号拉直才命中时，把写入片段里的直引号重新染成文件原有的
 * 弯引号风格；探针逐字命中时原样返回。
 */
function carryGlyphStyle(probe: string, locatedSpan: string, insert: string): string {
  if (probe === locatedSpan) return insert;

  let result = insert;
  if (locatedSpan.includes(OPEN_DOUBLE_GLYPH) || locatedSpan.includes(CLOSE_DOUBLE_GLYPH)) {
    result = curlDoubleQuotes(result);
  }
  if (locatedSpan.includes(OPEN_SINGLE_GLYPH) || locatedSpan.includes(CLOSE_SINGLE_GLYPH)) {
    result = curlSingleQuotes(result);
  }
  return result;
}

/** 把各类弯引号统一拉直为直引号。 */
function straightenQuotes(value: string): string {
  return value
    .split(OPEN_SINGLE_GLYPH).join("'")
    .split(CLOSE_SINGLE_GLYPH).join("'")
    .split(OPEN_DOUBLE_GLYPH).join('"')
    .split(CLOSE_DOUBLE_GLYPH).join('"');
}

function curlDoubleQuotes(value: string): string {
  const chars = [...value];
  return chars
    .map((ch, i) =>
      ch !== '"' ? ch : startsQuotation(chars, i) ? OPEN_DOUBLE_GLYPH : CLOSE_DOUBLE_GLYPH,
    )
    .join("");
}

function curlSingleQuotes(value: string): string {
  const chars = [...value];
  return chars
    .map((ch, i) => {
      if (ch !== "'") return ch;
      const before = chars[i - 1];
      const after = chars[i + 1];
      // 夹在两个字母中间（如英文缩写）按闭引号处理。
      if (isAlphabetic(before) && isAlphabetic(after)) return CLOSE_SINGLE_GLYPH;
      return startsQuotation(chars, i) ? OPEN_SINGLE_GLYPH : CLOSE_SINGLE_GLYPH;
    })
    .join("");
}

/** 根据前一个字符判断该引号是否处于开引号位置。 */
function startsQuotation(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const before = chars[index - 1];
  return (
    before === " " || before === "\t" || before === "\n" || before === "\r" ||
    before === "(" || before === "[" || before === "{" ||
    before === "—" || before === "–"
  );
}

function isAlphabetic(value: string | undefined): boolean {
  return value !== undefined && /\p{L}/u.test(value);
}

function tally(text: string, span: string): number {
  if (!span) return 0;
  let total = 0;
  let cursor = 0;
  for (;;) {
    const at = text.indexOf(span, cursor);
    if (at === -1) return total;
    total += 1;
    cursor = at + Math.max(span.length, 1);
  }
}

/** 执行替换；删除（insert 为空）时顺手吞掉行尾换行，使整行被移除而非
 *  留一个空行。 */
function splice(text: string, span: string, insert: string, everywhere: boolean): string {
  if (insert !== "") return substitute(text, span, insert, everywhere);
  const target =
    !span.endsWith("\n") && text.includes(`${span}\n`) ? `${span}\n` : span;
  return substitute(text, target, insert, everywhere);
}

function substitute(text: string, target: string, insert: string, everywhere: boolean): string {
  // 字符串型替换会把 $$、$& 当作特殊模式；split/join 与函数式替换都能
  // 保证写入片段逐字落盘。
  return everywhere ? text.split(target).join(insert) : text.replace(target, () => insert);
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 在给定文件内容上完成一次"按片段定位的精确改写"。
 *
 * @param original   文件当前内容（换行风格任意）
 * @param probe      待查片段（逐字为准，依次享受定位器降级容错）
 * @param insert     写入片段（逐字落盘）
 * @param everywhere 是否全局替换；否则要求目标唯一
 * @param hint       定位失败时附带的邻近片段，供模型对照
 */
export function rewriteByLocator(
  original: string,
  probe: string,
  insert: string,
  everywhere = false,
  hint?: string,
): PatchEditOutcome {
  if (probe === "") {
    return {
      ok: false,
      fault: "bad_request",
      message:
        "Nothing to search for: old_string was empty. Paste the exact fragment from the file " +
        "that should be replaced.",
      replaced: 0,
    };
  }

  if (probe === insert) {
    return {
      ok: false,
      fault: "nothing_to_do",
      message: "old_string and new_string are identical, so there is nothing to change.",
      replaced: 0,
    };
  }

  const eol = dominantEol(original);
  const text = flattenEol(original);
  const flatProbe = flattenEol(probe);
  const flatInsert = flattenEol(insert);

  const verdict = locateSpan(text, flatProbe, everywhere);

  if (verdict.outcome === "absent") {
    return {
      ok: false,
      fault: "missing_target",
      message:
        "Could not locate old_string anywhere in the file. It must fit the current text " +
        "character for character, whitespace and indentation included — re-read the file with " +
        "read_file if it may have changed, then paste the exact fragment.\n" +
        "— old_string —\n" + probe +
        (hint ? `\n\nNearby fragment found in the file:\n\n${hint}` : ""),
      replaced: 0,
    };
  }

  const multiplicity = verdict.outcome === "ambiguous"
    ? verdict.hits
    : tally(text, verdict.span);

  if (verdict.outcome === "ambiguous" || (!everywhere && multiplicity > 1)) {
    return {
      ok: false,
      fault: "multiple_targets",
      message:
        `old_string matches ${multiplicity} places while replace_all is off. ` +
        "Switch replace_all on to update every place, or widen the snippet so that only one " +
        "place can match.\n— old_string —\n" + probe,
      replaced: 0,
    };
  }

  const span = verdict.span;
  const readyInsert = adaptInsertion(verdict.via, flatInsert);
  const styledInsert = carryGlyphStyle(flatProbe, span, readyInsert);
  let next = splice(text, span, styledInsert, everywhere);

  if (eol === "\r\n") next = next.split("\n").join("\r\n");

  return {
    ok: true,
    text: next,
    replaced: everywhere ? multiplicity : 1,
    via: verdict.via,
  };
}
