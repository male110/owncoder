import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Built-in sandbox workspace (ZCode-style); always available under userData. */
export const DEFAULT_WORKSPACE_FOLDER = "OwnCoderProject";
/** Pre-rename built-in folder name (owncode → owncoder). */
export const LEGACY_DEFAULT_WORKSPACE_FOLDER = "OwnCodeProject";

export interface DefaultWorkspaceInfo {
  root: string;
  name: string;
}

export function defaultWorkspacePath(userDataDir: string): string {
  return join(userDataDir, "owncoder", "workspaces", DEFAULT_WORKSPACE_FOLDER);
}

function legacyDefaultWorkspacePaths(userDataDir: string): string[] {
  return [
    join(userDataDir, "owncoder", "workspaces", LEGACY_DEFAULT_WORKSPACE_FOLDER),
    join(userDataDir, "owncode", "workspaces", LEGACY_DEFAULT_WORKSPACE_FOLDER),
    join(userDataDir, "owncode", "workspaces", DEFAULT_WORKSPACE_FOLDER),
  ];
}

function dirIsEffectivelyEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** Rename workspace `.owncode` → `.owncoder` when safe. */
export function migrateWorkspaceDotDir(root: string): void {
  const legacyDir = join(root, ".owncode");
  const currentDir = join(root, ".owncoder");
  if (!existsSync(legacyDir)) return;
  if (existsSync(currentDir)) {
    // 先建空 .owncoder 再迁移时：空目标可替换，避免会话仍留在 legacy。
    if (dirIsEffectivelyEmpty(currentDir)) {
      try {
        rmSync(currentDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[migration] cannot clear empty ${currentDir}:`, err);
        return;
      }
    } else {
      console.warn(
        `[migration] skip rename: ${currentDir} already exists (legacy left at ${legacyDir})`,
      );
      return;
    }
  }
  try {
    renameSync(legacyDir, currentDir);
    console.info(`[migration] renamed ${legacyDir} to ${currentDir}`);
  } catch (err) {
    console.warn(`[migration] rename failed ${legacyDir} → ${currentDir}:`, err);
  }
}

/**
 * Ensure the built-in sandbox exists under the current name/path.
 * Migrates OwnCodeProject → OwnCoderProject and `.owncode` → `.owncoder` when needed.
 */
export function ensureDefaultWorkspace(userDataDir: string): DefaultWorkspaceInfo {
  const workspacesDir = join(userDataDir, "owncoder", "workspaces");
  mkdirSync(workspacesDir, { recursive: true });
  const root = defaultWorkspacePath(userDataDir);

  for (const legacyRoot of legacyDefaultWorkspacePaths(userDataDir)) {
    if (!existsSync(legacyRoot) || legacyRoot === root) continue;
    if (!existsSync(root) || dirIsEffectivelyEmpty(root)) {
      try {
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
        renameSync(legacyRoot, root);
        console.info(`[migration] renamed built-in workspace ${legacyRoot} → ${root}`);
      } catch (err) {
        console.warn(`[migration] built-in workspace rename failed:`, err);
      }
      break;
    }
    console.warn(
      `[migration] keep legacy built-in at ${legacyRoot} (${root} already has content)`,
    );
  }

  mkdirSync(root, { recursive: true });
  migrateWorkspaceDotDir(root);
  return { root, name: DEFAULT_WORKSPACE_FOLDER };
}
