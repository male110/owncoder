/**
 * Shared context injected into every IPC controller.
 * Controllers only hold a reference to this bag — they never import each other.
 */
import type { BrowserWindow } from "electron";
import type { CompatibilityAdapter } from "@owncoder/core";
import type { SettingsStore } from "../settings-store";
import type { RecentStore } from "../recent-store";
import type { SecretsStore } from "../secrets-store";

export interface IpcContext {
  getWindow: () => BrowserWindow | null;
  /**
   * True only while the main window's render frame can actually receive push
   * events. Tracked from webContents lifecycle events (a failed reload leaves
   * the webContents alive but its frame disposed). Push channels must gate on
   * this - see renderer-send.ts.
   */
  isRendererReady: () => boolean;
  /** Foreground multi-session orchestrator. */
  session: CompatibilityAdapter;
  settingsStore: SettingsStore;
  recentStore: RecentStore;
  secretsStore: SecretsStore;
  /** Open (or reopen) a workspace root; returns workspace info or null. */
  openWorkspaceRoot: (root: string) => Promise<{ root: string; name: string } | null>;
  /** 轻量级切换工作区，不清理会话；返回 workspace info 或 null。 */
  switchWorkspaceRoot: (root: string) => Promise<{ root: string; name: string } | null>;
  /** Resolve a user-supplied relative path within the workspace, throwing on escape. */
  resolveWorkspacePath: (root: string, inputPath: string) => string;
  chatBuffer?: {
    removeSession: (sessionId: string | null) => void;
    flushAll: () => void;
  };
  chatBufferRef?: {
    removeSession: (sessionId: string | null) => void;
    flushAll: () => void;
  };
}
