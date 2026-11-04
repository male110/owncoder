import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSession } from "./index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Create an orchestrator whose user-level skills dir is a fresh temp dir. */
async function withTempSkills<T>(run: (session: ReturnType<typeof createSession>, skillsRoot: string) => Promise<T>): Promise<T> {
  const userDir = await mkdtemp(join(tmpdir(), "owncoder-skills-"));
  try {
    const skillsRoot = join(userDir, "skills");
    const session = createSession();
    session.setSkillsUserDir(skillsRoot);
    await sleep(200);
    return await run(session, skillsRoot);
  } finally {
    await rm(userDir, { recursive: true, force: true });
  }
}

describe("orchestrator skills wiring", () => {
  it("discovers user skills and bundled skills, and builds the catalog", async () => {
    await withTempSkills(async (session, skillsRoot) => {
      await mkdir(join(skillsRoot, "deploy-checklist"), { recursive: true });
      await writeFile(
        join(skillsRoot, "deploy-checklist", "SKILL.md"),
        "---\nname: deploy-checklist\ndescription: Use when deploying or releasing the app\nwhen_to_use: only for release tasks\n---\n\nRun these steps:\n1. build\n2. test\nReference ${OWNCODER_SKILL_DIR}/run.sh",
      );
      await session.reloadProjectSkills();

      const listed = await session.listSkills();
      const listedIds = listed.map((s) => `${s.id}:${s.enabled ? "on" : "off"}`);
      expect(listedIds).toContain("system:code-review:on");
      expect(listedIds).toContain("system:install-skill:on");
      expect(listedIds).toContain("user:deploy-checklist:on");

      const catalog = session.getSkillsCatalogText();
      expect(catalog).toContain("## Available skills");
      expect(catalog).toContain("deploy-checklist");
      expect(catalog).toContain("install-skill");
      // Catalog header carries the absolute install directories (no workspace open:
      // only the user dir is printed).
      expect(catalog).toContain(`Skill install directories — user: ${skillsRoot}`);

      const loaded = await session.getSkillsApi().loadSkill("deploy-checklist");
      expect(loaded?.metadata.id).toBe("user:deploy-checklist");
      // Variable expansion happens in the use_skill tool layer, not here.
      expect(loaded?.content).toContain("Reference ${OWNCODER_SKILL_DIR}/run.sh");
      expect(loaded?.baseDirectory).toBe(join(skillsRoot, "deploy-checklist"));
      expect((await session.getSkillsApi().listNames()).sort()).toEqual([
        "code-review",
        "deploy-checklist",
        "install-skill",
      ]);
      expect(await session.getSkillsApi().loadSkill("nope")).toBeNull();
    });
  });

  it("respects the disabled list and the global kill switch", async () => {
    await withTempSkills(async (session, skillsRoot) => {
      await mkdir(join(skillsRoot, "hello"), { recursive: true });
      await writeFile(join(skillsRoot, "hello", "SKILL.md"), "---\nname: hello\ndescription: hi\n---\nbody");
      await session.reloadProjectSkills();
      const wf = session.getState().workflow;

      session.setWorkflow({ ...wf, skills: { enabled: true, disabled: ["user:hello"] } });
      await sleep(200);
      expect(session.getSkillsCatalogText()).not.toContain("- hello");
      expect(await session.getSkillsApi().loadSkill("hello")).toBeNull();
      // Bundled skills are unaffected by the per-skill disable.
      expect(session.getSkillsCatalogText()).toContain("install-skill");

      session.setWorkflow({ ...wf, skills: { enabled: false, disabled: [] } });
      await sleep(200);
      expect(session.getSkillsCatalogText()).toBe("");
      expect(await session.listSkills()).toEqual([]);
    });
  });

  it("picks up skill files written after the last scan (loadSkill fallback)", async () => {
    await withTempSkills(async (session, skillsRoot) => {
      // An agent writes a brand-new skill straight to disk (install-skill flow).
      await mkdir(join(skillsRoot, "brand-new"), { recursive: true });
      await writeFile(
        join(skillsRoot, "brand-new", "SKILL.md"),
        "---\nname: brand-new\ndescription: just installed\n---\nnew body",
      );
      // The cached catalog is still stale…
      expect(session.getSkillsCatalogText()).not.toContain("brand-new");
      // …but the loadSkill cache miss triggers a re-scan, so use_skill works
      // immediately and the catalog is refreshed for later turns.
      const fresh = await session.getSkillsApi().loadSkill("brand-new");
      expect(fresh?.metadata.id).toBe("user:brand-new");
      expect(fresh?.content.trim()).toBe("new body");
      expect(session.getSkillsCatalogText()).toContain("brand-new");
      expect(await session.getSkillsApi().loadSkill("brand-new")).not.toBeNull();
    });
  });

  it("writes, reads and deletes skills via the IPC-facing methods", async () => {
    await withTempSkills(async (session) => {
      await session.writeSkill({
        scope: "user",
        name: "smoke-skill",
        description: "created by test",
        body: "smoke body",
      });
      let after = await session.listSkills();
      expect(after.map((s) => s.name)).toContain("smoke-skill");
      expect(after.find((s) => s.name === "smoke-skill")?.scope).toBe("user");

      const detail = await session.readSkillRaw("smoke-skill");
      expect(detail.raw).toContain("name: smoke-skill");
      expect(detail.raw).toContain("smoke body");

      await session.deleteSkill("smoke-skill");
      after = await session.listSkills();
      expect(after.map((s) => s.name)).not.toContain("smoke-skill");

      // Bundled skills refuse management.
      await expect(session.deleteSkill("code-review")).rejects.toThrow("内置技能不可删除");
      await expect(session.readSkillRaw("install-skill")).rejects.toThrow("内置技能不可编辑");
    });
  });
});
