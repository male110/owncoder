import { describe, expect, it, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnifiedIndex } from "../index.ts";
import { buildIndex, buildIndexAsync } from "../builder.ts";
import { initializeSchema } from "../schema.ts";

const workspaces: string[] = [];
const databases: Database.Database[] = [];
const indexes: UnifiedIndex[] = [];

afterEach(() => {
  for (const index of indexes.splice(0)) index.close();
  for (const db of databases.splice(0)) db.close();
  for (const root of workspaces.splice(0)) {
    if (!existsSync(root)) continue;
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (i === 2) throw error;
      }
    }
  }
});

function createWorkspace(): { root: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "index-regression-"));
  mkdirSync(join(root, ".owncoder"), { recursive: true });
  const db = new Database(join(root, ".owncoder", "unified-index.db"));
  initializeSchema(db);
  workspaces.push(root);
  databases.push(db);
  return { root, db };
}

describe("code index regressions", () => {
  it("binds call references to the containing function", async () => {
    const { root, db } = createWorkspace();
    writeFileSync(
      join(root, "calls.ts"),
      [
        "function helper() {}",
        "function main() { helper(); }",
      ].join("\n"),
    );

    buildIndex(db, { root, incremental: false });
    const index = new UnifiedIndex();
    indexes.push(index);
    index.open(root);

    const impact = await index.impact("helper");
    expect(impact.callers.some((caller) => caller.name === "main")).toBe(true);
  });

  it("honors exportedOnly and file search filters", async () => {
    const { root, db } = createWorkspace();
    writeFileSync(
      join(root, "search-target.ts"),
      "export function publicThing() {}\nfunction privateThing() {}",
    );

    buildIndex(db, { root, incremental: false });
    const index = new UnifiedIndex();
    indexes.push(index);
    index.open(root);

    const exported = await index.search("publicThing", { exportedOnly: true });
    expect(exported.map((result) => result.name)).toEqual(["publicThing"]);

    const files = await index.search("search-target", { type: "file" });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("search-target.ts");
  });

  it("rebuilds a forced async path even when mtime and size are unchanged", async () => {
    const { root, db } = createWorkspace();
    const filePath = join(root, "forced.ts");
    writeFileSync(filePath, "export function alpha() {}");
    await buildIndexAsync(db, { root, incremental: true });

    const oldMtime = statSync(filePath).mtime;
    writeFileSync(filePath, "export function bravo() {}");
    utimesSync(filePath, oldMtime, oldMtime);

    await buildIndexAsync(db, {
      root,
      incremental: true,
      forcedPaths: ["forced.ts"],
    });

    const names = (db.prepare("SELECT name FROM symbols").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(names).toContain("bravo");
    expect(names).not.toContain("alpha");
  });

  it("removes deleted files from the file FTS index", async () => {
    const { root, db } = createWorkspace();
    const filePath = join(root, "gone.ts");
    writeFileSync(filePath, "export function gone() {}");
    buildIndex(db, { root, incremental: true });

    rmSync(filePath);
    buildIndex(db, { root, incremental: true });

    const stale = db
      .prepare("SELECT COUNT(*) AS count FROM files_fts WHERE path = ?")
      .get("gone.ts") as { count: number };
    expect(stale.count).toBe(0);
  });
});
