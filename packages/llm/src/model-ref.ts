import type { ApiFormat } from "./protocol/types.js";

/** Model reference for LLM calls */
export type ModelRef = {
  baseUrl: string;
  apiKeyEnv?: string;
  model: string;
  providerId?: string;
  apiKey?: string;
  /** Wire format. Missing values resolve to openai-chat (or official Anthropic host). */
  apiFormat?: ApiFormat;
};
