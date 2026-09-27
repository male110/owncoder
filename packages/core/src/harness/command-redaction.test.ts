import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { redactCommandReadOutput } from "./command-redaction.ts";

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "owncoder-command-redaction-"));
  await writeFile(join(root, ".env"), "PASSWORD=hunter2\nUSER=alice@example.com\n");
  await writeFile(join(root, "notes.txt"), "ordinary output\n");
  return root;
}

for (const command of [
  "cat .env",
  "type .env",
  "Get-Content .env",
  "gc -LiteralPath .env",
  "head -n 1 .env",
  "tail --lines 1 .env",
  "more .env",
  "sed -n '1,2p' .env",
  "grep PASSWORD .env",
  "rg --regexp PASSWORD .env",
  "Select-String -Pattern PASSWORD .env",
]) {
  test(`command file redaction: ${command}`, async () => {
    const root = await workspace();
    const result = await redactCommandReadOutput(command, root, "PASSWORD=hunter2\nUSER=alice@example.com\n", "");
    assert.ok(!result.stdout.includes("hunter2"));
    assert.ok(!result.stdout.includes("alice@example.com"));
  });
}

test("command file redaction: absolute paths retain file attribution", async () => {
  const root = await workspace();
  const envPath = join(root, ".env");
  const result = await redactCommandReadOutput(`cat ${envPath}`, root, "PASSWORD=hunter2\nUSER=alice@example.com\n", "");
  assert.ok(!result.stdout.includes("hunter2"));
  assert.ok(!result.stdout.includes("alice@example.com"));
});

test("command file redaction: redacts stdout and stderr using the attributed file type", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("cat .env", root, "PASSWORD=hunter2", "USER=alice@example.com");
  assert.ok(!result.stdout.includes("hunter2"));
  assert.ok(!result.stderr.includes("alice@example.com"));
});

test("command file redaction: untrusted multiple-file reads fail closed", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("cat .env notes.txt", root, "PASSWORD=hunter2", "");
  assert.match(result.stdout, /source could not be verified/);
  assert.ok(!result.stdout.includes("hunter2"));
});

test("command file redaction: script interpreters fail closed", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("python -c \"print(open('.env').read())\"", root, "PASSWORD=hunter2", "");
  assert.match(result.stdout, /source could not be verified/);
  assert.ok(!result.stdout.includes("hunter2"));
});

for (const command of [
  "cat .env | grep PASSWORD",
  "cat .env > output.txt",
  "cat $TARGET",
  "cat *.env",
]) {
  test(`command file redaction: complex command fails closed: ${command}`, async () => {
    const root = await workspace();
    const result = await redactCommandReadOutput(command, root, "PASSWORD=hunter2", "USER=alice@example.com");
    assert.match(result.stdout, /source could not be verified/);
    assert.match(result.stderr, /source could not be verified/);
    assert.ok(!result.stdout.includes("hunter2"));
    assert.ok(!result.stderr.includes("alice@example.com"));
  });
}

test("command file redaction: ordinary command output is unchanged", async () => {
  const root = await workspace();
  const output = "password = Hunter2";
  const result = await redactCommandReadOutput("git status", root, output, "warning");
  assert.equal(result.stdout, output);
  assert.equal(result.stderr, "warning");
});
