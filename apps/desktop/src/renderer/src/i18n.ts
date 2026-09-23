/**
 * 渲染层 i18n 接入：语言偏好持久化（localStorage，与 theme 同模式）、
 * 生效语言解析、React hook。词条与判定逻辑见 ../../shared/i18n。
 */
import { useSyncExternalStore } from "react";
import {
  getLocale,
  isLocalePref,
  resolveLocale,
  setRuntimeLocale,
  subscribeLocale,
  t as coreT,
  type Locale,
  type LocalePref,
  type MsgId,
  type MsgParams,
} from "../../shared/i18n/core";

export const LOCALE_PREF_STORAGE_KEY = "owncoder:ui:locale";

function osLocale(): string {
  return typeof navigator !== "undefined" ? navigator.language : "";
}

function readStoredPref(): LocalePref {
  try {
    const raw = localStorage.getItem(LOCALE_PREF_STORAGE_KEY);
    return isLocalePref(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function persistPref(pref: LocalePref): void {
  try {
    localStorage.setItem(LOCALE_PREF_STORAGE_KEY, pref);
  } catch {
    /* quota / private mode — ignore */
  }
}

function applyPref(pref: LocalePref): void {
  setRuntimeLocale(resolveLocale(pref, osLocale()));
}

function syncMain(pref: LocalePref): void {
  // preload 未注入（单测 / 页面直开）时静默跳过：主进程对话框文案不跟随手动切换。
  void window.owncoder?.setLocaleOverride?.(pref)?.catch?.(() => {});
}

/** 启动时调用一次：读取持久化偏好并应用，同时同步主进程。 */
export function initLocale(): void {
  const pref = readStoredPref();
  applyPref(pref);
  syncMain(pref);
}

/** 切换语言偏好（"system" 跟随系统）：立即生效、持久化、同步主进程。 */
export function setLocalePref(pref: LocalePref): void {
  persistPref(pref);
  applyPref(pref);
  syncMain(pref);
}

export function readLocalePref(): LocalePref {
  return readStoredPref();
}

export interface I18n {
  locale: Locale;
  t: (id: MsgId, params?: MsgParams) => string;
}

/** 组件内取词；语言切换时触发重渲染。 */
export function useI18n(): I18n {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return { locale, t: coreT };
}
