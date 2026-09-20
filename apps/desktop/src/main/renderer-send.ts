/**
 * Central gate for main -> renderer push channels (chat:event, pty:data, ...).
 *
 * A disposed render frame (window closed, renderer crashed, or a navigation
 * whose new document failed to load or is still loading) cannot receive
 * messages. Electron logs every WebFrameMain.send into such a frame as
 * "Error sending from webFrameMain: Render frame was disposed..." from inside
 * its own wrapper - the caller's try/catch cannot suppress it - so the only
 * fix is to not send at all.
 *
 * isDestroyed()/isCrashed() alone are not sufficient: after a failed reload
 * the webContents is neither destroyed nor crashed, yet its main frame is
 * gone. Readiness is therefore tracked from webContents lifecycle events in
 * main/index.ts (did-start-loading / dom-ready / did-fail-load /
 * render-process-gone) and injected here as `isRendererReady`.
 */
import type { BrowserWindow } from "electron";

export interface RendererSink {
  getWindow: () => BrowserWindow | null;
  /** False while the main frame is dead or a load is in flight. */
  isRendererReady: () => boolean;
}

/** Send a push-style IPC message; silently drop it when the frame cannot receive it. */
export function sendToRenderer(sink: RendererSink, channel: string, payload: unknown): void {
  const win = sink.getWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
  if (!sink.isRendererReady()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* lost the race between the checks above and the send - drop the event */
  }
}
