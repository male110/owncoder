/**
 * run_script 沙箱内 child_process 输出的文本解码修正（Windows 控制台编码）。
 *
 * 背景：沙箱允许脚本 require("child_process") 直接执行命令（能力等同
 * node -e，见 run-script.ts）。但 execSync/spawnSync 默认把子进程输出按
 * UTF-8 有损解码——cmd.exe 的本地化报错（中文 Windows 是 GBK/936 字节）
 * 会变成 "ϵͳҲα·汾" 类乱码，Node 还会把这段乱码拼进
 * "Command failed: …" 错误消息。字节一旦按 UTF-8 有损解码就丢失了，无法
 * 事后还原——必须在仍持有原始 Buffer 的层面修。
 *
 * 策略（不探测环境、不猜 locale，按内容二分，只有两种现实情况）：
 * - 包装 execSync / execFileSync / spawnSync / exec / execFile（流式
 *   spawn 不动——是否文本化由调用方决定）；显式 encoding:'buffer'/'hex'
 *   等调用原样透传。
 * - Windows 上字符串命令形式（execSync(command) / exec(command, cb)）
 *   且调用方未显式指定 shell 时，默认使用 Windows 内置 PowerShell。
 *   数组形式（execFile/execFileSync）与显式 shell 调用语义不变。
 * - 拦截文本类调用（encoding 缺省或 utf8），内部强制 encoding:'buffer'
 *   拿原始字节：先严格 UTF-8 解码——现代工具链（PowerShell
 *   包装层、输出 UTF-8 的程序）严格合法，通过即原样；非法 UTF-8 则只可能
 *   是宿主控制台代码页字节（中文 Windows 的 GBK 本地化报错等），按 GBK
 *   还原。
 * - 错误对象的 stdout/stderr 同步替换为正确文本，message 里嵌入的有损
 *   后缀一并换掉。
 *
 * 已知限制：动态 import("node:child_process") 经 vm 默认 loader 解析，
 * 不走本包装（相对路径导入的正确性优先于这一边缘路径）；stdout 里
 * UTF-8 程序输出与 GBK 报错混排的管道流只能整体按一种编码解码——模型
 * 应避免这种写法。
 */

import { promisify } from "node:util";

import { resolveWindowsShell } from "./windows-shell.ts";
import { findSearchScopeViolation } from "../terminal.ts";

/**
 * 沙箱内直接执行命令的搜索范围围栏选项：run_script 创建沙箱时传入
 * 工作区根，exec/execSync/execFile/spawnSync 的字符串命令（及数组参数）
 * 会先过 findSearchScopeViolation，越界搜索（find /、ls .. 等）抛错——
 * 与 bash 工具同一套规则，堵死脚本里 spawn 命令绕过工具围栏的路径。
 */
export interface ChildProcessScopeOptions {
  /** 工作区根路径；缺省时不做范围检查（仅编码修正）。 */
  workspaceRoot?: string;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const GBK = new TextDecoder("gbk");

/**
 * 子进程输出 → 文本：严格 UTF-8 优先（现代工具链输出原样通过）；非法
 * UTF-8 即为宿主控制台代码页字节（中文 Windows 的 GBK 本地化报错等），
 * 按 GBK 还原。接受 Buffer 或已解码的 string（后者原样返回，便于统一
 * 处理 err.stdout）。
 */
export function decodeChildOutput(buf: Buffer | string | undefined | null): string {
  if (buf === undefined || buf === null) return "";
  if (typeof buf === "string") return buf;
  if (buf.length === 0) return "";
  try {
    return STRICT_UTF8.decode(buf);
  } catch {
    return GBK.decode(buf);
  }
}

// ── 模块包装 ────────────────────────────────────────────────

type AnyFn = (...args: unknown[]) => unknown;

const TEXT_UTF8 = /^(?:utf-?8|utf8)$/i;

/**
 * 调用方要文本（encoding 缺省或 utf8）时才拦截；显式 buffer/hex/latin1
 * 等原样透传（模型要的就是原始字节）。
 */
function wantsText(opts: { encoding?: unknown } | undefined): boolean {
  const enc = opts?.encoding;
  return enc === undefined || enc === null || (typeof enc === "string" && TEXT_UTF8.test(enc));
}

/** 显式指定了 utf8 类 encoding 的 spawnSync（缺省返回 Buffer，不接管）。 */
function explicitlyTextual(opts: { encoding?: unknown } | undefined): boolean {
  const enc = opts?.encoding;
  return typeof enc === "string" && TEXT_UTF8.test(enc);
}

/**
 * Windows 字符串命令的默认壳选项：调用方未显式指定 shell 时使用
 * Windows 内置 PowerShell；显式 shell:true / shell:"..." 一律尊重调用方选择。
 */
function windowsBashOptions(
  opts: Record<string, unknown>,
): { shell: string; env: NodeJS.ProcessEnv } | null {
  if (process.platform !== "win32") return null;
  if (opts.shell !== undefined && opts.shell !== null && opts.shell !== false) return null;
  if (resolveWindowsShell().kind !== "powershell") return null;
  return {
    shell: "powershell.exe",
    env: (opts.env as NodeJS.ProcessEnv | undefined) ?? process.env,
  };
}

/** execSync 抛错时 Node 会把 stderr 字符串拼进 message；同步换成正确文本。 */
function fixErrorText(e: unknown): void {
  if (!e || typeof e !== "object") return;
  const err = e as { stdout?: unknown; stderr?: unknown; message?: string };
  for (const key of ["stdout", "stderr"] as const) {
    const v = err[key];
    if (!Buffer.isBuffer(v)) continue;
    const text = decodeChildOutput(v);
    const bad = v.toString("utf8");
    if (bad && typeof err.message === "string" && err.message.includes(bad)) {
      err.message = err.message.split(bad).join(text);
    }
    err[key] = text;
  }
}

function guardScope(command: string, scope?: ChildProcessScopeOptions): void {
  if (scope?.workspaceRoot) {
    const violation = findSearchScopeViolation(command, scope.workspaceRoot);
    if (violation) throw new Error(violation);
  }
}

function joinCommandParts(command: unknown, args?: unknown): string {
  const head = typeof command === "string" ? command : "";
  const rest = Array.isArray(args)
    ? (args as unknown[]).filter((a): a is string => typeof a === "string").join(" ")
    : "";
  return [head, rest].filter(Boolean).join(" ");
}

function wrapExecSync(orig: AnyFn, scope?: ChildProcessScopeOptions): AnyFn {
  return function execSync(command: unknown, options?: unknown) {
    // execSync(command, opts) 与 execFileSync(file, args, opts) 复用本包装：
    // 后者的 args 是数组形态，拼进待检查的命令串。
    guardScope(
      Array.isArray(options) ? joinCommandParts(command, options) : String(command),
      scope,
    );
    const opts = (options ?? {}) as Record<string, unknown>;
    if (!wantsText(opts)) return orig(command, options);
    const bashOpts = windowsBashOptions(opts);
    try {
      const stdout = orig(command, { ...opts, ...bashOpts, encoding: "buffer" }) as Buffer;
      return decodeChildOutput(stdout);
    } catch (e) {
      fixErrorText(e);
      throw e;
    }
  };
}

function wrapSpawnSync(orig: AnyFn, scope?: ChildProcessScopeOptions): AnyFn {
  return function spawnSync(command: unknown, args?: unknown, options?: unknown) {
    // spawnSync(cmd, opts) 两参形式：args 位置是选项对象。
    let a = args;
    let o = options as Record<string, unknown> | undefined;
    if (a !== undefined && a !== null && !Array.isArray(a) && typeof a === "object") {
      o = a as Record<string, unknown>;
      a = undefined;
    }
    guardScope(joinCommandParts(command, a), scope);
    if (!explicitlyTextual(o)) return orig(command, a, options);
    const r = orig(command, a, { ...o, encoding: "buffer" }) as {
      stdout?: unknown;
      stderr?: unknown;
      error?: unknown;
    };
    if (Buffer.isBuffer(r.stdout)) r.stdout = decodeChildOutput(r.stdout);
    if (Buffer.isBuffer(r.stderr)) r.stderr = decodeChildOutput(r.stderr);
    if (r.error) fixErrorText(r.error);
    return r;
  };
}

function wrapExec(orig: AnyFn, scope?: ChildProcessScopeOptions): AnyFn {
  return function exec(command: unknown, options?: unknown, callback?: unknown) {
    if (typeof command === "string") guardScope(command, scope);
    let opts = options as Record<string, unknown> | undefined;
    let cb = callback as ((...a: unknown[]) => void) | undefined;
    if (typeof opts === "function") {
      cb = opts;
      opts = undefined;
    }
    if (!wantsText(opts) || typeof cb !== "function") return orig(command, options, callback);
    const bashOpts = windowsBashOptions(opts ?? {});
    return orig(command, { ...opts, ...bashOpts, encoding: "buffer" }, (err: unknown, stdout?: unknown, stderr?: unknown) => {
      if (err) fixErrorText(err);
      cb!(err, decodeChildOutput(stdout as Buffer), decodeChildOutput(stderr as Buffer));
    });
  };
}

function wrapExecFile(orig: AnyFn, scope?: ChildProcessScopeOptions): AnyFn {
  return function execFile(file: unknown, args?: unknown, options?: unknown, callback?: unknown) {
    // 归一化 execFile 的四种调用形式：
    // (file, cb) / (file, args, cb) / (file, opts, cb) / (file, args, opts, cb)
    let a = args;
    let opts = options as Record<string, unknown> | undefined;
    let cb = callback as ((...a: unknown[]) => void) | undefined;
    if (typeof a === "function") {
      cb = a as unknown as (...a: unknown[]) => void;
      a = undefined;
      opts = undefined;
    } else if (typeof opts === "function") {
      cb = opts as unknown as (...a: unknown[]) => void;
      if (a !== undefined && a !== null && !Array.isArray(a) && typeof a === "object") {
        opts = a as Record<string, unknown>;
        a = undefined;
      } else {
        opts = undefined;
      }
    }
    guardScope(joinCommandParts(file, a), scope);
    if (!wantsText(opts) || typeof cb !== "function") return orig(file, args, options, callback);
    return orig(file, a, { ...opts, encoding: "buffer" }, (err: unknown, stdout?: unknown, stderr?: unknown) => {
      if (err) fixErrorText(err);
      cb!(err, decodeChildOutput(stdout as Buffer), decodeChildOutput(stderr as Buffer));
    });
  };
}

const PROMISIFY_CUSTOM = (promisify as { custom?: symbol }).custom;

/**
 * 给包装函数补回 util.promisify 定制语义：原生 exec/execFile 的
 * promisify 结果 resolve { stdout, stderr }。直接复用原函数的定制实现会
 * 绕回未包装的原函数（乱码照旧），故用自己的解码实现替换。
 */
function attachPromisifyCustom(src: AnyFn, wrappedExecFn: AnyFn): void {
  if (!PROMISIFY_CUSTOM) return;
  try {
    if (!Object.prototype.hasOwnProperty.call(src, PROMISIFY_CUSTOM)) return;
    (wrappedExecFn as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM] = (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        (wrappedExecFn as AnyFn)(...args, (err: unknown, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });
  } catch {
    // promisify 定制缺失不影响主流程
  }
}

/**
 * 把 child_process 模块包装成输出文本编码修正版：函数签名、返回类型、
 * 缺省行为（execSync 默认字符串、spawnSync 默认 Buffer）全部保持不变，
 * 仅文本类输出的解码路径由"有损 UTF-8"换成"严格 UTF-8 + GBK 兜底"。
 * 传入 scope.workspaceRoot 时，搜索/列目录类命令同时受工作区范围围栏
 * 约束（与 bash 工具同一套规则）。
 */
export function wrapChildProcessModule<T extends object>(
  mod: T,
  scope?: ChildProcessScopeOptions,
): T {
  const orig = mod as unknown as Record<string, unknown>;
  const facade: Record<string, unknown> = { ...orig };
  const wrap = (name: string, make: (f: AnyFn, s?: ChildProcessScopeOptions) => AnyFn): void => {
    const f = orig[name];
    if (typeof f === "function") facade[name] = make(f as AnyFn, scope);
  };
  wrap("execSync", wrapExecSync);
  wrap("execFileSync", wrapExecSync);
  wrap("spawnSync", wrapSpawnSync);
  wrap("exec", wrapExec);
  wrap("execFile", wrapExecFile);
  // exec/execFile 的 promisify 定制指向包装后的实现
  if (typeof facade.exec === "function") attachPromisifyCustom(orig.exec as AnyFn, facade.exec as AnyFn);
  if (typeof facade.execFile === "function") attachPromisifyCustom(orig.execFile as AnyFn, facade.execFile as AnyFn);
  return facade as T;
}
