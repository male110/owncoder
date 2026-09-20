/**
 * Compatibility Adapter facade over `SessionOrchestrator`.
 *
 * `CompatibilityAdapter` is a type alias for `SessionOrchestrator`.
 * `createCompatibilityAdapter()` is a thin re-export of `createSession()`.
 */
import { SessionOrchestrator, createSession } from "./index.ts";

export const COMPATIBILITY_ADAPTER_MODULE_ID = "compatibility-adapter" as const;

export type CompatibilityAdapter = SessionOrchestrator;

export function createCompatibilityAdapter(): CompatibilityAdapter {
  return createSession();
}
