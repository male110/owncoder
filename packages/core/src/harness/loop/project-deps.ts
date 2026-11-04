import { promises as fs } from "node:fs";
import { join } from "node:path";
import upath from "upath";
import TOML from "@iarna/toml";
import { XMLParser } from "fast-xml-parser";

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
