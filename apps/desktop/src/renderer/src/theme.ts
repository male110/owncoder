/** UI chrome theme: dark (default) or muted professional light. */
export type UiTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "owncoder:ui:theme";

export function isUiTheme(value: unknown): value is UiTheme {
  return value === "dark" || value === "light";
}

export function readStoredTheme(): UiTheme {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isUiTheme(raw) ? raw : "dark";
  } catch {
    return "dark";
  }
}

export function persistTheme(theme: UiTheme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* quota / private mode — ignore */
  }
}

/** Apply theme tokens to <html> before/while React paints. */
export function applyThemeToDocument(theme: UiTheme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme === "light" ? "light" : "dark";
}

export function syncNativeChrome(theme: UiTheme): void {
  void window.owncoder?.setChromeTheme?.(theme);
}
