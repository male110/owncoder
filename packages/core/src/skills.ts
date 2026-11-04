/**
 * Skills (技能) — discovery, parsing, loading and persistence.
 *
 * A skill is a directory containing a `SKILL.md` file with YAML frontmatter
 * (`name`, `description`, optional `when_to_use` / `enabled`) plus a Markdown
 * body that is injected into the conversation when the model invokes the
 * `use_skill` tool. A skill directory may carry additional resource files
 * (scripts/, references/, …) that the body references via relative paths.
 *
 * Roots, in priority order (a project skill shadows a user skill with the
 * same name, which shadows a bundled one):
 *   1. project:  <workspace>/.owncoder/skills
 *   2. user:     <userData>/owncoder/skills (injected by the desktop host)
 *   3. system:   bundled skills compiled into this package
 */
import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";

export const SKILLS_DIR = ".owncoder/skills";
export const SKILL_FILE_NAME = "SKILL.md";
export const DEFAULT_MAX_SKILL_BYTES = 100_000;
/** Character budget for the catalog section injected into the system prompt. */
export const SKILL_CATALOG_BUDGET = 12_000;

export type SkillScope = "system" | "user" | "project";
export type SkillSource = "bundled" | "disk";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  when_to_use?: string;
  enabled?: boolean;
}

export interface SkillMetadata {
  /** `${scope}:${name}` — stable identity used by the enabled/disabled list. */
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  /** Absolute SKILL.md path; empty for bundled skills. */
  path: string;
  /** Absolute skill directory; empty for bundled skills. */
  directory: string;
  scope: SkillScope;
  source: SkillSource;
  sizeBytes: number;
  mtimeMs: number;
  enabled: boolean;
}

export interface SkillContent {
  metadata: SkillMetadata;
  /** SKILL.md body with the frontmatter stripped. */
  content: string;
  baseDirectory: string;
  truncated: boolean;
}

export interface SkillDiscoveryResult {
  skills: SkillMetadata[];
  diagnostics: string[];
}

export interface SkillWriteInput {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  enabled?: boolean;
}

const SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor",
  "coverage", ".cache", ".next", ".turbo", ".venv", "__pycache__",
]);

export function skillId(scope: SkillScope, name: string): string {
  return `${scope}:${name}`;
}

// ── Frontmatter parsing ────────────────────────────────────────────────

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  return v;
}

/**
 * Split a SKILL.md into its YAML frontmatter and Markdown body.
 * Returns null when the file does not start with a `---` block.
 */
export function splitFrontmatter(text: string): { frontmatterText: string; body: string } | null {
  if (!text.startsWith("---")) return null;
  const firstNl = text.indexOf("\n");
  if (firstNl === -1) return null;
  const close = text.indexOf("\n---", firstNl);
  if (close === -1) return null;
  const frontmatterText = text.slice(firstNl + 1, close);
  let body = text.slice(close + 4);
  if (body.startsWith("\n")) body = body.slice(1);
  return { frontmatterText, body };
}

/**
 * Parse the flat YAML frontmatter of a SKILL.md. Supports `key: value`
 * lines (quoted or bare) plus `|` / `>` block scalars. Unknown keys are
 * ignored; malformed lines are ignored rather than throwing.
 */
export function parseSkillFrontmatter(text: string): { frontmatter: SkillFrontmatter; diagnostics: string[] } {
  const frontmatter: SkillFrontmatter = {};
  const diagnostics: string[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i += 1; continue; }
    const colon = line.indexOf(":");
    if (colon === -1) { diagnostics.push(`skipping malformed frontmatter line: ${line.trim()}`); i += 1; continue; }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    i += 1;
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim()) { block.push(""); i += 1; continue; }
        if (!/^[\t ]/.test(next)) break;
        block.push(next.trim());
        i += 1;
      }
      while (block.length > 0 && block[block.length - 1] === "") block.pop();
      value = folded ? block.join(" ") : block.join("\n");
    }
    if (key === "name") frontmatter.name = stripQuotes(value);
    else if (key === "description") frontmatter.description = stripQuotes(value);
    else if (key === "when_to_use") frontmatter.when_to_use = stripQuotes(value);
    else if (key === "enabled") {
      frontmatter.enabled = value === "true" || value === "True" || value === "yes";
    }
    // Unknown keys are deliberately ignored (forward compatibility).
  }
  return { frontmatter, diagnostics };
}

/** Parse a full SKILL.md document into frontmatter + body. */
export function parseSkillMarkdown(
  text: string,
): { frontmatter: SkillFrontmatter; body: string; hasFrontmatter: boolean; diagnostics: string[] } {
  const split = splitFrontmatter(text);
  if (!split) return { frontmatter: {}, body: text, hasFrontmatter: false, diagnostics: [] };
  const { frontmatter, diagnostics } = parseSkillFrontmatter(split.frontmatterText);
  return { frontmatter, body: split.body, hasFrontmatter: true, diagnostics };
}

// ── Serialization (used when writing SKILL.md from the settings UI) ─────

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Serialize frontmatter fields + body into a complete SKILL.md document. */
export function formatSkillFile(input: SkillWriteInput): string {
  const lines = ["---", `name: ${input.name}`];
  if (input.description) lines.push(`description: ${yamlQuote(input.description)}`);
  if (input.whenToUse) lines.push(`when_to_use: ${yamlQuote(input.whenToUse)}`);
  if (input.enabled === false) lines.push("enabled: false");
  lines.push("---", "");
  const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
  return `${lines.join("\n")}${body}`;
}

// ── Scanning ───────────────────────────────────────────────────────────

function safeSkillName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error("empty skill name");
  if (n.startsWith(".")) throw new Error("skill name cannot start with .");
  // Reject separators outright (no basename fallback) so traversal attempts
  // surface as errors instead of being silently rewritten.
  if (!/^[\w.-]+$/.test(n)) {
    throw new Error("skill name may only contain letters, digits, _ - .");
  }
  return n;
}

interface RawSkillFile {
  name: string;
  directory: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

async function readSkillFile(absPath: string, directory: string, fallbackName: string): Promise<RawSkillFile | null> {
  let text: string;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }
  const { frontmatter, hasFrontmatter } = parseSkillMarkdown(text);
  const name = frontmatter.name?.trim() || (hasFrontmatter ? "" : fallbackName);
  if (!name) return null;
  const st = await fs.stat(absPath).catch(() => null);
  return {
    name,
    directory,
    path: absPath,
    sizeBytes: st?.size ?? text.length,
    mtimeMs: st?.mtimeMs ?? 0,
  };
}

/**
 * Scan one skills root: the root itself may be a single skill (SKILL.md with
 * an explicit frontmatter name), and each first-level subdirectory containing
 * a SKILL.md is a skill. Deeper files are treated as skill resources, not
 * skills. Returns skills sorted by name.
 */
export async function scanSkillsDir(rootAbs: string): Promise<{ skills: RawSkillFile[]; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const out: RawSkillFile[] = [];

  const rootExists = await fs.stat(rootAbs).then((s) => s.isDirectory(), () => false);
  if (!rootExists) return { skills: out, diagnostics };

  const rootFile = join(rootAbs, SKILL_FILE_NAME);
  const rootSkill = await readSkillFile(rootFile, rootAbs, "");
  if (rootSkill) {
    out.push(rootSkill);
  } else if (await fs.stat(rootFile).then(() => true, () => false)) {
    diagnostics.push(`${rootFile}: root-level SKILL.md requires an explicit frontmatter name; skipped`);
  }

  const entries = await fs.readdir(rootAbs, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".") || SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES.has(ent.name)) continue;
    const dir = join(rootAbs, ent.name);
    const skill = await readSkillFile(join(dir, SKILL_FILE_NAME), dir, ent.name);
    if (skill) out.push(skill);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { skills: out, diagnostics };
}

// ── Discovery ──────────────────────────────────────────────────────────

export interface BundledSkill {
  name: string;
  description: string;
  when_to_use?: string;
  content: string;
}

/**
 * Merge bundled, user-level and project-level skills. Same-name skills are
 * shadowed by higher-priority scopes (project > user > system). Only
 * frontmatter-valid skills are returned; problems surface as diagnostics.
 */
export async function discoverSkills(opts: {
  workspaceRoot?: string | null;
  userSkillsRoot?: string | null;
  bundled: BundledSkill[];
  disabledIds?: ReadonlySet<string>;
}): Promise<SkillDiscoveryResult> {
  const diagnostics: string[] = [];
  const byName = new Map<string, SkillMetadata>();

  // Lowest priority first so later scopes overwrite.
  for (const b of opts.bundled) {
    byName.set(b.name, {
      id: skillId("system", b.name),
      name: b.name,
      description: b.description,
      whenToUse: b.when_to_use,
      path: "",
      directory: "",
      scope: "system",
      source: "bundled",
      sizeBytes: b.content.length,
      mtimeMs: 0,
      enabled: true,
    });
  }

  if (opts.userSkillsRoot) {
    const user = await scanSkillsDir(opts.userSkillsRoot);
    diagnostics.push(...user.diagnostics);
    for (const raw of user.skills) {
      const meta = await enrich(raw, "user", opts.disabledIds);
      if (meta) byName.set(meta.name, meta);
    }
  }

  if (opts.workspaceRoot) {
    const projectRoot = resolve(opts.workspaceRoot, SKILLS_DIR);
    const project = await scanSkillsDir(projectRoot);
    diagnostics.push(...project.diagnostics);
    for (const raw of project.skills) {
      const meta = await enrich(raw, "project", opts.disabledIds);
      if (meta) byName.set(meta.name, meta);
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, diagnostics };
}

/** Re-read the frontmatter to fill description/whenToUse/enabled. */
async function enrich(
  raw: RawSkillFile,
  scope: SkillScope,
  disabledIds?: ReadonlySet<string>,
): Promise<SkillMetadata | null> {
  let text: string;
  try {
    text = await fs.readFile(raw.path, "utf8");
  } catch {
    return null;
  }
  const { frontmatter } = parseSkillMarkdown(text);
  const enabled = disabledIds?.has(skillId(scope, raw.name)) ? false : frontmatter.enabled !== false;
  return {
    id: skillId(scope, raw.name),
    name: raw.name,
    description: frontmatter.description ?? "",
    whenToUse: frontmatter.when_to_use,
    path: raw.path,
    directory: raw.directory,
    scope,
    source: "disk",
    sizeBytes: raw.sizeBytes,
    mtimeMs: raw.mtimeMs,
    enabled,
  };
}

// ── Loading ────────────────────────────────────────────────────────────

/**
 * Load a skill's body (frontmatter stripped) for injection into the
 * conversation. Disk skills are read from the filesystem and truncated at
 * `maxBytes`; bundled skills are read from the provided map.
 */
export async function loadSkillContent(
  meta: SkillMetadata,
  opts?: { maxBytes?: number; bundledBody?: string },
): Promise<SkillContent> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
  let raw = "";
  if (meta.source === "bundled") {
    raw = opts?.bundledBody ?? "";
  } else {
    try {
      raw = await fs.readFile(meta.path, "utf8");
    } catch {
      throw new Error(`skill not found: ${meta.name}`);
    }
  }
  const parsed = parseSkillMarkdown(raw);
  let content = parsed.body;
  let truncated = false;
  if (content.length > maxBytes) {
    content = content.slice(0, maxBytes);
    truncated = true;
  }
  return { metadata: meta, content, baseDirectory: meta.directory, truncated };
}

/** Resolve ${OWNCODER_SKILL_DIR} inside a skill body to the skill directory. */
export function expandSkillVariables(content: string, baseDirectory: string): string {
  if (!baseDirectory) return content;
  return content.split("${OWNCODER_SKILL_DIR}").join(baseDirectory);
}

// ── Catalog section (system prompt) ────────────────────────────────────

function skillDisplayPath(meta: SkillMetadata): string {
  if (meta.source === "bundled") return "(built-in)";
  if (meta.scope === "project") return `.owncoder/skills/${meta.name}/${SKILL_FILE_NAME}`;
  return `~/skills/${meta.name}/${SKILL_FILE_NAME}`;
}

function catalogLine(meta: SkillMetadata, withDescription: boolean): string {
  const parts = [`- ${meta.name} (${meta.scope})`];
  if (withDescription) {
    const desc = meta.description.replace(/\s+/g, " ").trim();
    if (desc) parts.push(`: ${desc}`);
    if (meta.whenToUse) parts.push(` — when to use: ${meta.whenToUse.replace(/\s+/g, " ").trim()}`);
  }
  parts.push(` (${skillDisplayPath(meta)})`);
  return parts.join("");
}

/**
 * Build the "Available skills" system-prompt section. Degrades to a
 * name-only listing when the full listing exceeds SKILL_CATALOG_BUDGET.
 *
 * `opts` adds an install-directories line with the absolute project and user
 * skills roots so the model (notably the install-skill flow) knows exactly
 * where to write a new skill.
 */
export function buildSkillsCatalogSection(
  skills: SkillMetadata[],
  opts?: { projectDir?: string | null; userDir?: string | null },
): string {
  if (skills.length === 0) return "";
  const headerLines = [
    "## Available skills",
    "The following skills are available via the `use_skill` tool. When the user's task matches a skill's",
    "description — or the user message starts with `/<skill-name>` — call `use_skill` with that skill name",
    "FIRST, then follow the loaded instructions. Do not guess skill names that are not listed below.",
  ];
  const dirs: string[] = [];
  if (opts?.projectDir) dirs.push(`project: ${opts.projectDir}`);
  if (opts?.userDir) dirs.push(`user: ${opts.userDir}`);
  if (dirs.length > 0) headerLines.push(`Skill install directories — ${dirs.join("; ")}`);
  headerLines.push("");
  const header = headerLines.join("\n");
  const full = skills.map((s) => catalogLine(s, true)).join("\n");
  if (header.length + full.length <= SKILL_CATALOG_BUDGET) {
    return `${header}${full}\n`;
  }
  const compact = skills.map((s) => catalogLine(s, false)).join("\n");
  return `${header}${compact}\n`;
}

// ── Management (settings UI / IPC) ─────────────────────────────────────

/** Validate a skill name for write/delete operations (no path traversal). */
export function validateSkillName(name: string): string {
  return safeSkillName(name);
}

/** Guard: resolved skill dir must stay directly inside the skills root. */
function assertInsideRoot(rootAbs: string, dir: string): void {
  const rel = relative(resolve(rootAbs), dir);
  if (rel.startsWith("..") || rel === "" || rel.includes(":") || rel.includes("\\") || rel.includes("/")) {
    throw new Error("skill name escapes the skills root");
  }
}

/** Write (create or overwrite) a skill directory under `rootAbs`. */
export async function writeSkillFiles(rootAbs: string, input: SkillWriteInput): Promise<string> {
  const name = safeSkillName(input.name);
  const dir = resolve(rootAbs, name);
  assertInsideRoot(rootAbs, dir);
  await fs.mkdir(dir, { recursive: true });
  const doc = formatSkillFile(input);
  await fs.writeFile(join(dir, SKILL_FILE_NAME), doc, "utf8");
  return dir;
}

/** Write a verbatim SKILL.md document (frontmatter included) for a skill. */
export async function writeSkillRaw(rootAbs: string, name: string, raw: string): Promise<string> {
  const safe = safeSkillName(name);
  const dir = resolve(rootAbs, safe);
  assertInsideRoot(rootAbs, dir);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, SKILL_FILE_NAME);
  await fs.writeFile(path, raw, "utf8");
  return path;
}

/** Delete a skill directory. Only disk skills under a known root may be deleted. */
export async function deleteSkillDir(rootAbs: string, name: string): Promise<void> {
  const safe = safeSkillName(name);
  const dir = resolve(rootAbs, safe);
  assertInsideRoot(rootAbs, dir);
  await fs.rm(dir, { recursive: true, force: true });
}

/** Read the raw SKILL.md document (frontmatter included) for editing. */
export async function readSkillRaw(meta: SkillMetadata): Promise<string> {
  if (meta.source === "bundled") {
    throw new Error("bundled skills cannot be edited");
  }
  return fs.readFile(meta.path, "utf8");
}
