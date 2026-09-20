/**
 * Central registration point for all IPC controllers.
 * Call registerAllHandlers() once after the app is ready.
 */
import { registerWorkspaceHandlers } from "./workspace";
import { registerSessionHandlers } from "./session";
import { registerChatHandlers } from "./chat";
import { registerSettingsHandlers } from "./settings";
import { registerTerminalHandlers } from "./terminal";
import { registerIndexHandlers } from "./index-ipc";
import { registerUpdateHandlers } from "./updates";
import type { IpcContext } from "./types";

export { type IpcContext };

export function registerAllHandlers(ctx: IpcContext): void {
  registerWorkspaceHandlers(ctx);
  registerSessionHandlers(ctx);
  registerChatHandlers(ctx);
  registerSettingsHandlers(ctx);
  registerTerminalHandlers(ctx);
  registerIndexHandlers(ctx);
  registerUpdateHandlers(ctx);
}
