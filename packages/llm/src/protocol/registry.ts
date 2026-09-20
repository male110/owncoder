import type { ApiFormat, ProtocolCodec } from "./types.js";
import { openaiChatCodec } from "./openai-chat.js";
import { anthropicMessagesCodec } from "./anthropic-messages.js";

const CODECS: Record<ApiFormat, ProtocolCodec> = {
  "openai-chat": openaiChatCodec,
  "anthropic-messages": anthropicMessagesCodec,
};

export function getCodec(format: ApiFormat): ProtocolCodec {
  const codec = CODECS[format];
  if (!codec) {
    throw new Error(`Unknown API format: ${String(format)}`);
  }
  return codec;
}

export function listCodecs(): ProtocolCodec[] {
  return Object.values(CODECS);
}
