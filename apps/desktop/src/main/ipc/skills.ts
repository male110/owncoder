/**
 * IPC handlers: skill (技能) management for the settings UI.
 *
 * Skill files live on disk (project `.owncoder/skills/` + the user-level
 * skills dir); the orchestrator owns discovery, the system-prompt catalog and
 * the `use_skill` tool. These handlers expose just enough for the settings
 * page: list / read raw / write / delete / toggle enabled.
 */
import { ipcMain } from "electron";
import type { IpcContext } from "./types";

export interface SkillWriteInputDto {
  scope: "project" | "user";
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  /** Full SKILL.md document (frontmatter included); takes precedence over the structured fields. */
  raw?: string;
}

export function registerSkillsHandlers(ctx: IpcContext): void {
  const { session, settingsStore } = ctx;

  ipcMain.handle("skills:list", () => session.listSkills());

  ipcMain.handle("skills:read", (_e, name: string) => session.readSkillRaw(name));

  ipcMain.handle("skills:write", async (_e, input: SkillWriteInputDto) => {
    await session.writeSkill(input);
    return session.listSkills();
  });

  ipcMain.handle("skills:delete", async (_e, name: string) => {
    await session.deleteSkill(name);
    return session.listSkills();
  });

  ipcMain.handle("skills:setEnabled", async (_e, id: string, enabled: boolean) => {
    const effective = settingsStore.getEffective();
    const disabled = [...(effective.skills?.disabled ?? [])];
    const idx = disabled.indexOf(id);
    if (!enabled && idx === -1) disabled.push(id);
    if (enabled && idx !== -1) disabled.splice(idx, 1);
    const next = {
      ...effective,
      skills: { enabled: true, disabled },
    };
    const saved = settingsStore.saveEffectiveAsUser(next);
    // Propagates to the orchestrator, which rebuilds the skills catalog
    // (setWorkflow hook) so the change takes effect on the next turn.
    session.setWorkflow(saved);
    return session.listSkills();
  });
}
