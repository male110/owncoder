import type { ChatMessage } from "@owncoder/llm";
import type { PipelineNode } from "@owncoder/settings";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import upath from "upath";
import TOML from "@iarna/toml";
import { XMLParser } from "fast-xml-parser";
import { extractPathsFromPlan, truncatePlanForContext } from "../../plans.ts";
import { extractMentionPaths, formatMentionsBlock, loadMentionedFiles } from "../../mentions.ts";
import { clampText, contextBudgets, computeContextBudget, type ContextBudget, type FixedSegments } from "../budget.ts";
import { estimateTokens, PerformanceTimer } from "../observability.ts";
import { IS_WINDOWS, OS_RELEASE, PLATFORM } from "../tools/shared.ts";
import type { MemoryManager } from "../memory.ts";
import { documentIntentContext } from "./document-workflow.ts";
import {
  inferTaskIntent,
  planMinimumContext,
  resolveMinimumContextConfig,
  summarizeMinimumContextPlan,
  type ContextCandidate,
} from "./minimum-context.ts";
import { emitStage } from "./stages.ts";
import { ContextControlState, resolveContextControlConfig } from "./context-control.ts";
import type { AgentLoopOpts } from "./types.ts";

/** Strip repo-map stubs that the index emits when there is nothing meaningful
 * to render (no symbols, native not compiled, no workspace). Returning "" lets
 * the caller omit the `## Repository map` block instead of pushing a placeholder. */
export function isMeaningfulRepoMap(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("(stub)")) return false;
  if (trimmed.includes("(no symbols indexed yet)")) return false;
  return true;
}

export interface BuildContextArgs {
  opts: AgentLoopOpts;
  memory: MemoryManager;
  /** @deprecated Use tokenBudget when available. Kept for backward compat. */
  budgets: ReturnType<typeof contextBudgets>;
  /** Token-based budget (computed internally in buildInitialContext). */
  tokenBudget?: ContextBudget;
  systemPrompt: string;
  contextNode: PipelineNode | undefined;
  anchorsNode: PipelineNode | undefined;
  messages: ChatMessage[];
}

export interface BuildContextResult {
  budgetUsed: number;
  /** Ephemeral controls shared with the later ReAct stage in this turn. */
  contextControl: ContextControlState;
  /** Fixed segment sizes measured during context assembly. */
  fixedSegments: FixedSegments;
  /** Token-based context budget computed from fixed segments. */
  tokenBudget: ContextBudget;
}

interface RetrievalHit {
  id: string;
  path: string;
  content: string;
}

interface RetrievalResult {
  label: string;
  paths: string[];
  hits: RetrievalHit[];
}

async function runRetrieval(
  opts: AgentLoopOpts,
  ctxEnabled: boolean,
  _ctxParams: Record<string, unknown>,
  filesBudget: number,
): Promise<RetrievalResult | null> {
  // 代码召回 - 不记日志
  if (!ctxEnabled) return null;

  if (opts.index.ragSearch) {
    try {
      opts.onEvent?.({ type: "semantic_search", results: 0 });
      const hits = await opts.index.ragSearch(opts.userMessage, 8);
      if (hits.length > 0) {
        const perHitBudget = Math.max(320, Math.floor((filesBudget * 0.6) / hits.length));
        const result: RetrievalResult = {
          label: "Semantic search (RAG embedding)",
          paths: hits.map((hit) => hit.filePath),
          hits: hits.map((hit, index) => ({
            id: `rag:${index}:${hit.filePath}:${hit.symbol}`,
            path: hit.filePath,
            content: clampText(formatRagHit(hit), perHitBudget),
          })),
        };
        opts.onEvent?.({ type: "semantic_search", results: hits.length });
        return result;
      }
    } catch {
      /* retrieval is best effort */
    }
  }

  return null;
}

function formatRagHit(hit: {
  filePath: string;
  symbol: string;
  content: string;
  language: string;
  score: number;
  semanticScore: number;
}): string {
  const preview = hit.content.slice(0, 200).replace(/\n/g, " ");
  return [
    `### ${hit.filePath} \`${hit.symbol}\``,
    `Score: ${(hit.score * 100).toFixed(0)}%; semantic: ${(hit.semanticScore * 100).toFixed(0)}%`,
    `\`\`\`${hit.language}`,
    `${preview}${hit.content.length > 200 ? "..." : ""}`,
    "\`\`\`",
  ].join("\n");
}

function retrievalGuidance(label: string, count: number): string {
  return [
    `## ${label} (${count} selected result${count === 1 ? "" : "s"})`,
    "Treat these excerpts as navigation evidence for analysis and planning. Before an edit, read the current source when exact content, a decision-critical detail, or file freshness matters. Search excerpts are not verified source evidence.",
  ].join("\n\n");
}

function freshReadGuidance(paths: readonly string[]): string {
  return [
    "## Indexed-context freshness",
    "The following file labels came from indexes or search excerpts, not a current source read:",
    ...paths.slice(0, 20).map((path) => `- ${path}`),
    "Before editing any listed file, call read_file for its current contents. Indexed excerpts can guide navigation but cannot satisfy source evidence or justify a write.",
  ].join("\n");
}

/**
 * Translate a character-oriented context bucket into a token capacity using the
 * actual language mix of the blocks being considered. This avoids assuming the
 * English-only 4-char approximation for Chinese/code-heavy prompts.
 */
function proportionalTokenCapacity(
  characterBudget: number,
  knownCharacters: number,
  knownTokens: number,
): number {
  if (characterBudget <= 0 || knownCharacters <= 0 || knownTokens <= 0) return 0;
  return Math.max(0, Math.floor(knownTokens * Math.min(1, characterBudget / knownCharacters)));
}

/** Manifest filename → one-line ecosystem description. The tech-stack block
 * must describe the actual workspace, so descriptions are derived from the
 * manifests actually present instead of hardcoding one project's stack. */
const MANIFEST_ECOSYSTEMS: ReadonlyArray<readonly [string, string]> = [
  ["pom.xml", "Java (Maven)"],
  ["build.gradle", "Java/Kotlin (Gradle)"],
  ["build.gradle.kts", "Java/Kotlin (Gradle, Kotlin DSL)"],
  ["settings.gradle", "Java/Kotlin (Gradle multi-project)"],
  ["settings.gradle.kts", "Java/Kotlin (Gradle multi-project, Kotlin DSL)"],
  ["package.json", "Node.js / TypeScript / JavaScript"],
  ["pnpm-workspace.yaml", "pnpm workspace monorepo"],
  ["Cargo.toml", "Rust (Cargo)"],
  ["go.mod", "Go"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["setup.py", "Python"],
  ["composer.json", "PHP (Composer)"],
  ["Gemfile", "Ruby (Bundler)"],
  ["Package.swift", "Swift (SwiftPM)"],
  ["pubspec.yaml", "Dart / Flutter"],
  ["mix.exs", "Elixir (Mix)"],
  ["project.clj", "Clojure (Leiningen)"],
  ["deps.edn", "Clojure (tools.deps)"],
  ["build.sbt", "Scala (sbt)"],
  ["CMakeLists.txt", "C/C++ (CMake)"],
  ["vcpkg.json", "C/C++"],
  ["conanfile.txt", "C/C++ (Conan)"],
  ["build.zig.zon", "Zig"],
  ["oh-package.json5", "HarmonyOS / ArkTS"],
  ["cjpm.toml", "Cangjie"],
  ["Project.toml", "Julia"],
  ["DESCRIPTION", "R"],
  ["cpanfile", "Perl"],
  ["rebar.config", "Erlang"],
  ["package.yaml", "Haskell"],
];

/** How many directories (root + first-level subdirectories) to probe for
 * manifests. Keeps multi-module Maven/Gradle layouts detectable without a
 * recursive scan of large projects. */
const ECOSYSTEM_PROBE_DIRS = 8;

/**
 * Detect the workspace's ecosystem(s) from the manifest files actually present
 * (pom.xml, package.json, Cargo.toml, ...) at the workspace root and a bounded
 * set of first-level subdirectories. Suffix-matched manifests (.csproj, .sln,
 * .rockspec, .cabal) are picked up via directory listings. Returns one-line
 * descriptions, most relevant first; an empty array when nothing recognizable
 * is found.
 */
export async function detectProjectEcosystem(workspaceRoot: string): Promise<string[]> {
  const probeDirs: string[] = [workspaceRoot];
  try {
    const rootEntries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (probeDirs.length >= ECOSYSTEM_PROBE_DIRS) break;
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        probeDirs.push(join(workspaceRoot, entry.name));
      }
    }
  } catch {
    /* unreadable root — detection is best effort */
  }

  const found: string[] = [];
  for (const dir of probeDirs) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    const names = new Set(entries.map((name) => name.toLowerCase()));
    for (const [file, label] of MANIFEST_ECOSYSTEMS) {
      if (names.has(file.toLowerCase()) && !found.includes(label)) found.push(label);
    }
    const csproj = entries.find((name) => name.toLowerCase().endsWith(".csproj"));
    if (csproj && !found.includes(`.NET (${csproj})`)) found.push(`.NET (${csproj})`);
    const sln = entries.find((name) => name.toLowerCase().endsWith(".sln"));
    if (sln && !found.includes(".NET solution (.sln)")) found.push(".NET solution (.sln)");
    const rockspec = entries.find((name) => name.toLowerCase().endsWith(".rockspec"));
    if (rockspec && !found.includes("Lua")) found.push("Lua");
    const cabal = entries.find((name) => name.toLowerCase().endsWith(".cabal"));
    if (cabal && !found.includes("Haskell")) found.push("Haskell");
  }
  return found;
}

/**
 * Build a compact Markdown block listing the project's declared dependencies
 * across ecosystems (npm, cargo, python, go, maven, gradle, nuget). Each
 * manifest is parsed best-effort; missing/unreadable files are skipped silently.
 * Returns "" when no recognizable manifest is found.
 */
export async function buildProjectDeps(workspaceRoot: string): Promise<string> {
  const blocks = await Promise.all([
    readNodeDeps(workspaceRoot),
    readRustDeps(workspaceRoot),
    readPythonDeps(workspaceRoot),
    readGoDeps(workspaceRoot),
    readMavenDeps(workspaceRoot),
    readGradleDeps(workspaceRoot),
    readDotNetDeps(workspaceRoot),
    readPhpDeps(workspaceRoot),
    readRubyDeps(workspaceRoot),
    readSwiftDeps(workspaceRoot),
    readDartDeps(workspaceRoot),
    readElixirDeps(workspaceRoot),
    readClojureDeps(workspaceRoot),
    readScalaDeps(workspaceRoot),
    readCppDeps(workspaceRoot),
    readHaskellDeps(workspaceRoot),
    readJuliaDeps(workspaceRoot),
    readRDeps(workspaceRoot),
    readPerlDeps(workspaceRoot),
    readLuaDeps(workspaceRoot),
    readErlangDeps(workspaceRoot),
    readCangjieDeps(workspaceRoot),
    readHarmonyDeps(workspaceRoot),
    readZigDeps(workspaceRoot),
  ]);
  const sections = blocks.filter((b) => b.trim());
  if (!sections.length) return "";
  return [
    "## Project dependencies",
    "Declared values are version ranges/specifiers; a different major version usually means breaking API changes (renamed/removed exports, changed props, removed methods). Before relying on a library's exports or component props, check the installed version first. Read type declarations / source only when a specific API needs verification.",
    ...sections,
  ].join("\n");
}

const DEP_LIST_CAP = 200;

function capEntries<T extends Array<unknown>>(entries: T): T {
  return entries.slice(0, DEP_LIST_CAP) as T;
}

export async function readNodeDeps(root: string): Promise<string> {
  try {
    const pkgJson = await fs.readFile(join(root, "package.json"), "utf8");
    const pkg = JSON.parse(pkgJson) as Record<string, unknown>;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    const lines: string[] = ["### npm (package.json)"];
    const depEntries = capEntries(Object.entries(deps));
    if (depEntries.length) {
      lines.push("#### dependencies");
      for (const [name, version] of depEntries) lines.push(`- ${name}: ${version}`);
    }
    const devEntries = capEntries(Object.entries(devDeps));
    if (devEntries.length) {
      lines.push("#### devDependencies");
      for (const [name, version] of devEntries) lines.push(`- ${name}: ${version}`);
    }
    if (depEntries.length === 0 && devEntries.length === 0) return "";
    return lines.join("\n");
  } catch {
    return "";
  }
}

export async function readRustDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "Cargo.toml"), "utf8");
    const parsed = TOML.parse(content) as any;
    
    const lines: string[] = ["### cargo (Cargo.toml)"];
    
    // Step 1: Extract workspace dependencies for version resolution
    const workspaceDeps = new Map<string, string>();
    if (parsed.workspace?.dependencies) {
      const wsDeps = parsed.workspace.dependencies;
      if (wsDeps && typeof wsDeps === "object") {
        for (const [name, spec] of Object.entries(wsDeps)) {
          if (typeof spec === "string") {
            workspaceDeps.set(name, spec);
          } else if (spec && typeof spec === "object" && "version" in spec) {
            workspaceDeps.set(name, (spec as any).version);
          }
        }
      }
    }
    
    // Step 2: Helper to extract dependencies from a section
    const extractDeps = (section: any): Array<[string, string]> => {
      if (!section || typeof section !== "object") return [];
      const result: Array<[string, string]> = [];
      
      for (const [name, spec] of Object.entries(section)) {
        if (name === "version" || name === "edition") continue; // Skip metadata
        
        let version: string;
        if (typeof spec === "string") {
          version = spec;
        } else if (spec && typeof spec === "object") {
          const depSpec = spec as any;
          
          // Check for workspace inheritance
          if (depSpec.workspace === true) {
            const wsVersion = workspaceDeps.get(name);
            version = wsVersion || "(workspace)";
          } else if ("version" in depSpec) {
            version = depSpec.version;
          } else {
            version = "(complex)";
          }
        } else {
          version = "(complex)";
        }
        
        result.push([name, version]);
      }
      
      return result;
    };
    
    const deps = capEntries(extractDeps(parsed.dependencies));
    const devDeps = capEntries(extractDeps(parsed["dev-dependencies"] || parsed.dev_dependencies));
    const buildDeps = capEntries(extractDeps(parsed["build-dependencies"]));
    
    if (deps.length) {
      lines.push("#### dependencies");
      for (const [name, version] of deps) lines.push(`- ${name}: ${version}`);
    }
    if (devDeps.length) {
      lines.push("#### dev-dependencies");
      for (const [name, version] of devDeps) lines.push(`- ${name}: ${version}`);
    }
    if (buildDeps.length) {
      lines.push("#### build-dependencies");
      for (const [name, version] of buildDeps) lines.push(`- ${name}: ${version}`);
    }
    
    if (deps.length + devDeps.length + buildDeps.length === 0) return "";
    return lines.join("\n");
  } catch {
    return "";
  }
}

export async function readPythonDeps(root: string): Promise<string> {
  const lines: string[] = ["### python"];
  let hasAny = false;
  
  try {
    const content = await fs.readFile(join(root, "pyproject.toml"), "utf8");
    const parsed = TOML.parse(content) as any;
    
    // PEP 621 dependencies (project.dependencies)
    const pepDeps = parsed.project?.dependencies;
    const pepOpt = parsed.project?.["optional-dependencies"];
    
    if (pepDeps && Array.isArray(pepDeps) && pepDeps.length) {
      hasAny = true;
      lines.push("#### pyproject (PEP 621)");
      lines.push("dependencies:");
      for (const dep of pepDeps.slice(0, DEP_LIST_CAP)) {
        lines.push(`- ${dep}`);
      }
    }
    
    if (pepOpt && typeof pepOpt === "object") {
      hasAny = true;
      if (!pepDeps || !pepDeps.length) {
        lines.push("#### pyproject (PEP 621)");
      }
      lines.push("optional-dependencies:");
      for (const [group, deps] of Object.entries(pepOpt)) {
        if (Array.isArray(deps)) {
          lines.push(`  ${group}:`);
          for (const dep of (deps as string[]).slice(0, DEP_LIST_CAP)) {
            lines.push(`  - ${dep}`);
          }
        }
      }
    }
    
    // Poetry dependencies
    const poetryDeps = parsed.tool?.poetry?.dependencies;
    const poetryDevDeps = 
      parsed.tool?.poetry?.group?.dev?.dependencies ||
      parsed.tool?.poetry?.["dev-dependencies"];
    
    if (poetryDeps && typeof poetryDeps === "object") {
      const deps: Array<[string, string]> = [];
      for (const [name, spec] of Object.entries(poetryDeps)) {
        if (name === "python") continue; // Skip Python version requirement
        const version = typeof spec === "string" ? spec : (spec as any)?.version || "(complex)";
        deps.push([name, version]);
      }
      
      if (deps.length) {
        hasAny = true;
        lines.push("#### pyproject (poetry)");
        lines.push("dependencies:");
        for (const [name, version] of capEntries(deps)) {
          lines.push(`- ${name}: ${version}`);
        }
      }
    }
    
    if (poetryDevDeps && typeof poetryDevDeps === "object") {
      const deps: Array<[string, string]> = [];
      for (const [name, spec] of Object.entries(poetryDevDeps)) {
        const version = typeof spec === "string" ? spec : (spec as any)?.version || "(complex)";
        deps.push([name, version]);
      }
      
      if (deps.length) {
        hasAny = true;
        if (!poetryDeps || Object.keys(poetryDeps).length === 0) {
          lines.push("#### pyproject (poetry)");
        }
        lines.push("dev-dependencies:");
        for (const [name, version] of capEntries(deps)) {
          lines.push(`- ${name}: ${version}`);
        }
      }
    }
  } catch {
    /* no pyproject.toml */
  }
  
  // requirements.txt (unchanged)
  try {
    const content = await fs.readFile(join(root, "requirements.txt"), "utf8");
    const reqs = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
    if (reqs.length) {
      hasAny = true;
      lines.push("#### requirements.txt");
      for (const r of reqs.slice(0, DEP_LIST_CAP)) lines.push(`- ${r}`);
    }
  } catch {
    /* no requirements.txt */
  }
  
  return hasAny ? lines.join("\n") : "";
}

async function readGoDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "go.mod"), "utf8");
    const lines: string[] = ["### go (go.mod)"];
    const reqs: Array<[string, string]> = [];
    let inBlock = false;
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (/^require\s*\(/.test(line)) {
        inBlock = true;
        continue;
      }
      if (inBlock && line === ")") {
        inBlock = false;
        continue;
      }
      if (inBlock) {
        const m = line.match(/^(\S+)\s+(\S+)/);
        if (m) reqs.push([m[1], m[2]]);
      } else {
        const single = line.match(/^require\s+(\S+)\s+(\S+)/);
        if (single) reqs.push([single[1], single[2]]);
      }
    }
    const capped = capEntries(reqs);
    if (!capped.length) return "";
    lines.push("#### require");
    for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

export async function readMavenDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "pom.xml"), "utf8");
    
    // Security: Disable all entity processing to prevent XXE attacks
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      parseTagValue: false,
      trimValues: true,
      processEntities: false,
    });
    
    const parsed = parser.parse(content);
    
    // Navigate to dependencies
    const dependencies = parsed.project?.dependencies?.dependency;
    if (!dependencies) return "";
    
    const deps: Array<[string, string]> = [];
    const depArray = Array.isArray(dependencies) ? dependencies : [dependencies];
    
    for (const dep of depArray) {
      const groupId = dep.groupId;
      const artifactId = dep.artifactId;
      const version = dep.version;
      
      if (groupId && artifactId) {
        deps.push([
          `${groupId}:${artifactId}`,
          version || "(managed)"
        ]);
      }
    }
    
    const capped = capEntries(deps);
    if (!capped.length) return "";
    
    const lines = ["### maven (pom.xml)", "#### dependencies"];
    for (const [name, version] of capped) {
      lines.push(`- ${name}: ${version}`);
    }
    
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function readGradleDeps(root: string): Promise<string> {
  const files = [
    "build.gradle",
    "build.gradle.kts",
    "app/build.gradle",
    "app/build.gradle.kts",
  ];
  
  for (const f of files) {
    try {
      const content = await fs.readFile(join(root, f), "utf8");
      const deps: Array<[string, string]> = [];
      
      // Match various Gradle dependency declarations
      // Supports: implementation, api, compileOnly, runtimeOnly, testImplementation, etc.
      const re =
        /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|debugImplementation|kapt|ksp|annotationProcessor)\s*\(?[\s\n]*['"]([^'"]+)['"]/g;
      
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const parts = m[1].split(":");
        if (parts.length >= 2) {
          const name = `${parts[0]}:${parts[1]}`;
          const version = parts.length >= 3 ? parts[2] : "?";
          deps.push([name, version]);
        }
      }
      
      const capped = capEntries(deps);
      if (!capped.length) continue;
      
      const lines = [`### gradle (${f})`, "#### dependencies"];
      for (const [name, version] of capped) {
        lines.push(`- ${name}: ${version}`);
      }
      
      return lines.join("\n");
    } catch {
      /* try next variant */
    }
  }
  
  return "";
}

export async function readDotNetDeps(root: string): Promise<string> {
  try {
    const entries = await fs.readdir(root);
    const csproj = entries.find((e) => e.endsWith(".csproj"));
    if (!csproj) return "";
    
    const content = await fs.readFile(join(root, csproj), "utf8");
    
    // Security: Disable all entity processing to prevent XXE attacks
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      parseTagValue: false,
      trimValues: true,
      processEntities: false,
    });
    
    const parsed = parser.parse(content);
    
    // Navigate to PackageReference elements
    const itemGroups = parsed.Project?.ItemGroup;
    if (!itemGroups) return "";
    
    const deps: Array<[string, string]> = [];
    const groups = Array.isArray(itemGroups) ? itemGroups : [itemGroups];
    
    for (const group of groups) {
      const refs = group.PackageReference;
      if (!refs) continue;
      
      const refArray = Array.isArray(refs) ? refs : [refs];
      for (const ref of refArray) {
        const name = ref["@_Include"];
        const version = ref["@_Version"];
        
        if (name && version) {
          deps.push([name, version]);
        }
      }
    }
    
    const capped = capEntries(deps);
    if (!capped.length) return "";
    
    const lines = [`### nuget (${csproj})`, "#### PackageReference"];
    for (const [name, version] of capped) {
      lines.push(`- ${name}: ${version}`);
    }
    
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** Extract string items from a Ruby/Ruby-style `gem "name", "version", ...` line list. */
function parseGemLines(lines: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
    if (m) out.push([m[1], m[2] ?? "latest"]);
  }
  return out;
}

async function readPhpDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "composer.json"), "utf8");
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const req = (pkg.require ?? {}) as Record<string, string>;
    const devReq = (pkg["require-dev"] ?? {}) as Record<string, string>;
    const lines: string[] = ["### php (composer.json)"];
    const reqEntries = capEntries(Object.entries(req).filter(([n]) => n !== "php"));
    const devEntries = capEntries(Object.entries(devReq));
    if (reqEntries.length) {
      lines.push("#### require");
      for (const [n, v] of reqEntries) lines.push(`- ${n}: ${v}`);
    }
    if (devEntries.length) {
      lines.push("#### require-dev");
      for (const [n, v] of devEntries) lines.push(`- ${n}: ${v}`);
    }
    if (reqEntries.length === 0 && devEntries.length === 0) return "";
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function readRubyDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "Gemfile"), "utf8");
    const lines = content.split(/\r?\n/);
    let groups: { label: string; deps: Array<[string, string]> }[] = [];
    const plainDeps: Array<[string, string]> = [];
    let inGroup: string | null = null;
    let groupDeps: Array<[string, string]> = [];
    for (const raw of lines) {
      const line = raw.trim();
      const gOpen = line.match(/^group\s+([^do]+?)\s+do\s*$/);
      if (gOpen) {
        inGroup = gOpen[1].trim().replace(/[:,]/g, " ").trim().replace(/\s+/g, ",");
        groupDeps = [];
        continue;
      }
      if (inGroup && line === "end") {
        if (groupDeps.length) groups.push({ label: inGroup, deps: groupDeps });
        inGroup = null;
        groupDeps = [];
        continue;
      }
      const parsed = parseGemLines([line]);
      if (!parsed.length) continue;
      if (inGroup) groupDeps.push(...parsed);
      else plainDeps.push(...parsed);
    }
    groups = groups.filter((g) => g.deps.length);
    if (!plainDeps.length && !groups.length) return "";
    const out = ["### ruby (Gemfile)"];
    if (plainDeps.length) {
      out.push("#### gems");
      for (const [n, v] of capEntries(plainDeps)) out.push(`- ${n}: ${v}`);
    }
    for (const g of groups) {
      out.push(`#### group: ${g.label}`);
      for (const [n, v] of capEntries(g.deps)) out.push(`- ${n}: ${v}`);
    }
    return out.join("\n");
  } catch {
    return "";
  }
}

async function readSwiftDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "Package.swift"), "utf8");
    const deps: Array<[string, string]> = [];
    const re =
      /\.package\s*\(\s*url:\s*["']([^"']+)["']\s*,\s*(?:from:\s*["']([^"']+)["']|\.\s*exact\s*\(\s*["']([^"']+)["']\s*\)|["']([^"']+)["'])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const url = m[1];
      const ver = m[2] ?? m[3] ?? m[4] ?? "?";
      deps.push([url, ver]);
    }
    const capped = capEntries(deps);
    if (!capped.length) return "";
    const lines = ["### swift (Package.swift)", "#### dependencies"];
    for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function readDartDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "pubspec.yaml"), "utf8");
    const lines = content.split(/\r?\n/);
    const out: string[] = ["### dart (pubspec.yaml)"];
    let section: "deps" | "dev" | null = null;
    let depLines: string[] = [];
    let devLines: string[] = [];
    let inSection = false;
    for (const raw of lines) {
      if (/^dependencies:\s*$/.test(raw)) {
        inSection = true;
        section = "deps";
        continue;
      }
      if (/^dev_dependencies:\s*$/.test(raw)) {
        inSection = true;
        section = "dev";
        continue;
      }
      if (inSection && /^\S/.test(raw)) {
        inSection = false;
        section = null;
        continue;
      }
      if (!inSection || !section) continue;
      const m = raw.match(/^\s+([A-Za-z0-9_.\-]+)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      if (m[2] === "^" || m[2].startsWith("any") || m[2] === "null") continue;
      if (m[2].startsWith("git:") || m[2].startsWith("path:")) {
        if (section === "deps") depLines.push(`${m[1]}: ${m[2]}`);
        else devLines.push(`${m[1]}: ${m[2]}`);
        continue;
      }
      if (section === "deps") depLines.push(`${m[1]}: ${m[2]}`);
      else devLines.push(`${m[1]}: ${m[2]}`);
    }
    if (depLines.length) {
      out.push("#### dependencies");
      out.push(...depLines.slice(0, DEP_LIST_CAP).map((l) => `- ${l}`));
    }
    if (devLines.length) {
      out.push("#### dev_dependencies");
      out.push(...devLines.slice(0, DEP_LIST_CAP).map((l) => `- ${l}`));
    }
    if (!depLines.length && !devLines.length) return "";
    return out.join("\n");
  } catch {
    return "";
  }
}

async function readElixirDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "mix.exs"), "utf8");
    const deps: Array<[string, string]> = [];
    const re = /\{\s*:([A-Za-z0-9_.\-]+)\s*,\s*(?:"([^"]+)"|~r"([^"]+)"|\{([^}]+)\})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      const ver = m[2] ?? m[3] ?? m[4] ?? "?";
      deps.push([name, ver.replace(/[\s"]+/g, " ").trim()]);
    }
    const capped = capEntries(deps);
    if (!capped.length) return "";
    const lines = ["### elixir (mix.exs)", "#### deps"];
    for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function readClojureDeps(root: string): Promise<string> {
  for (const [file, label] of [
    ["project.clj", "leiningen"],
    ["deps.edn", "tools.deps"],
  ] as const) {
    try {
      const content = await fs.readFile(join(root, file), "utf8");
      const deps: Array<[string, string]> = [];
      if (file === "project.clj") {
        const re = /\[([A-Za-z0-9_.\-\/]+)\s+["']?([^"'\]\s]+)["']?\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          if (m[1] === "defproject") continue;
          deps.push([m[1], m[2]]);
        }
      } else {
        const re = /([A-Za-z0-9_.\-\/]+)\s*\{(?::mvn\/version\s+"([^"]+)"|:git\/url\s+"([^"]+)")/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          deps.push([m[1], m[2] ?? `git:${m[3]}`]);
        }
      }
      const capped = capEntries(deps);
      if (!capped.length) continue;
      const lines = [`### clojure (${file}, ${label})`, "#### dependencies"];
      for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
      return lines.join("\n");
    } catch {
      /* try next manifest */
    }
  }
  return "";
}

async function readScalaDeps(root: string): Promise<string> {
  const files = ["build.sbt", "project/Dependencies.scala", "project/plugins.sbt"];
  const all: Array<[string, string]> = [];
  let usedFile = "";
  for (const f of files) {
    try {
      const content = await fs.readFile(join(root, f), "utf8");
      const re = /["']([A-Za-z0-9_.\-]+)\s*%[+%]?\s*["']?([A-Za-z0-9_.\-]+)["']?\s*%[+%]?\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      const found: Array<[string, string]> = [];
      while ((m = re.exec(content)) !== null) found.push([`${m[1]}:${m[2]}`, m[3]]);
      if (found.length) {
        all.push(...found);
        if (!usedFile) usedFile = f;
      }
    } catch {
      /* skip */
    }
  }
  const capped = capEntries(all);
  if (!capped.length) return "";
  const lines = [`### scala (${usedFile})`, "#### libraryDependencies"];
  for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
  return lines.join("\n");
}

async function readCppDeps(root: string): Promise<string> {
  const tryFiles: Array<[string, string]> = [
    ["vcpkg.json", "vcpkg"],
    ["conanfile.txt", "conan"],
    ["conanfile.py", "conan"],
  ];
  for (const [file, tool] of tryFiles) {
    try {
      const content = await fs.readFile(join(root, file), "utf8");
      const deps: Array<[string, string]> = [];
      if (file === "vcpkg.json") {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        const arr = (pkg.dependencies ?? []) as Array<string | Record<string, string>>;
        for (const d of arr) {
          if (typeof d === "string") deps.push([d, "latest"]);
          else if (d && typeof d === "object") {
            const name = (d as Record<string, string>).name ?? "?";
            const version = (d as Record<string, string>).version ?? "latest";
            deps.push([name, version]);
          }
        }
      } else {
        const m = content.match(/\[requires\]([\s\S]*?)(?:\[|$)/);
        if (m) {
          for (const line of m[1].split(/\r?\n/)) {
            const mm = line.trim().match(/^([^/\s]+)\/([^\s]+)/);
            if (mm) deps.push([mm[1], mm[2]]);
          }
        }
      }
      const capped = capEntries(deps);
      if (!capped.length) continue;
      const lines = [`### cpp (${file}, ${tool})`, "#### dependencies"];
      for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
      return lines.join("\n");
    } catch {
      /* try next */
    }
  }
  return "";
}

async function readHaskellDeps(root: string): Promise<string> {
  for (const file of ["package.yaml", "hpack.yaml"]) {
    try {
      const content = await fs.readFile(join(root, file), "utf8");
      const deps: Array<[string, string]> = [];
      const m = content.match(/^dependencies:\s*([\s\S]*?)(?=^\S|\z)/m);
      if (m) {
        for (const line of m[1].split(/\r?\n/)) {
          const mm = line.match(/^\s+-\s+([A-Za-z0-9_.\-]+)(?:\s*-\s*(.+))?$/);
          if (mm) deps.push([mm[1], mm[2] ?? "latest"]);
        }
      }
      const capped = capEntries(deps);
      if (!capped.length) continue;
      const lines = [`### haskell (${file})`, "#### dependencies"];
      for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
      return lines.join("\n");
    } catch {
      /* try next */
    }
  }
  try {
    const entries = await fs.readdir(root);
    const cabal = entries.find((e) => e.endsWith(".cabal"));
    if (cabal) {
      const content = await fs.readFile(join(root, cabal), "utf8");
      const deps: Array<[string, string]> = [];
      const m = content.match(/build-depends:\s*([\s\S]*?)(?:^\S|\z)/im);
      if (m) {
        for (const raw of m[1].split(/\r?\n/)) {
          for (const part of raw.split(",")) {
            const mm = part.trim().match(/^([A-Za-z0-9_.\-]+)(?:\s*(==|>=|<=|>|<)\s*(.+))?$/);
            if (mm && mm[1] !== "") deps.push([mm[1], mm[3] ? `${mm[2]}${mm[3]}` : "any"]);
          }
        }
      }
      const capped = capEntries(deps);
      if (capped.length) {
        const lines = [`### haskell (${cabal})`, "#### build-depends"];
        for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
        return lines.join("\n");
      }
    }
  } catch {
    /* no cabal */
  }
  return "";
}

async function readJuliaDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "Project.toml"), "utf8");
    const lines = content.split(/\r?\n/);
    const out: string[] = ["### julia (Project.toml)"];
    let inDeps = false;
    let inCompat = false;
    const deps: Array<[string, string]> = [];
    const compat: Array<[string, string]> = [];
    for (const raw of lines) {
      if (/^\[deps\]\s*$/.test(raw)) {
        inDeps = true;
        inCompat = false;
        continue;
      }
      if (/^\[compat\]\s*$/.test(raw)) {
        inDeps = false;
        inCompat = true;
        continue;
      }
      if (/^\[/.test(raw)) {
        inDeps = false;
        inCompat = false;
        continue;
      }
      const m = raw.match(/^([A-Za-z0-9_.\-]+)\s*=\s*"([^"]+)"/);
      if (!m) continue;
      if (inDeps) deps.push([m[1], m[2]]);
      else if (inCompat) compat.push([m[1], m[2]]);
    }
    const merged = new Map<string, string>();
    for (const [n] of deps) merged.set(n, compat.find(([c]) => c === n)?.[1] ?? "any");
    if (!merged.size) return "";
    out.push("#### deps (with compat)");
    for (const [n, v] of capEntries(Array.from(merged.entries()))) out.push(`- ${n}: ${v}`);
    return out.join("\n");
  } catch {
    return "";
  }
}

async function readRDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "DESCRIPTION"), "utf8");
    const m = content.match(/^Imports:\s*([\s\S]*?)(?=^\S|\z)/m);
    if (!m) return "";
    const deps: Array<[string, string]> = [];
    for (const raw of m[1].split(/\r?\n/)) {
      for (const part of raw.split(",")) {
        const mm = part.trim().match(/^([A-Za-z0-9_.\-]+)(?:\s*\(([^)]+)\))?$/);
        if (mm) deps.push([mm[1], mm[2] ?? "any"]);
      }
    }
    const capped = capEntries(deps);
    if (!capped.length) return "";
    const lines = ["### r (DESCRIPTION)", "#### Imports"];
    for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function readPerlDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "cpanfile"), "utf8");
    const deps: Array<[string, string]> = [];
    const re =
      /(?:requires|recommends|suggests|test_requires|build_requires)\s+['"]([^'"]+)['"](?:\s*,\s*['"]?([^'"]+)['']?)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) deps.push([m[1], m[2] ?? "any"]);
    const capped = capEntries(deps);
    if (!capped.length) return "";
    const lines = ["### perl (cpanfile)", "#### requires"];
    for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function readLuaDeps(root: string): Promise<string> {
  try {
    const entries = await fs.readdir(root);
    const rockspec = entries.find((e) => e.endsWith(".rockspec"));
    if (!rockspec) return "";
    const content = await fs.readFile(join(root, rockspec), "utf8");
    const deps: Array<[string, string]> = [];
    const re = /["']([A-Za-z0-9_.\-]+)\s+([0-9][^"'\s]*)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) deps.push([m[1], m[2]]);
    const capped = capEntries(deps);
    if (!capped.length) return "";
    const lines = [`### lua (${rockspec})`, "#### dependencies"];
    for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function readErlangDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "rebar.config"), "utf8");
    const deps: Array<[string, string]> = [];
    const re = /\{\s*([A-Za-z0-9_.\-]+)\s*,\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) deps.push([m[1], m[2]]);
    const capped = capEntries(deps);
    if (!capped.length) return "";
    const lines = ["### erlang (rebar.config)", "#### deps"];
    for (const [name, version] of capped) lines.push(`- ${name}: ${version}`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function readCangjieDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "cjpm.toml"), "utf8");
    const parsed = TOML.parse(content) as any;
    
    const dependencies = parsed.dependencies;
    if (!dependencies || typeof dependencies !== "object") return "";
    
    const deps: Array<[string, string]> = [];
    
    for (const [name, spec] of Object.entries(dependencies)) {
      if (name === "version" || name === "edition") continue;
      
      let version = "?";
      
      if (typeof spec === "string") {
        // Simple string version: "1.2.3"
        version = spec;
      } else if (spec && typeof spec === "object") {
        const depSpec = spec as any;
        
        // Check for version field
        if (depSpec.version) {
          version = depSpec.version;
        }
        // Cangjie packages are often pinned by git+tag/branch
        else if (depSpec.git) {
          if (depSpec.tag) {
            version = `git:${depSpec.tag}`;
          } else if (depSpec.branch) {
            version = `git:${depSpec.branch}`;
          } else {
            version = "git:HEAD";
          }
        }
      }
      
      deps.push([name, version]);
    }
    
    const capped = capEntries(deps);
    if (!capped.length) return "";
    
    const lines = ["### cangjie (cjpm.toml)", "#### dependencies"];
    for (const [name, version] of capped) {
      lines.push(`- ${name}: ${version}`);
    }
    
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** Strip JSON5-only syntax (comments + trailing commas) so JSON.parse works. */
function stripJson5(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|[^:])\/\/.*$/gm, "$1");
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out;
}

/**
 * Read OpenHarmony/HarmonyOS manifests (oh-package.json5 / oh-package.json),
 * including root and module subdirectories (entry/, library/, ...). ArkTS
 * projects may split runtime deps across module-level manifests.
 */
async function readHarmonyDeps(root: string): Promise<string> {
  const candidates: string[] = [
    join(root, "oh-package.json5"),
    join(root, "oh-package.json"),
  ];
  try {
    const entries = await fs.readdir(root);
    for (const e of entries) {
      const full = join(root, e);
      try {
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
          candidates.push(join(full, "oh-package.json5"));
          candidates.push(join(full, "oh-package.json"));
        }
      } catch {
        /* skip unreadable entry */
      }
    }
  } catch {
    /* root unreadable */
  }

  const seen = new Set<string>();
  const sections: string[] = [];
  let hasAny = false;

  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      let content = await fs.readFile(path, "utf8");
      if (path.endsWith(".json5")) content = stripJson5(content);
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const deps = (pkg.dependencies ?? {}) as Record<string, string>;
      const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
      const depEntries = capEntries(Object.entries(deps));
      const devEntries = capEntries(Object.entries(devDeps));
      if (!depEntries.length && !devEntries.length) continue;
      hasAny = true;
      const rel = upath.relative(root, path);
      const label =
        rel === "oh-package.json5" || rel === "oh-package.json"
          ? "root"
          : rel;
      const block: string[] = [`#### ${label}`];
      for (const [n, v] of depEntries) block.push(`- ${n}: ${v}`);
      if (devEntries.length) {
        block.push("##### devDependencies");
        for (const [n, v] of devEntries) block.push(`- ${n}: ${v}`);
      }
      sections.push(block.join("\n"));
    } catch {
      /* skip unreadable manifest */
    }
  }

  if (!hasAny) return "";
  return ["### harmonyos (oh-package.json5)", ...sections].join("\n");
}

/**
 * Parse build.zig.zon dependencies. ZON uses Zig struct literal syntax:
 *   .dependencies = {
 *     .name = { .url = "https://...", .hash = "1220..." },
 *     .foo = { .path = "../foo" },
 *   }
 * Each entry becomes `<name>: <url|path>`. Git deps emit the host+path.
 */
async function readZigDeps(root: string): Promise<string> {
  try {
    const content = await fs.readFile(join(root, "build.zig.zon"), "utf8");
    const depsBlock = content.match(/\.dependencies\s*=\s*\{([\s\S]*?)\n\s*\}/);
    if (!depsBlock) return "";
    const deps: Array<[string, string]> = [];
    const re =
      /\.([A-Za-z0-9_.\-]+)\s*=\s*\.\{[\s\S]*?(?:\.url\s*=\s*"(https?:\/\/[^"]+)"|\.path\s*=\s*"([^"]+)")[\s\S]*?\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(depsBlock[1])) !== null) {
      const name = m[1];
      const ref = m[2] ?? `path:${m[3]}`;
      deps.push([name, ref]);
    }
    const capped = capEntries(deps);
    if (!capped.length) return "";
    const lines = ["### zig (build.zig.zon)", "#### dependencies"];
    for (const [name, ref] of capped) lines.push(`- ${name}: ${ref}`);
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Assemble initial context into `messages`.
 *
 * Sources are collected with the existing parallel I/O pattern, then an
 * independent, deterministic policy chooses the smallest sufficient set of
 * optional blocks. Rules, explicit mentions, active work state, and document
 * workflow context remain mandatory; indexed search snippets only navigate to
 * a future fresh read and never become source evidence.
 */
export async function buildInitialContext(args: BuildContextArgs): Promise<BuildContextResult> {
  const { opts, memory, budgets, systemPrompt, contextNode, anchorsNode, messages } = args;
  const timer = new PerformanceTimer();
  const log = (step: string, detail?: Record<string, unknown>) => {
    console.log(`[context] ${step} +${timer.elapsedFormatted()}`, detail ?? "");
    timer.reset();
  };

  const ctxEnabled = !contextNode || contextNode.enabled !== false;
  const ctxParams = (contextNode?.params ?? {}) as Record<string, unknown>;
  const contextControl = new ContextControlState(
    opts.workspaceRoot,
    resolveContextControlConfig(ctxParams.contextControl),
  );
  const anchorsEnabled =
    opts.mode === "agent" &&
    (anchorsNode ? anchorsNode.enabled !== false : ctxParams.injectAnchors !== false);
  const mentionPaths = extractMentionPaths(opts.userMessage);
  const activePaths = opts.activePlan ? extractPathsFromPlan(opts.activePlan.content) : [];
  const selectionMode = resolveMinimumContextConfig(ctxParams.contextSelection, 0).mode;

  if (contextNode && ctxEnabled) emitStage(opts.onEvent, "start", contextNode);
  log("stage_start emitted");

  const basePromptTokens = estimateTokens(systemPrompt);
  let budgetUsed = basePromptTokens;
  let contextCharsUsed = systemPrompt.length;
  // Preserve the pre-selection high-water behavior for `off` and `observe`.
  // It intentionally tracks only the old optional memory sources.
  let legacyOptionalBudgetUsed = basePromptTokens;
  
  // Track platform info and prompt optimizer separately for fixed segments
  let platformInfoTokens = 0;
  let promptOptimizerTokens = 0;
  
  // Import message tagging utilities for semantic content wrapping
  const {
    tagPlatformInfo,
    tagProjectContext,
    tagMemory,
    tagRetrievedContext,
  } = await import("../message-tags.js");
  
  // Track which semantic sections we're building
  const projectContextParts: string[] = [];
  
  const pushSystem = (content: string, tag?: "platform" | "project" | "memory" | "retrieved"): void => {
    if (!content.trim()) return;
    
    // If a semantic tag is specified, collect it for later wrapping
    if (tag === "project") {
      projectContextParts.push(content);
      budgetUsed += estimateTokens(content);
      contextCharsUsed += content.length;
      return;
    }
    
    // For other tags, wrap immediately
    let wrappedContent = content;
    if (tag === "platform") {
      wrappedContent = tagPlatformInfo(content);
      platformInfoTokens += estimateTokens(content);
    } else if (tag === "memory") {
      wrappedContent = tagMemory(content);
    } else if (tag === "retrieved") {
      wrappedContent = tagRetrievedContext(content);
    }
    
    messages.push({ role: "system", content: wrappedContent });
    budgetUsed += estimateTokens(content); // Use original content for token counting
    contextCharsUsed += content.length;
  };

  pushSystem(buildPlatformInfo(), "platform");

  // Tech stack, project size, and project rules are now candidates (truncatable).
  // They will be added to the candidate pool later.
  
  const mentionPromise =
    ctxEnabled && ctxParams.injectMentions !== false
      ? loadMentionedFiles(opts.workspaceRoot, mentionPaths)
      : Promise.resolve([]);
  const retrievalPromise = runRetrieval(opts, ctxEnabled, ctxParams, budgets.files);

  // ── Adaptive Prompt Optimization: inject learned failure patterns ──
  // This is a fixed segment that is ALWAYS sent and NEVER truncated.
  // Injected AFTER platform info so the cache-friendly prefix remains
  // byte-stable across turns. promptOptContext changes when failure
  // patterns are learned or success-rate thresholds are crossed.
  const promptOptContext = opts.promptOptimizer?.generateContext(opts.mode) ?? "";
  if (promptOptContext.trim()) {
    const promptOptContent = tagProjectContext(promptOptContext);
    messages.push({ role: "system", content: promptOptContent });
    promptOptimizerTokens = estimateTokens(promptOptContext);
    budgetUsed += promptOptimizerTokens;
    contextCharsUsed += promptOptContext.length;
  }

  const candidates: ContextCandidate[] = [];
  let candidateNumber = 0;
  const addCandidate = (
    candidate: Omit<ContextCandidate, "id" | "estimatedTokens"> & { id?: string },
  ): void => {
    const content = candidate.content.trim();
    if (!content) return;
    candidates.push({
      ...candidate,
      content,
      id: candidate.id ?? `${candidate.source}:${candidateNumber}`,
      estimatedTokens: estimateTokens(content),
    });
    candidateNumber += 1;
  };

  // ── Add tech stack as truncatable candidate ──
  if (ctxEnabled) {
    try {
      const idxStatus = opts.index.status();
      const techStackLines: string[] = [];
      if (idxStatus.root) {
        techStackLines.push(`- Workspace root: \`${idxStatus.root}\``);
      }
      if (typeof idxStatus.fileCount === "number" && idxStatus.fileCount > 0) {
        techStackLines.push(`- Indexed source files: ${idxStatus.fileCount}`);
      }
      if (typeof idxStatus.tagCount === "number" && idxStatus.tagCount > 0) {
        techStackLines.push(`- Indexed symbols: ${idxStatus.tagCount}`);
      }
      // Note: idxStatus.kind is the index build state (idle/building/ready/error),
      // not the project kind, so it is deliberately not surfaced here.
      const ecosystems = await detectProjectEcosystem(opts.workspaceRoot);
      if (ecosystems.length > 0) {
        techStackLines.push(`- Detected project stack: ${ecosystems.join("; ")}`);
      } else {
        techStackLines.push(
          "- Detected project stack: unknown (no recognized manifest such as pom.xml, build.gradle, package.json or Cargo.toml found at the workspace root).",
        );
      }
      if (techStackLines.length > 0) {
        addCandidate({
          source: "tech-stack",
          content: [
            "## Project Tech Stack",
            ...techStackLines,
            "- Use `list_dir` / `repo_map` / `read_file` for deeper structure on demand — the summary above is intentionally compact.",
          ].join("\n"),
          provenance: "project tech stack",
          freshness: "current",
          mandatory: false, // Truncatable
        });
      }
    } catch {
      // Index not ready or unavailable — skip silently
    }
  }

  // ── Add project size as truncatable candidate ──
  if (ctxEnabled) {
    try {
      const idxStatus = opts.index.status();
      if (typeof idxStatus.fileCount === "number" && idxStatus.fileCount > 0) {
        const isLarge = idxStatus.fileCount >= 1500;
        addCandidate({
          source: "project-size",
          content: [
            "## Project Size",
            `- Indexed source files: ${idxStatus.fileCount}`,
            isLarge
              ? "- This is a **large project** (≥1500 source files). Do NOT run full build commands (mvn compile, mvn verify, mvn package, gradle build, cargo build, npm run build, etc.). Use targeted checks only (type_check, lsp_diagnostics, or bash for specific commands)."
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          provenance: "project size information",
          freshness: "current",
          mandatory: false, // Truncatable
        });
      }
    } catch {
      // Index not ready or unavailable — skip silently
    }
  }

  // ── Add project rules as truncatable candidate ──
  if (ctxEnabled && ctxParams.injectRules !== false && opts.projectRules?.trim()) {
    addCandidate({
      source: "rules",
      content: `## Project rules\nFollow these project-specific rules unless the user explicitly overrides them.\n\n${opts.projectRules.trim()}`,
      provenance: "project-specific rules",
      freshness: "current",
      mandatory: false, // Truncatable
    });
  }

  if (ctxEnabled && ctxParams.injectMemories !== false && opts.memoriesBlock?.trim()) {
    addCandidate({
      source: "memory",
      content: clampText(opts.memoriesBlock, Math.floor(budgets.system * 0.2)),
      provenance: "saved user preferences",
      freshness: "current",
      mandatory: true,
    });
  }

  const knowledgeCtx = memory.getKnowledgeContext(opts.userMessage);
  if (
    ctxEnabled &&
    knowledgeCtx.trim() &&
    (selectionMode === "apply" || legacyOptionalBudgetUsed < budgets.total * 0.7)
  ) {
    const cap = Math.min(
      Math.floor(budgets.system * 0.2),
      Math.floor((budgets.total - legacyOptionalBudgetUsed) * 0.5),
    );
    if (cap > 100) {
      const content = clampText(knowledgeCtx, cap);
      addCandidate({
        source: "knowledge",
        content,
        provenance: "session knowledge",
        freshness: "unknown",
      });
      legacyOptionalBudgetUsed += estimateTokens(content);
    }
  }

  const shortTermCtx = memory.getShortTermContext();
  if (
    ctxEnabled &&
    shortTermCtx.trim() &&
    opts.history.length > 2 &&
    (selectionMode === "apply" || legacyOptionalBudgetUsed < budgets.total * 0.75)
  ) {
    const cap = Math.min(
      Math.floor(budgets.system * 0.15),
      Math.floor((budgets.total - legacyOptionalBudgetUsed) * 0.4),
    );
    if (cap > 100) {
      const content = clampText(shortTermCtx, cap);
      addCandidate({
        source: "short-term",
        content,
        provenance: "recent working memory",
        freshness: "unknown",
      });
      legacyOptionalBudgetUsed += estimateTokens(content);
    }
  }

  const mentionFiles = await mentionPromise;
  log("mentions loaded", { count: mentionFiles.length });
  if (ctxEnabled && ctxParams.injectMentions !== false) {
    const mentionsBlock = clampText(formatMentionsBlock(mentionFiles), budgets.files);
    if (mentionsBlock.trim()) {
      addCandidate({
        source: "mention",
        content: mentionsBlock,
        provenance: "explicit user @ mention",
        freshness: "current",
        mandatory: true,
      });
    }
  }

  const retrieval = await retrievalPromise;
  log("retrieval done", { hits: retrieval?.paths.length ?? 0 });
  if (retrieval) {
    for (const hit of retrieval.hits) {
      addCandidate({
        id: hit.id,
        source: "retrieval",
        content: hit.content,
        path: hit.path,
        provenance: retrieval.label,
        freshness: "indexed",
      });
    }
  }

  if (anchorsEnabled) {
    if (anchorsNode) emitStage(opts.onEvent, "start", anchorsNode);
    if (opts.activePlan) {
      const planBody = truncatePlanForContext(opts.activePlan.content, budgets.plan);
      addCandidate({
        source: "plan",
        path: opts.activePlan.path,
        content: [
          "## ACTIVE PLAN",
          `Path: ${opts.activePlan.path}`,
          activePaths.length ? `Hint writable files: ${activePaths.slice(0, 20).join(", ")}` : "",
          "",
          planBody,
        ].filter(Boolean).join("\n"),
        provenance: "active plan",
        freshness: "current",
        mandatory: true,
      });
    } else if (opts.todoAnchor?.trim()) {
      addCandidate({
        source: "todo",
        content: `## ACTIVE TODO\n${opts.todoAnchor.trim()}`,
        provenance: "active todo",
        freshness: "current",
        mandatory: true,
      });
    }
    if (anchorsNode) emitStage(opts.onEvent, "done", anchorsNode);
  }

  if (opts.documentWorkflow) {
    addCandidate({
      source: "workflow",
      content: `## DOCUMENT WORKFLOW\n${documentIntentContext(opts.documentWorkflow)}`,
      provenance: "document workflow state",
      freshness: "current",
      mandatory: true,
    });
  }

  // Knowledge graph population — independent of repo map context injection.
  // NOTE: Repo map is no longer injected as system context. It is available as
  // the `repo_map` tool for LLM to call on demand.
  if (ctxEnabled && !opts.disableKnowledgeGraph) {
    try {
      await memory.populateFromIndex(opts.index, opts.workspaceRoot);
      log("knowledge graph populated");
    } catch {
      /* knowledge graph population is best effort */
    }
  }

    // Git state is no longer injected as system context. It is available as
  // the `git_status` tool (plus readonly shell commands) for the LLM to call on demand.
  // Project dependencies are no longer injected as system context either.
  // They are available via the `project_deps` tool for the LLM to call on demand.

  // ── Compute token-based budget ──
  // Use new token-based budget system alongside legacy budgets for transition.
  // Fixed segments now separate platform info and prompt optimizer from
  // optional content (tech stack, project size, rules moved to candidates).
  const fixedSegments: FixedSegments = {
    systemPrompt: basePromptTokens,       // Built-in system prompt template + tool definitions
    platformInfo: platformInfoTokens,      // Platform information (OS, shell, etc)
    promptOptimizer: promptOptimizerTokens, // Adaptive prompt optimizer output (never truncated)
    toolDefs: 0,                          // @reserved — currently included in systemPrompt
    userInput: estimateTokens(opts.userMessage),
    taskDecomposition: 0,                 // @reserved — no independent task decomposition step yet
    activePlan: opts.activePlan ? estimateTokens(opts.activePlan.content) : 0,
    documentWorkflow: 0,                  // @reserved — tracked separately when workflow is active
  };
  const tokenBudget = computeContextBudget(opts.workflow.context, fixedSegments);

  // Emit overCapacity warning if fixed segments exceed input budget
  if (tokenBudget.overCapacity) {
    opts.onEvent?.({
      type: "context_warning",
      message: `Fixed segments (${tokenBudget.fixedTotal} tokens) exceed input budget (${tokenBudget.inputBudget} tokens). Consider increasing contextWindow.`,
      fixedTotal: tokenBudget.fixedTotal,
      inputBudget: tokenBudget.inputBudget,
    });
    console.warn("[context] overCapacity:", {
      fixedTotal: tokenBudget.fixedTotal,
      inputBudget: tokenBudget.inputBudget,
    });
  }

  const candidateCharacters = candidates.reduce((total, candidate) => total + candidate.content.length, 0);
  const candidateTokens = candidates.reduce((total, candidate) => total + candidate.estimatedTokens, 0);
  const guidanceReservation = retrieval
    ? retrievalGuidance(retrieval.label, retrieval.hits.length)
    : "";
  const guidanceTokens = estimateTokens(guidanceReservation);
  // Use token budget for capacity when available, with legacy fallback
  const promptTokenCapacity = proportionalTokenCapacity(
    tokenBudget.inputBudget,
    contextCharsUsed + candidateCharacters + guidanceReservation.length,
    budgetUsed + candidateTokens + guidanceTokens,
  );
  const defaultSelectionTokenBudget = proportionalTokenCapacity(
    tokenBudget.segments.toolResults + tokenBudget.segments.techStack,
    candidateCharacters,
    candidateTokens,
  );
  const requestedSelectionConfig = resolveMinimumContextConfig(
    ctxParams.contextSelection,
    defaultSelectionTokenBudget,
  );
  const availableCandidateTokens = Math.max(0, promptTokenCapacity - budgetUsed - guidanceTokens);
  const selectionConfig = requestedSelectionConfig.mode === "off"
    ? requestedSelectionConfig
    : {
        ...requestedSelectionConfig,
        tokenBudget: Math.min(requestedSelectionConfig.tokenBudget, availableCandidateTokens),
      };

  const contextPlan = planMinimumContext({
    task: {
      mode: opts.mode,
      intent: inferTaskIntent(opts.userMessage, opts.mode),
      query: opts.userMessage,
      explicitPaths: mentionPaths,
      activePaths,
    },
    candidates,
    config: selectionConfig,
  });
  const materializedIds = selectionConfig.mode === "observe"
    ? new Set(candidates.map((candidate) => candidate.id))
    : new Set(contextPlan.selected.map((candidate) => candidate.id));
  const materialized = candidates.filter((candidate) => materializedIds.has(candidate.id));

  // Register only index-derived file labels, never their excerpts. Omitted
  // candidates are retained too so a later focused current-source read has a
  // complete, per-turn provenance trail without needing to materialize content.
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  contextControl.registerIndexedCandidates([
    ...contextPlan.selected
      .filter((candidate) => candidate.freshness === "indexed" && Boolean(candidate.path))
      .map((candidate) => ({
        path: candidate.path!,
        source: candidate.source,
        selection: "selected" as const,
      })),
    ...contextPlan.omitted.flatMap((omitted) => {
      const candidate = candidateById.get(omitted.id);
      return candidate?.freshness === "indexed" && candidate.path
        ? [{ path: candidate.path, source: candidate.source, selection: "omitted" as const }]
        : [];
    }),
  ]);

  if (selectionConfig.mode === "observe" || selectionConfig.emitDecisionTrace) {
    console.log("[minimum-context]", JSON.stringify({
      ...summarizeMinimumContextPlan(contextPlan),
      promptTokenCapacity,
      availableCandidateTokens,
      materializedCandidateCount: materialized.length,
    }));
  }

  if (
    contextControl.config.progressiveExpansion &&
    selectionConfig.mode === "apply" &&
    contextPlan.requiresFreshRead.length
  ) {
    pushSystem(freshReadGuidance(contextPlan.requiresFreshRead));
  }

  let insertedRetrievalGuidance = false;
  const selectedRetrievals = materialized.filter((candidate) => candidate.source === "retrieval");
  for (const candidate of materialized) {
    if (candidate.source === "retrieval" && !insertedRetrievalGuidance) {
      pushSystem(retrievalGuidance(retrieval?.label ?? "Retrieval", selectedRetrievals.length));
      insertedRetrievalGuidance = true;
    }
    
    // Tag content based on its source type
    switch (candidate.source) {
      case "retrieval":
        pushSystem(candidate.content, "retrieved");
        break;
      case "memory":
      case "knowledge":
      case "short-term":
        pushSystem(candidate.content, "memory");
        break;
      case "tech-stack":
      case "project-size":
      case "rules":
        // These are project context candidates (truncatable)
        pushSystem(candidate.content, "project");
        break;
      default:
        pushSystem(candidate.content);
    }
  }
  
  // Wrap all collected project context parts with semantic tag
  if (projectContextParts.length > 0) {
    const wrappedProjectContext = tagProjectContext(projectContextParts.join("\n\n"));
    messages.push({ role: "system", content: wrappedProjectContext });
  }

  if (contextNode && ctxEnabled) emitStage(opts.onEvent, "done", contextNode);
  log("stage_done emitted", {
    budgetUsed,
    promptTokenCapacity,
    overCapacity: budgetUsed > promptTokenCapacity,
    selected: contextPlan.selected.length,
    omitted: contextPlan.omitted.length,
    mode: selectionConfig.mode,
  });

  if (contextControl.telemetryEnabled) {
    opts.onEvent?.({
      type: "minimum_context_decision",
      selectionMode: selectionConfig.mode,
      selectedCandidates: contextPlan.selected.length,
      omittedCandidates: contextPlan.omitted.length,
      materializedCandidates: materialized.length,
      indexedPaths: contextControl.indexedPathCount,
      requiresFreshRead: contextPlan.requiresFreshRead.length,
      budgetUsed,
      tokenBudget: contextPlan.tokenBudget,
    });
  }

  return { budgetUsed, contextControl, fixedSegments, tokenBudget };
}

// ── Platform Info ────────────────────────────────────────────

function buildPlatformInfo(): string {
  let osName: string;
  let pathSep: string;
  let shellHint: string;

  if (IS_WINDOWS) {
    osName = "Windows";
    pathSep = "\\";
    shellHint =
      "You are running on **Windows** with **PowerShell**. " +
      "All terminal (`bash` tool) commands execute in PowerShell. " +
      "Common commands have aliases (ls → Get-ChildItem, cat → Get-Content, cp → Copy-Item, rm → Remove-Item) " +
      "but flags are PowerShell-style, NOT Unix. DO NOT use Unix flags like `-la` or `-p`. " +
      "Examples: `Get-ChildItem -Force` (NOT `ls -la`), `New-Item -ItemType Directory -Force docs` (NOT `mkdir -p docs`). " +
      "npm/npx/pnpm/git/node work as usual on all platforms.";
  } else if (PLATFORM === "darwin") {
    osName = "macOS";
    pathSep = "/";
    shellHint = "You are running on **macOS** with a Unix shell. Standard Unix commands are safe to use.";
  } else {
    osName = "Linux";
    pathSep = "/";
    shellHint = "You are running on **Linux** with a Unix shell. Standard Unix commands are safe to use.";
  }

  return [
    "## 运行环境 (Platform Info)",
    `- 操作系统 (OS): ${osName} (${PLATFORM})`,
    `- 版本 (Release): ${OS_RELEASE}`,
    `- 路径分隔符 (Path separator): \`${pathSep}\``,
    `- ${shellHint}`,
    "",
  ].join("\n");
}
