import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSkillsCatalogSection,
  discoverSkills,
  expandSkillVariables,
  formatSkillFile,
  loadSkillContent,
  parseSkillMarkdown,
  scanSkillsDir,
  skillId,
  validateSkillName,
  writeSkillFiles,
  writeSkillRaw,
  deleteSkillDir,
  DEFAULT_MAX_SKILL_BYTES,
  type SkillMetadata,
} from "./skills.ts";
import { BUNDLED_SKILLS } from "./skills-bundled.ts";
import { toolUseSkill } from "./harness/tools/skills.ts";
import type { ToolContext } from "./harness/tools/types.ts";

async function mkdtemp(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "owncoder-skills-"));
}

describe("parseSkillMarkdown", () => {
  it("parses flat frontmatter and strips it from the body", () => {
    const doc = [
      "---",
      'name: hello',
      'description: "say hi"',
      "when_to_use: when greeting",
      "enabled: false",
      "---",
      "",
      "Body text.",
    ].join("\n");
    const { frontmatter, body, hasFrontmatter } = parseSkillMarkdown(doc);
    expect(hasFrontmatter).toBe(true);
    expect(frontmatter.name).toBe("hello");
    expect(frontmatter.description).toBe("say hi");
    expect(frontmatter.when_to_use).toBe("when greeting");
    expect(frontmatter.enabled).toBe(false);
    expect(body.trim()).toBe("Body text.");
  });

  it("supports unquoted values containing spaces", () => {
    const { frontmatter } = parseSkillMarkdown("---\nname: my skill\ndescription: reviews diffs\n---\nbody");
    expect(frontmatter.name).toBe("my skill");
    expect(frontmatter.description).toBe("reviews diffs");
  });

  it("supports | block scalars", () => {
    const doc = "---\ndescription: |\n  line one\n  line two\n---\nbody";
    const { frontmatter } = parseSkillMarkdown(doc);
    expect(frontmatter.description).toBe("line one\nline two");
  });

  it("returns the whole text as body when there is no frontmatter", () => {
    const { frontmatter, body, hasFrontmatter } = parseSkillMarkdown("Just markdown.\n");
    expect(hasFrontmatter).toBe(false);
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe("Just markdown.\n");
  });

  it("ignores malformed lines instead of throwing", () => {
    const { frontmatter, diagnostics } = parseSkillMarkdown("---\nname: ok\nthis line has no colon\n---\nbody");
    expect(frontmatter.name).toBe("ok");
    expect(diagnostics.length).toBe(1);
  });
});

describe("scanSkillsDir", () => {
  it("scans one-level subdirectories and the root itself", async () => {
    const root = await mkdtemp();
    try {
      await fs.mkdir(join(root, "hello"), { recursive: true });
      await fs.writeFile(join(root, "hello", "SKILL.md"), "---\nname: hello\ndescription: greets\n---\nbody");
      // no frontmatter name → falls back to directory name
      await fs.mkdir(join(root, "bare"), { recursive: true });
      await fs.writeFile(join(root, "bare", "SKILL.md"), "no frontmatter here");
      // root-level SKILL.md with explicit name is a skill too
      await fs.writeFile(join(root, "SKILL.md"), "---\nname: root-skill\ndescription: at root\n---\nbody");
      // excluded directory is never scanned
      await fs.mkdir(join(root, "node_modules", "evil"), { recursive: true });
      await fs.writeFile(join(root, "node_modules", "evil", "SKILL.md"), "---\nname: evil\n---\nx");

      const { skills, diagnostics } = await scanSkillsDir(root);
      const names = skills.map((s) => s.name).sort();
      expect(names).toEqual(["bare", "hello", "root-skill"]);
      expect(diagnostics).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips a root-level SKILL.md without a frontmatter name", async () => {
    const root = await mkdtemp();
    try {
      await fs.writeFile(join(root, "SKILL.md"), "no name");
      const { skills, diagnostics } = await scanSkillsDir(root);
      expect(skills).toEqual([]);
      expect(diagnostics.length).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns empty for a missing root", async () => {
    const { skills } = await scanSkillsDir(join(tmpdir(), "owncoder-does-not-exist-xyz"));
    expect(skills).toEqual([]);
  });
});

describe("discoverSkills", () => {
  it("merges bundled/user/project with project shadowing user", async () => {
    const projectRoot = await mkdtemp();
    const userRoot = await mkdtemp();
    try {
      const ws = await mkdtemp();
      try {
        await fs.mkdir(join(ws, ".owncoder", "skills", "dup"), { recursive: true });
        await fs.writeFile(
          join(ws, ".owncoder", "skills", "dup", "SKILL.md"),
          "---\nname: dup\ndescription: project version\n---\np",
        );
        await fs.mkdir(join(userRoot, "dup"), { recursive: true });
        await fs.writeFile(
          join(userRoot, "dup", "SKILL.md"),
          "---\nname: dup\ndescription: user version\n---\nu",
        );
        await fs.mkdir(join(userRoot, "only-user"), { recursive: true });
        await fs.writeFile(
          join(userRoot, "only-user", "SKILL.md"),
          "---\nname: only-user\ndescription: user only\n---\nu",
        );

        const { skills } = await discoverSkills({
          workspaceRoot: ws,
          userSkillsRoot: userRoot,
          bundled: [
            { name: "dup", description: "bundled", content: "b" },
            { name: "bundled-one", description: "built in", content: "b" },
          ],
        });
        const byName = new Map(skills.map((s) => [s.name, s]));
        expect(byName.get("dup")?.description).toBe("project version");
        expect(byName.get("dup")?.scope).toBe("project");
        expect(byName.get("only-user")?.scope).toBe("user");
        expect(byName.get("bundled-one")?.scope).toBe("system");
        expect(byName.get("bundled-one")?.source).toBe("bundled");
        // shadowed entries collapse to one per name
        expect(skills.filter((s) => s.name === "dup")).toHaveLength(1);
      } finally {
        await fs.rm(ws, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
      await fs.rm(userRoot, { recursive: true, force: true });
    }
  });

  it("marks disabled ids as disabled and keeps them listed", async () => {
    const userRoot = await mkdtemp();
    try {
      await fs.mkdir(join(userRoot, "hello"), { recursive: true });
      await fs.writeFile(
        join(userRoot, "hello", "SKILL.md"),
        "---\nname: hello\ndescription: greets\n---\nbody",
      );
      const { skills } = await discoverSkills({
        workspaceRoot: null,
        userSkillsRoot: userRoot,
        bundled: [],
        disabledIds: new Set([skillId("user", "hello")]),
      });
      expect(skills[0]?.enabled).toBe(false);
    } finally {
      await fs.rm(userRoot, { recursive: true, force: true });
    }
  });

  it("respects frontmatter enabled: false", async () => {
    const userRoot = await mkdtemp();
    try {
      await fs.mkdir(join(userRoot, "off"), { recursive: true });
      await fs.writeFile(
        join(userRoot, "off", "SKILL.md"),
        "---\nname: off\ndescription: d\nenabled: false\n---\nbody",
      );
      const { skills } = await discoverSkills({
        workspaceRoot: null,
        userSkillsRoot: userRoot,
        bundled: [],
      });
      expect(skills[0]?.enabled).toBe(false);
    } finally {
      await fs.rm(userRoot, { recursive: true, force: true });
    }
  });
});

describe("loadSkillContent", () => {
  it("strips frontmatter and reports size", async () => {
    const root = await mkdtemp();
    try {
      const dir = await writeSkillFiles(root, {
        name: "hello",
        description: "greets",
        body: "Do the thing.",
      });
      const meta: SkillMetadata = {
        id: skillId("project", "hello"),
        name: "hello",
        description: "greets",
        path: join(dir, "SKILL.md"),
        directory: dir,
        scope: "project",
        source: "disk",
        sizeBytes: 0,
        mtimeMs: 0,
        enabled: true,
      };
      const content = await loadSkillContent(meta);
      expect(content.content.trim()).toBe("Do the thing.");
      expect(content.baseDirectory).toBe(dir);
      expect(content.truncated).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("truncates oversized bodies and flags them", async () => {
    const root = await mkdtemp();
    try {
      const dir = await writeSkillFiles(root, {
        name: "big",
        description: "big",
        body: "x".repeat(5000),
      });
      const meta: SkillMetadata = {
        id: skillId("project", "big"),
        name: "big",
        description: "big",
        path: join(dir, "SKILL.md"),
        directory: dir,
        scope: "project",
        source: "disk",
        sizeBytes: 0,
        mtimeMs: 0,
        enabled: true,
      };
      const content = await loadSkillContent(meta, { maxBytes: 100 });
      expect(content.content.length).toBe(100);
      expect(content.truncated).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reads bundled skills from the provided body map", async () => {
    const meta: SkillMetadata = {
      id: skillId("system", "demo"),
      name: "demo",
      description: "d",
      path: "",
      directory: "",
      scope: "system",
      source: "bundled",
      sizeBytes: 5,
      mtimeMs: 0,
      enabled: true,
    };
    const content = await loadSkillContent(meta, { bundledBody: "bundled body" });
    expect(content.content).toBe("bundled body");
    expect(content.truncated).toBe(false);
  });
});

describe("catalog section", () => {
  const meta = (name: string, scope: "system" | "user" | "project"): SkillMetadata => ({
    id: skillId(scope, name),
    name,
    description: `description of ${name}`,
    whenToUse: `use for ${name}`,
    path: "",
    directory: "",
    scope,
    source: scope === "system" ? "bundled" : "disk",
    sizeBytes: 0,
    mtimeMs: 0,
    enabled: true,
  });

  it("lists name, scope, description and when_to_use", () => {
    const section = buildSkillsCatalogSection([meta("code-review", "project")]);
    expect(section).toContain("## Available skills");
    expect(section).toContain("use_skill");
    expect(section).toContain("- code-review (project): description of code-review");
    expect(section).toContain("when to use: use for code-review");
  });

  it("degrades to name-only lines past the budget", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      meta(`skill-${i}`, "user"),
    ).map((m) => ({ ...m, description: "d".repeat(200) }));
    const section = buildSkillsCatalogSection(many);
    expect(section).toContain("## Available skills");
    expect(section).toContain("- skill-0 (user)");
    // descriptions dropped in compact mode
    expect(section).not.toContain("d".repeat(50));
    expect(section.length).toBeLessThan(DEFAULT_MAX_SKILL_BYTES);
  });

  it("includes install directories when provided", () => {
    const section = buildSkillsCatalogSection([meta("x", "project")], {
      projectDir: "/ws/.owncoder/skills",
      userDir: "/data/owncoder/skills",
    });
    expect(section).toContain(
      "Skill install directories — project: /ws/.owncoder/skills; user: /data/owncoder/skills",
    );
  });

  it("omits the install-directories line when not provided", () => {
    const section = buildSkillsCatalogSection([meta("x", "project")]);
    expect(section).not.toContain("install directories");
  });
});

describe("bundled skills", () => {
  it("every bundled skill has a name, description and non-empty body", () => {
    for (const b of BUNDLED_SKILLS) {
      expect(b.name).toBeTruthy();
      expect(b.description).toBeTruthy();
      expect(b.content.trim().length).toBeGreaterThan(0);
    }
    expect(BUNDLED_SKILLS.map((b) => b.name).sort()).toEqual(["code-review", "install-skill"]);
  });
});

describe("variables and names", () => {
  it("expands ${OWNCODER_SKILL_DIR}", () => {
    expect(expandSkillVariables("run ${OWNCODER_SKILL_DIR}/scripts/x.sh", "/skills/hello")).toBe(
      "run /skills/hello/scripts/x.sh",
    );
    expect(expandSkillVariables("no vars", "")).toBe("no vars");
  });

  it("rejects traversal names", () => {
    expect(() => validateSkillName("../evil")).toThrow();
    expect(() => validateSkillName("a/b")).toThrow();
    expect(() => validateSkillName("")).toThrow();
    expect(validateSkillName("my-skill_1.v2")).toBe("my-skill_1.v2");
  });
});

describe("write / delete roundtrip", () => {
  it("writes a SKILL.md that discovery reads back with the same metadata", async () => {
    const ws = await mkdtemp();
    try {
      const skillsRoot = join(ws, ".owncoder", "skills");
      const dir = await writeSkillFiles(skillsRoot, {
        name: "review",
        description: 'Review "diffs" carefully',
        whenToUse: "when asked to review",
        body: "Checklist body.",
      });
      const { skills } = await discoverSkills({ workspaceRoot: ws, bundled: [] });
      expect(skills.map((s) => s.name)).toEqual(["review"]);
      expect(skills[0]?.description).toBe('Review "diffs" carefully');
      expect(skills[0]?.whenToUse).toBe("when asked to review");
      expect(skills[0]?.directory).toBe(dir);

      // raw write preserves an arbitrary document verbatim
      const raw = "---\nname: review\ndescription: replaced\n---\nNew body.";
      await writeSkillRaw(skillsRoot, "review", raw);
      const reread = await fs.readFile(join(dir, "SKILL.md"), "utf8");
      expect(reread).toBe(raw);

      await deleteSkillDir(skillsRoot, "review");
      const after = await discoverSkills({ workspaceRoot: ws, bundled: [] });
      expect(after.skills).toEqual([]);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("formatSkillFile round-trips through the parser", () => {
    const doc = formatSkillFile({
      name: "x",
      description: 'has "quotes" and \\ backslash',
      whenToUse: "sometimes",
      body: "body text",
      enabled: false,
    });
    const parsed = parseSkillMarkdown(doc);
    expect(parsed.frontmatter.name).toBe("x");
    expect(parsed.frontmatter.description).toBe('has "quotes" and \\ backslash');
    expect(parsed.frontmatter.when_to_use).toBe("sometimes");
    expect(parsed.frontmatter.enabled).toBe(false);
    expect(parsed.body.trim()).toBe("body text");
  });
});

describe("toolUseSkill", () => {
  const meta: SkillMetadata = {
    id: skillId("project", "hello"),
    name: "hello",
    description: "greets",
    path: "",
    directory: "/skills/hello",
    scope: "project",
    source: "disk",
    sizeBytes: 0,
    mtimeMs: 0,
    enabled: true,
  };

  const ctxWith = (loaded: unknown): ToolContext =>
    ({ skills: { loadSkill: async () => loaded, listNames: async () => ["hello"] } }) as unknown as ToolContext;

  it("wraps the body in skill_content with base directory hints", async () => {
    const result = await toolUseSkill(ctxWith({
      metadata: meta,
      content: "Follow these steps. Use ${OWNCODER_SKILL_DIR}/scripts/run.sh",
      baseDirectory: "/skills/hello",
      truncated: false,
    }), "hello", "");
    expect(result.ok).toBe(true);
    expect(result.output).toContain('<skill_content name="hello">');
    expect(result.output).toContain("Follow these steps. Use /skills/hello/scripts/run.sh");
    expect(result.output).toContain("Base directory for this skill: /skills/hello");
    expect(result.output).toContain("</skill_content>");
  });

  it("fails with the available-names hint for unknown skills", async () => {
    const result = await toolUseSkill(ctxWith(null), "nope", "");
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Skill "nope" not found');
    expect(result.output).toContain("hello");
  });

  it("rejects an empty skill name", async () => {
    const result = await toolUseSkill(ctxWith(null), "  ", "");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("参数错误");
  });
});
