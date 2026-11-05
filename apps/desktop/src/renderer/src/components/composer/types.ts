import type { AgentMode } from "@owncoder/shared";
import type { AvailableModel, Provider, ThinkingEffort } from "@owncoder/settings";
import type { ChatAttachmentDto, GitStatusDto, ProjectDto } from "../../../../preload/index";

/**
 * Composer 对外 Props。拆分自 components/Composer.tsx，字段与顺序保持不变，
 * App.tsx 的调用无需任何改动。
 */
export interface ComposerProps {
  mode: AgentMode;
  activeSessionId: string | null;
  draft: string;
  sending: boolean;
  modelLabel: string;
  availableModels: AvailableModel[];
  providers: Provider[];
  thinkingEffort: ThinkingEffort;

  /** 执行阶段单独配置 */
  separateStageModels: boolean;
  reactModelId: string | null;
  reactProviderId: string | null;
  reactThinkingEffort: ThinkingEffort;

  workspaceName: string | null;
  workspaceRoot: string | null;
  projects: ProjectDto[];
  gitStatus: GitStatusDto | null;
  isEmptySession: boolean;
  pendingNewSession: boolean;
  modeMenuOpen: boolean;
  onDraft: (v: string) => void;
  onSend: (attachments?: ChatAttachmentDto[]) => void;
  onCancel: () => void;
  onNewSession: () => void;
  onMode: (mode: AgentMode) => void;
  onModeMenuOpen: (open: boolean) => void;
  onSelectModel: (modelId: string, providerId: string) => void;
  onOpenSettings: () => void;
  onSelectThinkingEffort: (effort: ThinkingEffort) => void;
  onSelectProject: (root: string, focusSessionId?: string) => Promise<void>;
  onAddProject: () => void;
  onSelectReactModel: (modelName: string, providerId: string) => void;
  onSelectReactThinkingEffort: (effort: ThinkingEffort) => void;
}

export interface AttachmentItem {
  file: File;
  status: "uploading" | "error" | "success";
  result?: ChatAttachmentDto;
  error?: string;
}

export interface CtxMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}
