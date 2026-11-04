/**
 * run_script — A tool for running JS scripts.
 *
 * Write a JavaScript snippet to fetch the needed info.
 * Only console.* output enters the conversation; each tool call's
 * raw return stays in the script variable space, digested into
 * a conclusion before printing. One run_script replaces a dozen
 * read/grep round-trips; raw bytes never enter the context.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import * as vm from "node:vm";
import { wrapChildProcessModule } from "./child-process-shim.ts";
import { scanUnterminatedString } from "../parser.ts";
import type { ParsedToolCall } from "../parser.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { fail } from "./shared.ts";

// ── 预算 ──────────────────────────────────────────────────

/** 单次脚本最多发起的工具调用数，防止失控脚本泛洪。 */
const MAX_TOOL_CALLS = 60;

/** 默认墙钟超时；模型可以传 timeout_ms 覆盖，但不得超过上限。 */
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;

/** 进入对话的 console 输出字节硬上限。 */
const OUTPUT_CAP_BYTES = 24 * 1024;

/** 输出超过此字节数且脚本声明了 intent 时，按意图关键词开窗提取相关片段。 */
const INTENT_WINDOW_THRESHOLD = 8 * 1024;

/** 窗口提取的字符总预算（每个窗口 ±300 字符，合并重叠后总量不超过此数）。 */
const SNIPPET_MAX_CHARS = 3000;

/** sleep() 单次最多睡这么久，防止脚本用循环 sleep 消磨预算。 */
const MAX_SLEEP_MS = 10_000;

/** 注入沙箱的 read_file 兼容助手名（fs.readFileSync 自动改写的目标）。 */
const READ_FILE_TOOL_FN = "__readFileTool";
/** 注入沙箱的 list_dir 兼容助手名（fs.readdirSync 自动改写的目标）。 */
const READ_DIR_TOOL_FN = "__readDirTool";
/** 注入沙箱的 list_dir 兼容助手名（无 withFileTypes 的 readdirSync，返回字符串数组）。 */
const READ_DIR_NAMES_TOOL_FN = "__readDirNamesTool";

const PYTHONISH = /(?:^\s*(?:import|from)\s+[\w.]+\s*,\s*\w|^\s*def\s+\w+\s*\(|^\s*print\s*\(|^\s*\w+\s*\(\s*['"].*['"]\s*\)\s*$)/m;

export interface RunScriptOptions {
  /** 墙钟超时（ms），调用方可用 timeout_ms 参数覆盖，上限 MAX_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 脚本意图；输出超过 INTENT_WINDOW_THRESHOLD 时按此关键词开窗提取相关片段。 */
  intent?: string;
}

/** 脚本里 tools.call() 返回的形状（ToolResult 的公开子集）。 */
export interface ScriptToolCallResult {
  ok: boolean;
  output: string;
}

class ScriptTimeout extends Error {
  constructor() {
    super("run_script 超时");
    this.name = "ScriptTimeout";
  }
}

class ScriptAborted extends Error {
  constructor() {
    super("run_script 已中止");
    this.name = "ScriptAborted";
  }
}

/** console.* 参数的简易格式化：对象走 JSON，其余走 String，空格分隔。 */
function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return typeof a === "object" && a !== null ? JSON.stringify(a) : String(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** 字节安全截断：按 UTF-8 边界切，超出加省略标记。 */
function capOutput(s: string): string {
  if (Buffer.byteLength(s, "utf-8") <= OUTPUT_CAP_BYTES) return s;
  // 二分找最长 UTF-8 安全前缀
  const marker = `\n... [输出超过 ${OUTPUT_CAP_BYTES} 字节，已截断]`;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf-8") <= OUTPUT_CAP_BYTES - Buffer.byteLength(marker, "utf-8")) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + marker;
}

/**
 * 按意图关键词从大输出里开窗提取相关片段：围绕每个关键词开 ±300 字符
 * 窗口，合并重叠窗口，窗口总量不超过 maxLen。无任何匹配时退回前缀。
 */
function extractSnippet(content: string, query: string, maxLen: number): string {
  const positions: number[] = [];
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const lower = content.toLowerCase();
  for (const term of terms) {
    let idx = lower.indexOf(term);
    while (idx !== -1) {
      positions.push(idx);
      idx = lower.indexOf(term, idx + 1);
    }
  }
  if (!positions.length) {
    return content.slice(0, maxLen) + "\n…";
  }
  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  const windows: Array<[number, number]> = [];
  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(content.length, pos + WINDOW);
    const last = windows[windows.length - 1];
    if (last && start <= last[1]) last[1] = end;
    else windows.push([start, end]);
  }
  const parts: string[] = [];
  let total = 0;
  for (const [start, end] of windows) {
    if (total >= maxLen) break;
    const part = content.slice(start, Math.min(end, start + maxLen - total));
    parts.push((start > 0 ? "…" : "") + part + (end < content.length ? "…" : ""));
    total += part.length;
  }
  return parts.join("\n\n");
}

/**
 * 输出管制（分层策略）：小输出原样进对话；
 * 超过 INTENT_WINDOW_THRESHOLD 且脚本声明了 intent 时，按意图关键词
 * 开窗提取——内容不丢，只裁出相关片段并标注原文规模；最后统一过字节
 * 硬上限兜底。无 intent 的大输出退化为前缀截断 + 标记。
 */
function applyOutputPolicy(raw: string, intent: string | undefined): string {
  if (intent && Buffer.byteLength(raw, "utf-8") > INTENT_WINDOW_THRESHOLD) {
    const snippet = extractSnippet(raw, intent, SNIPPET_MAX_CHARS);
    return capOutput(
      `[原文 ${Buffer.byteLength(raw, "utf-8")} 字节，按 intent 开窗提取了相关片段]\n${snippet}`,
    );
  }
  return capOutput(raw);
}

/**
 * 执行模型提交的 JS 脚本。
 *
 * @param ctx 共享的工具上下文——内层调用复用同一 ctx，因此 readSet 累积、
 *            输出脱敏、signal 中止等语义与主循环完全一致。
 * @param code 脚本源码（在 async IIFE 内执行，顶层 await 可用）。
 */
export async function toolRunScript(
  ctx: ToolContext,
  code: string,
  opts: RunScriptOptions = {},
): Promise<ToolResult> {
  // execute.ts 静态导入本模块；这里反向需要 executeTool，用动态 import
  // 打破环（loop.ts 的 dispatchSubagent 同款模式）。
  const { executeTool } = await import("../execute.ts");

  const timeoutMs = Math.min(
    Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );
  const intent = typeof opts.intent === "string" ? opts.intent.trim() || undefined : undefined;
  const startedAt = Date.now();

  const consoleChunks: string[] = [];
  const pushConsole = (args: unknown[]) => {
    consoleChunks.push(formatConsoleArgs(args));
  };

  let toolCalls = 0;
  let timedOut = false;
  let aborted = false;

  // require 锚定工作区：三方包从用户项目 node_modules 解析；Node 内建
  // （含 node:fs 等）同样可导入——实现层不做限制（标准 Node 解析语义）。
  // 工具描述只向模型宣传"可 require 内建模块做计算"，读文件等一律引导走
  // tools.call。
  const workspaceRequire = createRequire(join(ctx.workspaceRoot, "package.json"));
  // 唯一例外：child_process 做文本输出编码修正包装（Windows 下 cmd.exe
  // 的 GBK 报错直接有损解码成乱码且不可逆），并对搜索/列目录类命令施加
  // 工作区范围围栏（与 bash 工具同一规则，堵死脚本内 spawn 绕过），
  // 详见 child-process-shim.ts。
  const sandboxChildProcess = wrapChildProcessModule(
    workspaceRequire("node:child_process") as Record<string, unknown>,
    { workspaceRoot: ctx.workspaceRoot },
  );

  /**
   * 内层工具调用：tools.call 与 fs 兼容助手共用，预算/中止/脱敏语义与
   * 主循环完全一致。
   */
  const callTool = async (
    name: unknown,
    args?: unknown,
    internalToolCall = false,
  ): Promise<ScriptToolCallResult> => {
    if (typeof name !== "string" || !name) {
      throw new Error("tools.call 参数错误：name 必须是非空字符串");
    }
    if (name === "run_script") {
      throw new Error("tools.call 拒绝：run_script 不能递归调用自身");
    }
    if (timedOut) throw new ScriptTimeout();
    if (aborted || ctx.signal?.aborted) throw new ScriptAborted();
    if (toolCalls >= MAX_TOOL_CALLS) {
      throw new Error(
        `tools.call 预算耗尽：单次 run_script 最多 ${MAX_TOOL_CALLS} 次工具调用。`,
      );
    }

    const callArgs: Record<string, unknown> =
      args !== undefined && args !== null && typeof args === "object"
        ? (args as Record<string, unknown>)
        : {};
    if (Array.isArray(args)) {
      throw new Error("tools.call 参数错误：args 必须是对象（如 { file_path: 'src/x.ts' }），不能是数组");
    }

    toolCalls += 1;
    const call: ParsedToolCall = {
      id: `run-script-${Date.now().toString(36)}-${toolCalls}`,
      name,
      arguments: callArgs,
      rawArguments: JSON.stringify(callArgs),
    };
    // Nested calls use the parent's effective tool surface and shared ledger;
    // scripts cannot widen permissions by calling executeTool directly.
    const nestedCtx: ToolContext = {
      ...ctx,
      nestedToolCall: true,
      internalToolCall,
      availableTools: ctx.availableTools,
    };
    const result = await executeTool(nestedCtx, call);
    return { ok: result.ok, output: result.output };
  };

  const sandbox: Record<string, unknown> = {
    console: {
      log: (...a: unknown[]) => pushConsole(a),
      info: (...a: unknown[]) => pushConsole(a),
      warn: (...a: unknown[]) => pushConsole(a),
      error: (...a: unknown[]) => pushConsole(a),
    },
    /**
     * 导入模块：透传锚定工作区根的 Node require（自带 resolve/cache/main，
     * require.resolve 标准可用）。工具描述只向模型宣传"可 require 内建
     * 模块做计算辅助"——读文件一律引导走 tools.call（read_file），文件名
     * 定位/内容搜索引导走 tools.call（glob/grep）。唯一包装：child_process
     * 的输出解码经修正（Windows GBK 报错不再变成乱码），其余模块原样透传。
     */
    require: (spec: unknown): unknown => {
      if (typeof spec !== "string") throw new Error("require 只接受模块名");
      const normalized = spec.replace(/^node:/, "");
      if (normalized === "child_process" || normalized === "fs" || normalized === "fs/promises") {
        // Legacy direct tool callers do not provide an effective tool set; keep
        // compatibility there while role-scoped loops remain fail-closed.
        if (!ctx.availableTools) {
          if (normalized === "child_process") return sandboxChildProcess;
          return workspaceRequire(spec);
        }
        if (normalized === "child_process" && ctx.availableTools.has("bash")) return sandboxChildProcess;
        throw new Error(`run_script 禁止直接加载 ${spec}；请通过 tools.call 使用受控工具`);
      }
      const builtin = new Set(["path", "url", "util", "os", "crypto", "querystring"]);
      if (spec.startsWith("node:") && !builtin.has(normalized)) {
        throw new Error(`run_script 禁止加载内建模块 ${spec}`);
      }
      return workspaceRequire(spec);
    },
    /**
     * fs.readFileSync 兼容助手（由预检改写注入，脚本不应直接手写）：
     * 同步读的签名、异步走 read_file 工具，剥掉 "[lines …]" 头与 "N|"
     * 前缀，还原纯文本。失败抛错，语义对齐 readFileSync 的 ENOENT 行为。
     */
    [READ_FILE_TOOL_FN]: async (p: unknown): Promise<string> => {
      const r = await callTool("read_file", { file_path: String(p) }, true);
      if (!r.ok) {
        throw new Error(`fs 兼容读失败（${String(p)}）：${r.output}`);
      }
      // 首行是 "[lines 1-N of T]" 头，其余行带 "  N|" 前缀；
      // 剥掉后 join，尾换行随末行空串自然保留，对齐 readFileSync 文本。
      return r.output
        .split("\n")
        .slice(1)
        .map((l) => l.replace(/^\s*\d+\|/, ""))
        .join("\n");
    },
    /**
     * fs.readdirSync(dir, {withFileTypes:true}) 兼容助手（由预检改写注入）：
     * 走 tools.call("list_dir")，把每行 "rel/path" 或 "rel/dir/" 合成
     * Dirent 形状对象（name/isDirectory/isFile），还原 withFileTypes 语义。
     * list_dir 失败（目录不存在等）时抛错，对齐 readdirSync 的抛错行为。
     */
    [READ_DIR_TOOL_FN]: async (dir: unknown): Promise<Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>> => {
      const r = await callTool("list_dir", { file_path: String(dir) }, true);
      if (!r.ok) {
        throw new Error(`fs 兼容列目录失败（${String(dir)}）：${r.output}`);
      }
      return r.output
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const isDir = line.endsWith("/");
          const name = line.slice(0, isDir ? -1 : undefined).split("/").pop() ?? line;
          return {
            name,
            isDirectory: () => isDir,
            isFile: () => !isDir,
          };
        });
    },
    /**
     * fs.readdirSync(dir)（无 withFileTypes 选项）兼容助手：走 list_dir，
     * 返回名字字符串数组（对齐 readdirSync 默认语义）。
     */
    [READ_DIR_NAMES_TOOL_FN]: async (dir: unknown): Promise<string[]> => {
      const r = await callTool("list_dir", { file_path: String(dir) }, true);
      if (!r.ok) {
        throw new Error(`fs 兼容列目录失败（${String(dir)}）：${r.output}`);
      }
      return r.output
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.slice(0, line.endsWith("/") ? -1 : undefined).split("/").pop() ?? line);
    },
    tools: {
      /**
       * 调用一个内置工具。返回 { ok, output }；工具失败不抛错，
       * 脚本按 ok 判断并自行决定补救（换参数、换工具）。
       */
      call: callTool,
      list: (): string[] => Array.from(ctx.availableTools ?? []).filter((n) => n !== "run_script"),
    },
    /** 受限 sleep：上限 MAX_SLEEP_MS，只用于重试退避。 */
    sleep: (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(ms | 0, 0), MAX_SLEEP_MS))),
  };

  // vm 上下文只含注入的 API + 标准内建（Object/JSON/Promise/Math…）：
  // console/tools/require/__readFileTool + sleep；没有 process/fs/fetch。
  // require 透传锚定工作区根的 Node require（child_process 除外——输出
  // 解码经编码修正包装）；动态 import() 经 vm.Script 的
  // importModuleDynamically 转发到默认 loader（静态 import 语句仍不
  // 支持——脚本按 classic script 编译）。fs 兼容助手由预检改写注入，
  // 脚本不应直接手写。
  const context = vm.createContext(Object.create(null));
  for (const [key, value] of Object.entries(sandbox)) context[key] = value;

  // 预检门：直接文件访问在编译前处理。可安全改写的（readFileSync）自动
  // 改成 read_file 工具调用——内容相同，但经过权限校验、脱敏与只读门禁；
  // 不能改写的（write/readdir 等）拒绝并给出替代写法。
  // 完整性预检门：code 在到达 vm.Script 之前先做轻量级语法扫描。
  // 根因：run_script 的 code 参数在"模型输出 → harness 传输/解析"环节被
  // 截断（输出 token 上限）或引号错乱（未转义的引号/反斜杠），V8 随后只
  // 报一句莫名的 "Unexpected token '<>' / "Invalid or unexpected token"，
  // 模型无法定位问题。这里在编译前拦截，给出具体位置与修复建议。
  // 只拦结构性残缺（未闭合字符串/括号、多余闭括号）——这些是截断/错乱的
  // 确凿证据；真正的语法错误（缺分号、关键字误用等）仍交给 vm.Script 报。
  const integrity = scanUnterminatedString(code);
  if (integrity) {
    return fail(
      `run_script 载荷未完整到达：${integrity.detail}\n` +
        `问题位置：第 ${integrity.line} 行第 ${integrity.column} 列\n` +
        `附近原文：${integrity.snippet}\n` +
        "原因：code 参数在传输中被截断（单步输出超过 token 上限），或字符串内含有未转义的引号/反斜杠导致引号配对错乱。\n" +
        "修复：(1) 把长脚本拆成多次 run_script 调用，每步 code 不超过 200 字符；" +
        "(2) 检查字符串字面量的引号是否配对、转义是否正确（反斜杠与引号需成对转义）。",
    );
  }

  // 顶层 await 与 return 都可用：代码整体包在一个 async IIFE 里。
  const wrapped = `"use strict";\n(async () => {\n${code}\n})()`;

  let script: vm.Script;
  try {
    // 动态 import()：交给主上下文的默认 loader（真实 Node ESM 解析，
    // 内建模块开箱即用；裸包名按宿主进程 cwd 解析——生产态 harness 就
    // 跑在工作区内，与 require 的工作区锚定基本一致）。自定义回调在
    // Node 24 上被 --experimental-vm-modules 门挡住，故不用。
    script = new vm.Script(wrapped, {
      filename: "run-script.js",
      importModuleDynamically: async (specifier: string) => {
        const normalized = specifier.replace(/^node:/, "");
        if (normalized === "child_process" || normalized === "fs" || normalized === "fs/promises") {
          if (!ctx.availableTools) return import(specifier);
          throw new Error(`run_script 禁止动态加载 ${specifier}；请通过 tools.call 使用受控工具`);
        }
        const builtin = new Set(["path", "url", "util", "os", "crypto", "querystring"]);
        if (specifier.startsWith("node:") && !builtin.has(normalized)) {
          throw new Error(`run_script 禁止动态加载内建模块 ${specifier}`);
        }
        return import(specifier);
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Python 习惯误用：特征明显时直接点明，避免模型反复撞同一个语法错误。
    if (PYTHONISH.test(code)) {
      return fail(
        `脚本语法错误：${msg}\n看起来是 Python——run_script 只执行 JavaScript。` +
          '环境探测改用 tools.call("bash", { command: "python --version" })，HTTP 改用 tools.call("web_fetch", { url })；' +
          "脚本内只能 require Node 内建模块做计算，需要的数据一律用 tools.call 取。",
      );
    }
    return fail(`脚本语法错误：${msg}`);
  }

  const finish = (autoNote: string): ToolResult => {
    const elapsed = Date.now() - startedAt;
    const body = applyOutputPolicy(consoleChunks.join("\n"), intent);
    const footer = `\n\n_(run_script: ${toolCalls} 次工具调用, ${elapsed}ms${autoNote})_`;
    return { ok: true, output: (body || "(no output)") + footer };
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new ScriptTimeout());
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (ctx.signal?.aborted) {
      aborted = true;
      reject(new ScriptAborted());
      return;
    }
    onAbort = () => {
      aborted = true;
      reject(new ScriptAborted());
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const scriptPromise = script.runInContext(context);
    // 超时/中止后脚本仍可能挂起，挂一个 no-op catch 兜住未处理拒绝。
    scriptPromise.catch(() => {});
    await Promise.race([scriptPromise, timeoutPromise, abortPromise]);
    return finish("");
  } catch (e) {
    const elapsed = Date.now() - startedAt;
    const collected = applyOutputPolicy(consoleChunks.join("\n"), intent);
    // run_script 只允许受控 require：模型常误用 process/fs，错误旁补一句可执行的替代写法，
    // 让它下一轮自己纠正，而不是再次撞同一个 ReferenceError。
    // 注意 vm 是独立 realm：脚本内抛的 e 用 instanceof Error 判断会失败，只能在提取文本后做匹配。
    const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const missingHint = /(?:process|Buffer|__dirname|__filename|global) is not defined/.test(errMsg)
      ? 'run_script 沙箱没有 process/Buffer/__dirname/fetch 等全局：内建模块可 require 取用（如 require("node:process")），动态 import() 与 require 等效，仅静态 import 语句不支持。读文件用 tools.call("read_file", { file_path })，tools.list() 查全部可调用工具'
      : "";
    // child_process 撞墙（典型：模型以为自己在 Linux 容器，用 /workspace 路径，
    // 或写了 cmd 专属语法）：旁补平台事实与跨平台替代写法，让下一轮自己纠正，
    // 而不是对着报错反复重试同一条命令。（子进程输出的宿主本地编码已由
    // child-process-shim 正确解码，模型拿到的是可读文本。Windows 上字符串
    // 命令默认由 PowerShell 执行——POSIX 管道/重定向不可用，cmd 专属语法
    // 才会撞墙。）
    const cmdFailHint = /Command failed/.test(errMsg)
      ? '脚本经 child_process 执行命令失败：不要重复重试同一条绝对路径 shell 命令。定位文件请改用 tools.call("glob", { pattern: "**/*目标文件名*", file_path: "." })，搜索内容请用 tools.call("grep", { pattern, file_path: ".", output_mode: "files_with_matches" })；这些工具使用当前 workspace 并自动过滤 .gitignore。Windows 上 /workspace、/e/... 等容器/MSYS 路径可能不存在。'
      : "";
    const note =
      (e instanceof ScriptTimeout
        ? `脚本超时（${timeoutMs}ms），以上为已捕获的部分输出；提高 timeout_ms 或拆分任务后重试`
        : e instanceof ScriptAborted
          ? "操作已停止"
          : `脚本抛出错误：${errMsg}` + (missingHint ? `\n${missingHint}` : "") + (cmdFailHint ? `\n${cmdFailHint}` : ""));

    if (!consoleChunks.length) {
      return fail(
        `${note}\n\n_(run_script: ${toolCalls} 次工具调用, ${elapsed}ms)_`,
      );
    }
    // 有部分输出时一并返回（脱敏已由内层 executeTool 完成），错误作为后缀。
    return fail(
      `${collected}\n\n${note}\n\n_(run_script: ${toolCalls} 次工具调用, ${elapsed}ms)_`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) ctx.signal?.removeEventListener("abort", onAbort);
  }
}
