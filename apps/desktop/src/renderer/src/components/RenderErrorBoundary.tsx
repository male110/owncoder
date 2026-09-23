import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../../../shared/i18n/core";

type FallbackRenderer = (error: Error, reset: () => void) => ReactNode;

interface Props {
  children: ReactNode;
  /** Reset the boundary when the guarded view changes (for example, a settings tab). */
  resetKey?: string | number | boolean | null;
  scope: string;
  fallback?: FallbackRenderer;
}

interface State {
  error: Error | null;
}

/**
 * Keeps an exception in an optional renderer feature from unmounting the whole
 * Electron UI. The error is also written to the renderer console, which the
 * main process records for production diagnosis.
 */
export class RenderErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[renderer:${this.props.scope}]`, error, info.componentStack);
  }

  componentDidUpdate(previousProps: Props): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <section
        role="alert"
        style={{
          margin: 24,
          padding: 18,
          border: "1px solid #7e3d3d",
          borderRadius: 8,
          color: "#f0d4d4",
          background: "#1a1012",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <strong>{t("此区域发生错误，已阻止它影响整个应用。")}</strong>
        <pre style={{ whiteSpace: "pre-wrap", margin: "12px 0" }}>{error.message}</pre>
        <button type="button" onClick={this.reset}>{t("重试")}</button>
      </section>
    );
  }
}
