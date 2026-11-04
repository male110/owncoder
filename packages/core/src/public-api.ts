/**
 * 包级公共 API 转发。
 *
 * 从 index.ts 拆分的纯 re-export 桶：@owncoder/core 对外暴露的类型与工具
 * 函数原本散落在 index.ts 顶部的 export 块中，现集中于此；SessionOrchestrator
 * 本身仍在 index.ts 定义并经 `export *` 合并导出，对外 API 面保持不变。
 */
export {
  applyTaskEvent,
  canReportSuccess,
  createTaskRunMetrics,
  createTaskRunState,
  finalizeTaskSuccess,
  formatVerificationFailureNotice,
  normalizeTaskRunMetrics,
  normalizeVerificationResult,
  restoreTaskRunState,
  sealTaskRunSuccess,
  taskRunMetricsSnapshot,
  taskRunPhaseLabel,
  taskRunTotalDurationMs,
  verificationStatus,
  type TaskEvent,
  type TaskRunMetrics,
  type TaskRunPhase,
  type TaskRunState,
  type VerificationCheck,
  type VerificationError,
  type VerificationResult,
  type VerificationStatus,
} from "./task-run.ts";
export type { TurnEvent, TurnEventInput } from "./harness/loop.ts";
export { stampTurnEvent } from "./harness/loop.ts";
export type {
  AgentLoopOpts,
  HistoryChunk,
  HistoryChunkInput,
  HistorySearchHit,
  EmbeddingService,
  HistoryVectorStore,
  HistoryRoundInput,
} from "./harness/loop.ts";
export {
  archiveTurn,
  computeContentHash,
  comparableHistoryText,
  historyTextSimilarity,
  dedupeSimilarHistoryHits,
  finalizeRecalledHistoryHits,
  HISTORY_MIN_RELEVANCE_SCORE,
  HISTORY_NEAR_DUPLICATE_THRESHOLD,
} from "./harness/loop.ts";
export { isRedactionEnabled, isSensitiveFile, redactSecrets } from "./harness/redact.ts";
export type { SessionState } from "./session-runtime.ts";
export { listSessionMetas } from "./session-store.ts";
export {
  COMPATIBILITY_ADAPTER_MODULE_ID,
  createCompatibilityAdapter,
  type CompatibilityAdapter,
} from "./compatibility-adapter.ts";
export { installLspsForFileTypes } from "./harness/lsp-client.ts";
export {
  buildSkillsCatalogSection,
  DEFAULT_MAX_SKILL_BYTES,
  deleteSkillDir,
  discoverSkills,
  expandSkillVariables,
  formatSkillFile,
  loadSkillContent,
  parseSkillMarkdown,
  readSkillRaw,
  scanSkillsDir,
  SKILLS_DIR,
  SKILL_FILE_NAME,
  skillId,
  validateSkillName,
  writeSkillFiles,
  writeSkillRaw,
  type BundledSkill,
  type SkillContent,
  type SkillDiscoveryResult,
  type SkillFrontmatter,
  type SkillMetadata,
  type SkillScope,
  type SkillSource,
  type SkillWriteInput,
} from "./skills.ts";
export { BUNDLED_SKILLS } from "./skills-bundled.ts";
