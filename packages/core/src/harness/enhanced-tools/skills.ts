import type { ToolDef } from "@owncoder/llm";

// ── Skill tool ─────────────────────────────────────────────────────────
//
// Skills are discovered from .owncoder/skills (project), the user skills dir
// and the bundled set; their names/descriptions are injected into the system
// prompt by buildInitialContext. This tool is the on-demand body loader:
// calling it is what actually brings a skill's instructions into context.

export const USE_SKILL_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "use_skill",
    description:
      "Load a skill's instructions into the conversation. Skills are listed in the 'Available skills' " +
      "section of the system prompt. When the user's task matches a skill's description — or the user " +
      "message starts with `/<skill-name>` — call this tool with that skill name BEFORE doing the task, " +
      "then follow the loaded instructions. This is a blocking requirement when a matching skill exists. " +
      "Only use skill names that appear in the available-skills list; do not guess names.",
    parameters: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description:
            "The name of the skill to load, exactly as listed in the available-skills section (e.g. 'code-review').",
        },
        args: {
          type: "string",
          description: "Optional arguments from the user, forwarded to the skill (optional).",
        },
      },
      required: ["skill"],
    },
  },
};
