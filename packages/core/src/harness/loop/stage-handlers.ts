/**
 * Legacy re-export from stage-handlers/index.ts
 * 
 * This file now simply re-exports everything from the modularized stage-handlers
 * directory to maintain backward compatibility with existing imports.
 * 
 * All implementation has been split into:
 * - stage-handlers/types.ts - Shared type definitions
 * - stage-handlers/history.ts - History management (~400 lines)
 * - stage-handlers/task-decompose.ts - Task decomposition (~750 lines)
 * - stage-handlers/tools.ts - Tool execution (~150 lines)
 * - stage-handlers/verify.ts - Verification (~100 lines)
 * - stage-handlers/index.ts - Core coordinator + registry (~200 lines)
 */

export * from "./stage-handlers/index.ts";
