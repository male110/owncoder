/**
 * Browser / renderer-safe surface of @owncoder/llm.
 * No node:fs / node:path — safe to import from renderer or shared packages
 * that are also bundled into the desktop renderer.
 */
export type { ModelRef } from "./model-ref.js";
export type { ThinkingConfig, ThinkingEffort } from "./thinking.js";
export type { ApiFormat } from "./protocol/types.js";
export { API_FORMATS, isApiFormat } from "./protocol/types.js";
export { resolveApiFormat, isOfficialAnthropicHost } from "./protocol/resolve.js";
