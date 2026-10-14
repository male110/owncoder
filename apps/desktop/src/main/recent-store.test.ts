import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecentStore } from "./recent-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("project order", () => {
  it("persists moves across reloads, opens and changes to the list", () => {
    const dir = mkdtempSync(join(tmpdir(), "owncoder-order-"));
    dirs.push(dir);
    const store = new RecentStore(dir);
    const roots = ["a", "b", "c", "d"].map((name) => join(dir, name));
    roots.forEach((root) => mkdirSync(root));
    for (const root of roots.slice(0, 3)) store.ensureProject(root, root);
    expect(store.listProjects().map((p) => p.root)).toEqual([roots[2], roots[1], roots[0]]);
    store.moveProject(roots[0], roots[2], false);
    store.setLastWorkspace(roots[1], "b");
    expect(new RecentStore(dir).listProjects().map((p) => p.root)).toEqual([roots[0], roots[2], roots[1]]);
    store.ensureProject(roots[3], "d");
    store.removeProject(roots[2]);
    expect(new RecentStore(dir).listProjects().map((p) => p.root)).toEqual([roots[3], roots[0], roots[1]]);
    expect(JSON.parse(readFileSync(join(dir, "owncoder", "recent.json"), "utf8")).projects.map((p: { root: string }) => p.root))
      .toEqual([roots[3], roots[0], roots[1]]);
  });

  it("ignores unknown roots and permits moving the built-in project", () => {
    const dir = mkdtempSync(join(tmpdir(), "owncoder-order-"));
    dirs.push(dir);
    const store = new RecentStore(dir);
    const builtin = join(dir, "OwnCoderProject");
    const regular = join(dir, "regular");
    mkdirSync(builtin);
    mkdirSync(regular);
    store.setBuiltinRoot(builtin);
    store.ensureProject(regular, "regular");
    store.ensureProject(builtin, "OwnCoderProject");
    store.moveProject(builtin, regular, false);
    expect(store.listProjects().map((p) => p.root)).toEqual([builtin, regular]);
    store.moveProject("unknown", regular, false);
    expect(store.listProjects().map((p) => p.root)).toEqual([builtin, regular]);
  });
});
