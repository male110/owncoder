/**
 * UI store — editor panel, settings panel, command palette, mode menu, sidebar,
 * drag-resize state. Pure local UI state, no IPC involved.
 */
import { create } from "zustand";
import type { TabId } from "../SettingsPanel";
import {
  applyThemeToDocument,
  persistTheme,
  readStoredTheme,
  syncNativeChrome,
  type UiTheme,
} from "../theme";

export interface UiState {
  // Editor pane（多 tab：editorTabs 为已打开文件，editorPath 为当前激活）
  editorTabs: string[];
  editorPath: string | null;
  chatWidth: number;
  isDragging: boolean;

  // Sidebar
  sidebarWidth: number;
  isSidebarDragging: boolean;
  sidebarCollapsed: boolean;

  // Overlays
  settingsOpen: boolean;
  settingsTab: TabId;
  searchOpen: boolean;
  modeMenuOpen: boolean;

  /** App chrome theme: dark (default) or muted professional light. */
  theme: UiTheme;

  // Composer drafts (per session)
  drafts: Record<string, string>;

  // Busy guards (non-chat)
  busy: boolean;
  keepAllBusy: boolean;
}

export interface UiActions {
  /** 打开文件：已存在则激活，否则追加到 tabs 并激活；传 null 清空全部。 */
  setEditorPath: (path: string | null) => void;
  /** 仅切换当前激活 tab（不增删）。 */
  setActiveEditorTab: (path: string) => void;
  /** 关闭指定 tab；若关闭的是当前激活，则激活相邻 tab。 */
  closeEditorTab: (path: string) => void;
  setChatWidth: (width: number) => void;
  setIsDragging: (v: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setIsSidebarDragging: (v: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setSettingsTab: (tab: TabId) => void;
  setSearchOpen: (v: boolean) => void;
  setModeMenuOpen: (v: boolean) => void;
  setTheme: (theme: UiTheme) => void;
  setDraft: (text: string, sessionId: string) => void;
  clearDraft: (sessionId: string) => void;
  /** 发送后清除当前会话草稿与未建会话的 pending 草稿，且不再写入 localStorage。 */
  clearSentDrafts: (sessionId?: string | null) => void;
  setBusy: (v: boolean) => void;
  setKeepAllBusy: (v: boolean) => void;
  openSettings: (tab: TabId) => void;
}

export const DRAFTS_STORAGE_KEY = "owncoder:ui:drafts";
/** 无活跃会话时（例如刚点「新会话」或删光会话）输入框草稿的存储键。 */
export const PENDING_DRAFT_KEY = "__pending__";

/**
 * Composer 读写草稿使用的键，必须与 onSend 读取逻辑一致。
 *
 * - pending 新会话（尚未 createPendingSession）或没有 activeSessionId 时，
 *   一律走 PENDING_DRAFT_KEY，避免 focus 分叉时写入 A、发送读 B/空。
 * - 有明确会话且非 pending 时，按 sessionId 隔离草稿。
 */
export function getComposerDraftKey(
  activeSessionId: string | null | undefined,
  pendingNewSession = false,
): string {
  if (pendingNewSession || !activeSessionId) return PENDING_DRAFT_KEY;
  return activeSessionId;
}

/**
 * 发送时解析输入框文本。UI 可能把草稿写在 session 键或 pending 键上
 * （activeSessionId 与 chat focus 短暂分叉、pending 新会话等），
 * 任一键有内容都视为可发送，避免「框里有字、点发送却静默 return」。
 */
export function resolveComposerDraftText(
  drafts: Record<string, string>,
  sessionId: string | null | undefined,
  pendingNewSession = false,
): string {
  const sessionText = sessionId ? (drafts[sessionId] ?? "") : "";
  const pendingText = drafts[PENDING_DRAFT_KEY] ?? "";
  // pending 新会话优先 pending 键（与 Composer 展示一致）；否则先 session 再 pending。
  const raw = pendingNewSession
    ? (pendingText || sessionText)
    : (sessionText || pendingText);
  return raw.trim();
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 从 localStorage 加载已持久化的草稿（关闭后再打开时恢复未发送内容）。 */
export function loadDrafts(): Record<string, string> {
  try {
    const raw = getLocalStorage()?.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 将未发送草稿写入 localStorage；空内容不保留。 */
function saveDrafts(drafts: Record<string, string>): void {
  try {
    const storage = getLocalStorage();
    if (!storage) return;
    const entries = Object.entries(drafts).filter(([, v]) => v);
    if (entries.length === 0) {
      storage.removeItem(DRAFTS_STORAGE_KEY);
      return;
    }
    storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* quota exceeded etc. — fail silently */ }
}

function omitDraft(drafts: Record<string, string>, sessionId: string): Record<string, string> {
  if (!(sessionId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[sessionId];
  return next;
}

export const useUiStore = create<UiState & UiActions>()((set) => ({
  editorTabs: [],
  editorPath: null,
  chatWidth: 20,
  isDragging: false,
  sidebarWidth: 260,
  isSidebarDragging: false,
  sidebarCollapsed: false,
  settingsOpen: false,
  settingsTab: "harness",
  searchOpen: false,
  modeMenuOpen: false,
  theme: readStoredTheme(),
  drafts: loadDrafts(),
  busy: false,
  keepAllBusy: false,

  setEditorPath: (path) =>
    set((s) => {
      if (path === null) return { editorTabs: [], editorPath: null };
      if (s.editorPath === path) return s;
      if (s.editorTabs.includes(path)) return { editorPath: path };
      return { editorTabs: [...s.editorTabs, path], editorPath: path };
    }),
  setActiveEditorTab: (path) =>
    set((s) => (s.editorTabs.includes(path) ? { editorPath: path } : s)),
  closeEditorTab: (path) =>
    set((s) => {
      const idx = s.editorTabs.indexOf(path);
      if (idx < 0) return s;
      const editorTabs = s.editorTabs.filter((p) => p !== path);
      if (s.editorPath !== path) return { editorTabs };
      const next =
        editorTabs[Math.min(idx, editorTabs.length - 1)] ?? null;
      return { editorTabs, editorPath: next };
    }),
  setChatWidth: (chatWidth) => set({ chatWidth }),
  setIsDragging: (isDragging) => set({ isDragging }),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  setIsSidebarDragging: (isSidebarDragging) => set({ isSidebarDragging }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setModeMenuOpen: (modeMenuOpen) => set({ modeMenuOpen }),
  setTheme: (theme) => {
    applyThemeToDocument(theme);
    persistTheme(theme);
    syncNativeChrome(theme);
    set({ theme });
  },
  setDraft: (draft, sessionId) => {
    set((s) => {
      // 空字符串视为清除：发送后不得再保留，关闭重开也不会恢复。
      const next = draft ? { ...s.drafts, [sessionId]: draft } : omitDraft(s.drafts, sessionId);
      saveDrafts(next);
      return { drafts: next };
    });
  },
  /** 清除指定会话的草稿（会话删除时调用） */
  clearDraft: (sessionId: string) => {
    set((s) => {
      const next = omitDraft(s.drafts, sessionId);
      saveDrafts(next);
      return { drafts: next };
    });
  },
  clearSentDrafts: (sessionId) => {
    set((s) => {
      let next = omitDraft(s.drafts, PENDING_DRAFT_KEY);
      if (sessionId) next = omitDraft(next, sessionId);
      saveDrafts(next);
      return { drafts: next };
    });
  },
  setBusy: (busy) => set({ busy }),
  setKeepAllBusy: (keepAllBusy) => set({ keepAllBusy }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab }),
}));
