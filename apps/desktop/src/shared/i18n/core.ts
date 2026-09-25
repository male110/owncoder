/**
 * 轻量 i18n 内核（主进程 / 渲染进程共享）。
 *
 * 设计：
 * - msgid 即中文原文（gettext 风格），`{{param}}` 为插值占位；
 *   zh 渲染 = msgid 本身（插值后），en 渲染 = en.ts 中的译文。
 * - en.ts 的 key 目录即 MsgId 类型源：`t()` 只接受已登记 msgid，
 *   编译期保证「用到的文案都有英文译文」。
 * - locale 判定：`detectLocale(osLocale)` —— `zh*` → zh，否则 en。
 */
import { en, type MsgId } from "./en";

export type Locale = "zh" | "en";
/** "system" 表示跟随操作系统区域设置。 */
export type LocalePref = "system" | Locale;
export type MsgParams = Record<string, string | number>;

export type { MsgId };

const LOCALES: readonly Locale[] = ["zh", "en"];

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

export function isLocalePref(value: unknown): value is LocalePref {
  return value === "system" || isLocale(value);
}

/** 系统区域设置 → 界面语言：zh* 归为中文，其余一律英文。 */
export function detectLocale(osLocale: string | null | undefined): Locale {
  return (osLocale ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

function interpolate(template: string, params?: MsgParams): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** 按指定语言取词条；en 缺失时回退 zh msgid（文案源）。 */
export function translate(locale: Locale, id: MsgId, params?: MsgParams): string {
  const template = locale === "en" ? (en[id] as string | undefined) ?? id : id;
  return interpolate(template, params);
}

// ── 运行时当前语言（每个进程一份模块级状态 + 订阅）─────────────────────────────

let currentLocale: Locale = "zh";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setRuntimeLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === currentLocale) return;
  currentLocale = locale;
  for (const fn of [...listeners]) fn();
}

/** 订阅语言变化；返回取消订阅函数。 */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 用当前运行时语言取词条。 */
export function t(id: MsgId, params?: MsgParams): string {
  return translate(currentLocale, id, params);
}

/** 语言偏好 → 生效语言（system 时按系统判定）。 */
export function resolveLocale(pref: LocalePref, osLocale: string | null | undefined): Locale {
  return pref === "system" ? detectLocale(osLocale) : pref;
}

/** 全部受支持语言（供设置界面枚举）。 */
export const SUPPORTED_LOCALES = LOCALES;
