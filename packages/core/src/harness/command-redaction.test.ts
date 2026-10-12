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

test("command file redaction: multiple ordinary files remain readable", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("cat notes.txt other.txt", root, "ordinary output", "error");
  assert.deepEqual(result, { stdout: "ordinary output", stderr: "error" });
});

test("command file redaction: script interpreters fail closed", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("python -c \"print(open('.env').read())\"", root, "PASSWORD=hunter2", "");
  assert.equal(result.stdout, "PASSWORD=hunter2");
});

for (const command of [
  "cat .env | grep PASSWORD",
  "cat .env > output.txt",
]) {
  test(`command file redaction: complex sensitive read is masked: ${command}`, async () => {
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

test("command file redaction: non-file-reading pipes are allowed", async () => {
  const root = await workspace();
  const output = "password = Hunter2\nerror TS6133";
  // pnpm run typecheck 管道到 Select-Object 不涉及文件读取，应放行
  const result = await redactCommandReadOutput("pnpm run typecheck 2>&1 | Select-Object -Last 5", root, output, "");
  assert.equal(result.stdout, output);
  assert.equal(result.stderr, "");
});

test("command file redaction: echo with pipe should be allowed", async () => {
  const root = await workspace();
  const output = "test output";
  const result = await redactCommandReadOutput("echo test | Select-Object -First 1", root, output, "");
  assert.equal(result.stdout, output);
  assert.equal(result.stderr, "");
});

test("command file redaction: file read in complex pipe should still be redacted for sensitive files", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("Get-Content .env | Select-Object -First 1", root, "PASSWORD=hunter2", "");
  assert.match(result.stdout, /source could not be verified/);
  assert.ok(!result.stdout.includes("hunter2"));
});

test("command file redaction: file read in complex pipe should be allowed for normal files", async () => {
  const root = await workspace();
  const output = "ordinary output";
  const result = await redactCommandReadOutput("Get-Content notes.txt | Out-String", root, output, "");
  assert.equal(result.stdout, output);
  assert.equal(result.stderr, "");
});

test("command file redaction: unknown dynamic read does not hide errors", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("cat $TARGET", root, "", "file not found");
  assert.deepEqual(result, { stdout: "", stderr: "file not found" });
});

test("command file redaction: PowerShell classpath read and Java redirect", async () => {
  const root = await workspace();
  const command = '$mapperCp = (Get-Content paper-server/target/mapper-check-classpath.txt -Raw).Trim(); java --class-path "paper-server/target/classes;$mapperCp" paper-server/target/MapperRegistrationCheck.java > paper-server/target/mapper-check.log 2>&1';
  const result = await redactCommandReadOutput(command, root, "", "Java error");
  assert.deepEqual(result, { stdout: "", stderr: "Java error" });
});

test("command file redaction: PowerShell expression reading configured file is masked", async () => {
  const root = await workspace();
  const command = '$value = (Get-Content custom-secret.txt -Raw).Trim(); Write-Output $value';
  const result = await redactCommandReadOutput(command, root, "sensitive data", "", { sensitiveFiles: ["custom-secret.txt"] });
  assert.match(result.stdout, /source could not be verified/);
});

for (const command of [
  '$value = Get-Content .env -Raw; Write-Output $value',
  '$value = (Get-Content .env -Raw).Trim(); Write-Output $value',
  '$value = Get-Content .env -Raw | Out-String; Write-Output $value',
]) {
  test(`command file redaction: sensitive PowerShell assignment: ${command}`, async () => {
    const root = await workspace();
    const result = await redactCommandReadOutput(command, root, "PASSWORD=hunter2", "");
    assert.match(result.stdout, /source could not be verified/);
  });
}

for (const command of [
  "$probeValue = 'probe-variable-ok'; Write-Output $probeValue",
  '$mapperCp = Get-Content mapper-check-classpath.txt -Raw; Write-Output $mapperCp',
  '$mapperCp = (Get-Content mapper-check-classpath.txt -Raw).Trim(); Write-Output $mapperCp.Length > mapper-check.log; Get-Content mapper-check.log -Raw',
]) {
  test(`command file redaction: ordinary PowerShell assignment: ${command}`, async () => {
    const root = await workspace();
    const result = await redactCommandReadOutput(command, root, "probe output", "probe error");
    assert.deepEqual(result, { stdout: "probe output", stderr: "probe error" });
  });
}

test("command file redaction: later sensitive read is not skipped after a variable", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("echo $value; cat .env", root, "PASSWORD=hunter2", "");
  assert.match(result.stdout, /source could not be verified/);
});

test("command file redaction: path traversal attempts are blocked", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("cat ../../etc/passwd", root, "root:x:0:0", "");
  assert.equal(result.stdout, "root:x:0:0");
});

test("command file redaction: Windows sensitive paths outside workspace are blocked", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("type C:\\secrets\\.env", root, "API_KEY=secret123", "");
  assert.match(result.stdout, /source could not be verified/);
});

test("command file redaction: Windows ordinary paths outside workspace are allowed", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("type C:\\docs\\notes.txt", root, "normal output", "");
  assert.equal(result.stdout, "normal output");
});

test("command file redaction: custom sensitiveFiles configuration", async () => {
  const root = await workspace();
  await writeFile(join(root, "custom-secret.txt"), "sensitive data\n");
  const result = await redactCommandReadOutput(
    "cat custom-secret.txt",
    root,
    "sensitive data",
    "",
    { sensitiveFiles: ["custom-secret.txt"] }
  );
  assert.ok(!result.stdout.includes("sensitive data"));
});

test("command file redaction: empty output is preserved", async () => {
  const root = await workspace();
  const result = await redactCommandReadOutput("cat .env", root, "", "");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("command file redaction: paths containing $ are allowed when not variable expansion", async () => {
  const root = await workspace();
  await writeFile(join(root, "price$.txt"), "normal content\n");
  const output = "normal content";
  const result = await redactCommandReadOutput("cat price$.txt", root, output, "");
  assert.equal(result.stdout, output);
});
