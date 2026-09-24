export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolDef {
  type: "function";
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
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
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
