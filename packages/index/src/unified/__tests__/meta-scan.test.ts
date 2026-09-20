import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDiffFromMetas,
  walkFileMetas,
  type FileMeta,
} from "../scanner.ts";

describe("stat-first meta scan", () => {
  it("walkFileMetas yields paths without requiring content hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "owncoder-meta-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");

    const metas = Array.from(walkFileMetas({ root }));
    expect(metas.map((m) => m.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    for (const meta of metas) {
      expect(meta.size).toBeGreaterThan(0);
      expect(meta.mtime).toBeGreaterThan(0);
      expect(meta).not.toHaveProperty("hash");
    }
  });

  it("computeDiffFromMetas uses mtime+size and never needs content", () => {
    const current: FileMeta[] = [
      {
        path: "src/a.ts",
        absolutePath: "/tmp/a.ts",
        size: 10,
        mtime: 100,
        language: "typescript",
      },
      {
        path: "src/b.ts",
        absolutePath: "/tmp/b.ts",
        size: 20,
        mtime: 200,
        language: "typescript",
      },
    ];
    const indexed = new Map([
      ["src/a.ts", { hash: "old", mtime: 100, size: 10 }],
      ["src/gone.ts", { hash: "x", mtime: 1, size: 1 }],
    ]);

    const unchanged = computeDiffFromMetas(current, indexed);
    expect(unchanged.added).toEqual(["src/b.ts"]);
    expect(unchanged.modified).toEqual([]);
    expect(unchanged.removed).toEqual(["src/gone.ts"]);

    const touched = computeDiffFromMetas(
      [{ ...current[0]!, mtime: 101 }, current[1]!],
      indexed,
    );
    expect(touched.modified).toEqual(["src/a.ts"]);
  });

  it("manifestScan path no longer materializes content-bearing FileInfo arrays", async () => {
    const spy = vi.spyOn(await import("../scanner.ts"), "walkFileMetas");
    const { UnifiedIndexAdapter } = await import("../index-client-adapter.ts");
    const adapter = new UnifiedIndexAdapter();
    // Without an open DB, scan should still use meta walk and return added paths.
    const root = mkdtempSync(join(tmpdir(), "owncoder-manifest-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
    const diff = await adapter.manifestScan!(root, 100);
    expect(spy).toHaveBeenCalled();
    expect(diff.added.length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
