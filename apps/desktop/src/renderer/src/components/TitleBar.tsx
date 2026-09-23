import { useEffect, useState } from "react";
import { useUiStore } from "../store/ui-store";
import type { UiTheme } from "../theme";
import { useI18n } from "../i18n";

interface Props {
  title?: string | null;
  gitSummary?: string | null;
  gitDirty?: boolean;
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12.2 2.1a1 1 0 0 1 .95 1.32 8.2 8.2 0 1 0 7.43 7.43 1 1 0 0 1 1.32.95A10.2 10.2 0 1 1 12.2 2.1Z"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0-5a1 1 0 0 1 1 1V5a1 1 0 1 1-2 0V3.5a1 1 0 0 1 1-1Zm0 15a1 1 0 0 1 1 1V22a1 1 0 1 1-2 0v-1.5a1 1 0 0 1 1-1Zm9.5-6.5a1 1 0 0 1-1 1H19a1 1 0 1 1 0-2h1.5a1 1 0 0 1 1 1ZM5 12a1 1 0 0 1-1 1H2.5a1 1 0 1 1 0-2H4a1 1 0 0 1 1 1Zm12.95 6.45a1 1 0 0 1-1.4 0l-1.1-1.1a1 1 0 1 1 1.4-1.4l1.1 1.1a1 1 0 0 1 0 1.4ZM8.55 8.55a1 1 0 0 1-1.4 0L6.05 7.45a1 1 0 0 1 1.4-1.4l1.1 1.1a1 1 0 0 1 0 1.4Zm0 8.9a1 1 0 0 1 0 1.4l-1.1 1.1a1 1 0 1 1-1.4-1.4l1.1-1.1a1 1 0 0 1 1.4 0Zm9.9-9.9a1 1 0 0 1 0 1.4l-1.1 1.1a1 1 0 1 1-1.4-1.4l1.1-1.1a1 1 0 0 1 1.4 0Z"
      />
    </svg>
  );
}

/** Frameless window drag strip — matches workspace chrome. */
export function TitleBar({ title, gitSummary, gitDirty }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const { t } = useI18n();

  useEffect(() => {
    let disposed = false;
    // preload 未注入时 window.owncoder 为 undefined，避免装饰性版本号拖垮标题栏
    void window.owncoder?.getAppVersion()
      .then((v) => {
        if (!disposed) setVersion(v);
      })
      .catch(() => {
        /* Version is decorative; leave it hidden if the lookup fails. */
      });
    return () => {
      disposed = true;
    };
  }, []);

  const selectTheme = (next: UiTheme) => {
    if (next === theme) return;
    setTheme(next);
  };

  return (
    <div className="app-titlebar">
      <div className="app-titlebar-left">
        <span className="app-titlebar-mark">A</span>
        <span className="app-titlebar-name">OwnCoder</span>
        {version ? (
          <>
            <span className="app-titlebar-sep">·</span>
            <span className="app-titlebar-version">v{version}</span>
          </>
        ) : null}
        {title ? (
          <>
            <span className="app-titlebar-sep">·</span>
            <span className="app-titlebar-session">{title}</span>
          </>
        ) : null}
        {gitSummary ? (
          <>
            <span className="app-titlebar-sep">·</span>
            <span className={gitDirty ? "app-titlebar-git dirty" : "app-titlebar-git"}>
              {gitSummary}
            </span>
          </>
        ) : null}
      </div>
      <div className="app-titlebar-actions" role="group" aria-label={t("界面风格")}>
        <div className="app-theme-toggle">
          <button
            type="button"
            className={`app-theme-btn${theme === "dark" ? " active" : ""}`}
            title={t("深色主题")}
            aria-label={t("切换到深色主题")}
            aria-pressed={theme === "dark"}
            onClick={() => selectTheme("dark")}
          >
            <MoonIcon />
          </button>
          <button
            type="button"
            className={`app-theme-btn${theme === "codex" ? " active" : ""}`}
            title={t("浅色主题")}
            aria-label={t("切换到浅色主题")}
            aria-pressed={theme === "codex"}
            onClick={() => selectTheme("codex")}
          >
            <SunIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
