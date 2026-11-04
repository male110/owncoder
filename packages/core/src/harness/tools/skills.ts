import { expandSkillVariables, type SkillContent } from "../../skills.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { fail, ok } from "./shared.ts";

/**
 * `use_skill` — load a skill's SKILL.md body into the conversation.
 *
 * The body is wrapped in `<skill_content>` so the model can distinguish
 * loaded skill instructions from other tool output, and is preceded by the
 * skill's base directory so relative resource references (scripts/,
 * references/) can be resolved with read_file / bash.
 */
export async function toolUseSkill(
  ctx: ToolContext,
  skill: string,
  args: string,
): Promise<ToolResult> {
  const api = ctx.skills;
  if (!api) {
    return fail("use_skill is unavailable in this session (no skills API injected).");
  }
  const name = skill.trim();
  if (!name) {
    return fail('use_skill 参数错误：必须提供非空字符串 skill，例如 {"skill":"code-review"}。');
  }
  let loaded: SkillContent | null;
  try {
    loaded = await api.loadSkill(name);
  } catch (e) {
    return fail(`Failed to load skill "${name}": ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!loaded) {
    const available = await api.listNames();
    const hint = available.length
      ? ` Available skills: ${available.join(", ")}.`
      : " No skills are available in this workspace.";
    return fail(`Skill "${name}" not found or not enabled.${hint}`);
  }

  const meta = loaded.metadata;
  const body = expandSkillVariables(loaded.content, loaded.baseDirectory);
  const lines = [
    `<skill_content name="${meta.name}">`,
    `# Skill: ${meta.name}`,
    "",
    body.trim(),
    "",
  ];
  if (loaded.baseDirectory) {
    lines.push(`Base directory for this skill: ${loaded.baseDirectory}`);
    lines.push("Relative paths in this skill (scripts, references, assets) are relative to this base directory.");
  }
  if (args) {
    lines.push(`Arguments from the user: ${args}`);
  }
  if (loaded.truncated) {
    lines.push("[Skill content truncated — the full SKILL.md exceeds the size limit]");
  }
  lines.push("</skill_content>");
  return ok(lines.join("\n"));
}
