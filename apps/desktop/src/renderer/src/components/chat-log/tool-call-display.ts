export function stripToolCallBlocks(content: string): string {
  return content.replace(/<tool_call>\s*[\s\S]*?<\/tool_call>/g, "");
}
