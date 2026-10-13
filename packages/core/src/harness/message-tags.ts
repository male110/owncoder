/**
 * Message tagging utilities for structured prompt composition.
 * 
 * Using XML tags to clearly demarcate different types of content helps LLMs:
 * - Distinguish system instructions from user input
 * - Understand context hierarchy and priority
 * - Resist prompt injection attacks
 * - Process information more accurately
 * 
 * Tags are added at runtime during message composition, not in the prompt files.
 */

/**
 * Wrap content with XML-style tags to mark its semantic role.
 * Empty content returns empty string (tag pair is omitted).
 */
export function wrapWithTag(tag: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return `<${tag}>\n${trimmed}\n</${tag}>`;
}

/**
 * Core system instructions (highest priority, immutable by user).
 * This is the base prompt (BUILTIN_PLAN_PROMPT or BUILTIN_AGENT_PROMPT).
 */
export function tagSystemInstructions(content: string): string {
  return wrapWithTag("", content);
}

/**
 * Project-specific context: rules, preferences, tech stack, repo info.
 * Semi-stable background information.
 */
export function tagProjectContext(content: string): string {
  return wrapWithTag("project_context", content);
}

/**
 * Conversation history from previous turns.
 * Variable, defers to current_task and user_input when conflicting.
 */
export function tagConversationHistory(content: string): string {
  return wrapWithTag("conversation_history", content);
}

/**
 * Current active task or plan step being executed.
 * High priority, takes precedence over conversation_history.
 */
export function tagCurrentTask(content: string): string {
  return wrapWithTag("current_task", content);
}

/**
 * User's latest explicit input or request.
 * HIGHEST PRIORITY - overrides everything except system_instructions.
 */
export function tagUserInput(content: string): string {
  return wrapWithTag("user_input", content);
}

/**
 * Injected code snippets, file contents, or other reference material.
 * Reference only, never overrides user instructions.
 */
export function tagInjectedContext(content: string): string {
  return wrapWithTag("injected_context", content);
}

/**
 * Tool execution results or observations.
 */
export function tagToolResult(content: string, tool?: string): string {
  const attr = tool ? ` tool="${tool}"` : "";
  const trimmed = content.trim();
  if (!trimmed) return "";
  return `<tool_result${attr}>\n${trimmed}\n</tool_result>`;
}

/**
 * Memory or working state from previous interactions.
 */
export function tagMemory(content: string): string {
  return wrapWithTag("memory", content);
}

/**
 * Platform information (OS, environment, capabilities).
 */
export function tagPlatformInfo(content: string): string {
  return wrapWithTag("platform_info", content);
}

/**
 * Verification results or test outputs.
 */
export function tagVerificationResult(content: string): string {
  return wrapWithTag("verification_result", content);
}

/**
 * Build multiple tagged sections into a single string.
 * Automatically filters out empty sections.
 */
export function buildTaggedMessage(...sections: string[]): string {
  return sections.filter(s => s.trim()).join("\n\n");
}


