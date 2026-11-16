import type { BrowserWindow } from "electron";

/** Return true when an existing plan window was raised rather than recreated. */
export function focusExistingPlanWindow(windows: Map<string, BrowserWindow>, key: string): boolean {
  const existing = windows.get(key);
  if (!existing || existing.isDestroyed()) return false;
  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
  return true;
}
