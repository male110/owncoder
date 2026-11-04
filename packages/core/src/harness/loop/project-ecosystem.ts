import { promises as fs } from "node:fs";
import { join } from "node:path";

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
