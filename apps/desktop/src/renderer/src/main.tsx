import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary";
import { applyThemeToDocument, readStoredTheme, syncNativeChrome } from "./theme";
import { initLocale, setLocalePref } from "./i18n";
import { t, type LocalePref } from "../../shared/i18n/core";
import "./styles.css";

const bootTheme = readStoredTheme();
applyThemeToDocument(bootTheme);
syncNativeChrome(bootTheme);
initLocale();
// Prefer persisted settings language over the localStorage-only UI pref.
void window.owncoder?.getSettings?.()
  .then((snap) => {
    setLocalePref((snap.effective.harness.locale ?? "system") as LocalePref);
  })
  .catch(() => {
    /* preload / settings unavailable — keep initLocale result */
  });

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

window.addEventListener("error", (event) => {
  console.error("[renderer:window-error]", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer:unhandled-rejection]", event.reason);
});

createRoot(root).render(
  <StrictMode>
    <RenderErrorBoundary
      scope="app"
      fallback={(error) => (
        <main style={{ padding: 24, color: "var(--error)", fontFamily: "system-ui, sans-serif" }}>
          <h1>{t("界面发生错误")}</h1>
          <p>{t("应用没有退出。请重新加载界面；错误详情已记录到主进程日志。")}</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{error.message}</pre>
          <button type="button" onClick={() => window.location.reload()}>{t("重新加载")}</button>
        </main>
      )}
    >
      <App />
    </RenderErrorBoundary>
  </StrictMode>,
);
