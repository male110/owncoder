export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolDef {
  type: "function";
  /**
   * True when this tool never mutates the workspace and runs no side-effectful
   * command. The ReAct loop derives its read-only (exploration) guard from
   * this flag — see READONLY_TOOLS in harness/enhanced-tools.ts — so keep it
   * accurate when adding tools.
   */
  readOnly?: boolean;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatAttachment {
  name: string;
  mimeType: string;
  url: string;
  size?: number;
}

export interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  attachments?: ChatAttachment[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** 工具执行失败；由支持错误标记的协议映射到原生字段。 */
  is_error?: boolean;
  name?: string;
}
export interface ChatChoiceMessage {
  role: "assistant";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface ChatResponse {
  id?: string;
  usage?: ChatUsage;
  choices: Array<{
    message: ChatChoiceMessage;
    finish_reason?: string | null;
  }>;
}
