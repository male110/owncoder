import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import {
  DEFAULT_WORKSPACE_FOLDER,
  LEGACY_DEFAULT_WORKSPACE_FOLDER,
  defaultWorkspacePath,
} from "./default-workspace";

export interface RecentWorkspace {
  root: string;
  name: string;
  openedAt: string;
}

export interface RecentState {
  lastWorkspace: RecentWorkspace | null;
  projects: RecentWorkspace[];
}

function normRoot(root: string): string {
  // Lowercase drive letter on Windows so path compares stay stable.
  const n = normalize(root);
  return process.platform === "win32" && /^[A-Za-z]:/.test(n)
    ? n.charAt(0).toUpperCase() + n.slice(1)
    : n;
}

function isBuiltinProjectName(name: string | undefined): boolean {
  return name === DEFAULT_WORKSPACE_FOLDER || name === LEGACY_DEFAULT_WORKSPACE_FOLDER;
}

function isBuiltinProjectRoot(root: string, builtinRoot: string | null): boolean {
  if (builtinRoot && normRoot(root) === normRoot(builtinRoot)) return true;
  const base = basename(root);
  return base === DEFAULT_WORKSPACE_FOLDER || base === LEGACY_DEFAULT_WORKSPACE_FOLDER;
}

/** App-level recent projects (userData/owncoder/recent.json). */
export class RecentStore {
  private file: string;
  private builtinRoot: string | null = null;

  constructor(userDataDir: string) {
    const dir = join(userDataDir, "owncoder");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "recent.json");
    this.builtinRoot = defaultWorkspacePath(userDataDir);
  }

  /** Keep built-in sandbox path in sync after migration renames. */
  setBuiltinRoot(root: string): void {
    this.builtinRoot = root;
  }

  private rewriteLegacyRoots(entry: RecentWorkspace): RecentWorkspace {
    const builtin = this.builtinRoot;
    if (!builtin) return entry;
    const base = basename(entry.root);
    // Drop stale @owncode/.../OwnCodeProject paths onto the migrated built-in root.
    if (
      base === LEGACY_DEFAULT_WORKSPACE_FOLDER ||
      (base === DEFAULT_WORKSPACE_FOLDER &&
        /(?:^|[\\/])@owncode[\\/]/i.test(entry.root)) ||
      (builtin &&
        isBuiltinProjectRoot(entry.root, builtin) &&
        normRoot(entry.root) !== normRoot(builtin))
    ) {
      return {
        root: builtin,
        name: DEFAULT_WORKSPACE_FOLDER,
        openedAt: entry.openedAt,
      };
    }
    if (isBuiltinProjectName(entry.name) && normRoot(entry.root) === normRoot(builtin)) {
      return { ...entry, name: DEFAULT_WORKSPACE_FOLDER };
    }
    return entry;
  }

  /**
   * Dedupe by root, map legacy built-in paths, and pin OwnCoderProject at the bottom.
   */
  private normalizeState(state: RecentState): RecentState {
    const rewrite = (e: RecentWorkspace | null): RecentWorkspace | null =>
      e?.root ? this.rewriteLegacyRoots({
        root: e.root,
        name: e.name || "workspace",
        openedAt: e.openedAt || new Date().toISOString(),
      }) : null;

    const lastWorkspace = rewrite(state.lastWorkspace);

    const seen = new Set<string>();
    const regular: RecentWorkspace[] = [];
    let builtin: RecentWorkspace | null = null;

    for (const raw of state.projects) {
      if (!raw?.root) continue;
      const p = this.rewriteLegacyRoots({
        root: raw.root,
        name: raw.name || "workspace",
        openedAt: raw.openedAt || new Date().toISOString(),
      });
      const key = normRoot(p.root);
      if (seen.has(key)) continue;
      seen.add(key);
      if (isBuiltinProjectRoot(p.root, this.builtinRoot)) {
        builtin = {
          root: this.builtinRoot ?? p.root,
          name: DEFAULT_WORKSPACE_FOLDER,
          openedAt: p.openedAt,
        };
        continue;
      }
      regular.push(p);
    }

    // Always keep the built-in entry last when we know its path.
    if (!builtin && this.builtinRoot && existsSync(this.builtinRoot)) {
      builtin = {
        root: this.builtinRoot,
        name: DEFAULT_WORKSPACE_FOLDER,
        openedAt: new Date(0).toISOString(),
      };
    }

    const projects = builtin ? [...regular, builtin].slice(0, 20) : regular.slice(0, 20);
    return { lastWorkspace, projects };
  }

  private save(state: RecentState): void {
    const normalized = this.normalizeState(state);
    writeFileSync(this.file, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  }

  load(): RecentState {
    if (!existsSync(this.file)) return { lastWorkspace: null, projects: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as RecentState;
      const last = raw.lastWorkspace?.root
        ? {
            root: raw.lastWorkspace.root,
            name: raw.lastWorkspace.name || "workspace",
            openedAt: raw.lastWorkspace.openedAt || new Date().toISOString(),
          }
        : null;
      const projects = Array.isArray(raw.projects)
        ? raw.projects
            .filter((p) => p?.root)
            .map((p) => ({
              root: p.root,
              name: p.name || "workspace",
              openedAt: p.openedAt || new Date().toISOString(),
            }))
        : last
          ? [last]
          : [];
      return this.normalizeState({ lastWorkspace: last, projects });
    } catch {
      return { lastWorkspace: null, projects: [] };
    }
  }

  setLastWorkspace(root: string, name: string): void {
    const openedAt = new Date().toISOString();
    const entry: RecentWorkspace = { root, name, openedAt };
    const prev = this.load();
    // Only update lastWorkspace, keep projects order unchanged (normalize still pins built-in last).
    this.save({ lastWorkspace: entry, projects: prev.projects });
  }

  /**
   * Ensure a project appears in the sidebar without switching the active workspace.
   * Built-in OwnCoderProject is always appended last; other projects prepend.
   */
  ensureProject(root: string, name: string): void {
    const prev = this.load();
    if (prev.projects.some((p) => normRoot(p.root) === normRoot(root))) {
      // Still rewrite/persist so legacy OwnCodeProject paths collapse after migration.
      this.save(prev);
      return;
    }
    const entry: RecentWorkspace = { root, name, openedAt: new Date().toISOString() };
    const projects = isBuiltinProjectRoot(root, this.builtinRoot) || isBuiltinProjectName(name)
      ? [...prev.projects, entry]
      : [entry, ...prev.projects];
    this.save({ lastWorkspace: prev.lastWorkspace, projects });
  }

  listProjects(): RecentWorkspace[] {
    // load() already normalizes order; filter missing roots but keep built-in last.
    const state = this.load();
    const projects = state.projects.filter((p) => existsSync(p.root));
    // Re-pin built-in last after existence filter.
    const builtin = projects.filter((p) => isBuiltinProjectRoot(p.root, this.builtinRoot));
    const regular = projects.filter((p) => !isBuiltinProjectRoot(p.root, this.builtinRoot));
    return [...regular, ...builtin];
  }

  removeProject(root: string): void {
    const prev = this.load();
    // Disallow removing the built-in sandbox from the list.
    if (isBuiltinProjectRoot(root, this.builtinRoot)) {
      this.save(prev);
      return;
    }
    const projects = prev.projects.filter((p) => normRoot(p.root) !== normRoot(root));
    this.save({ lastWorkspace: prev.lastWorkspace, projects });
  }

  clear(): void {
    this.save({ lastWorkspace: null, projects: [] });
  }
}
