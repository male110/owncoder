import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary";
import { applyThemeToDocument, readStoredTheme, syncNativeChrome } from "./theme";
import "./styles.css";

const bootTheme = readStoredTheme();
applyThemeToDocument(bootTheme);
syncNativeChrome(bootTheme);

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
          <h1>界面发生错误</h1>
          <p>应用没有退出。请重新加载界面；错误详情已记录到主进程日志。</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{error.message}</pre>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </main>
      )}
    >
      <App />
    </RenderErrorBoundary>
  </StrictMode>,
);
