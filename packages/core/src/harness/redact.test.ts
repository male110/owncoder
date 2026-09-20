import assert from "node:assert/strict";
import { test } from "vitest";
import { redactSecrets } from "./redact.ts";

/**
 * Layer 3 keyword patterns must only treat the keyword as a credential field
 * name when it starts its own identifier. Otherwise ordinary code such as
 * `JSONObject user = new JSONObject();` would be masked as `user = ***`.
 */
test("redactSecrets: keyword followed by code value is not masked", () => {
  const java =
    "    JSONObject user = new JSONObject();\n" +
    "    String token = UUID.randomUUID().toString();\n" +
    "    UserLogin login = getLogin();\n";
  const result = redactSecrets(java, "src/main/java/Demo.java");
  assert.equal(result.text, java);
  assert.equal(result.redacted, false);
});

test("redactSecrets: Java assignments and comparisons stay readable", () => {
  const java = [
    "    String user = userMapper.selectById(id);",
    "    this.apiKey = Objects.requireNonNull(apiKey);",
    "    token = jwtBuilder.compact();",
    "    String secret = Env.get(\"SECRET_KEY\");",
    "    String password = encoder.encode(rawPassword);",
    "    private static final String API_KEY = Constants.API_KEY;",
    "    if (account == null) throw new LoginRequired();",
    "    this.user = user;",
  ].join("\n");
  const result = redactSecrets(java, "src/main/java/Service.java");
  assert.equal(result.text, java);
  assert.equal(result.redacted, false);
});

test("redactSecrets: quoted secrets are masked with quotes preserved in value files", () => {
  const code = [
    'password="hunter2-pass"',
    'DB_PASSWORD="s3cret"',
    'PASSWORD="my pass"',
  ].join("\n");
  const result = redactSecrets(code, ".env");
  assert.ok(result.text.includes('password="***"'));
  assert.ok(result.text.includes('DB_PASSWORD="***"'));
  assert.ok(result.text.includes('PASSWORD="***"'));
  assert.ok(!result.text.includes("hunter2-pass"));
  assert.ok(!result.text.includes("s3cret"));
  assert.ok(!result.text.includes("my pass"));
});

test("redactSecrets: keyword prefixes (user_id / super_user) stay readable", () => {
  const code = "const user_id = req.params.id;\nconst is_super_user = check(user);\n";
  const result = redactSecrets(code, "src/routes/handler.ts");
  assert.equal(result.text, code);
  assert.equal(result.redacted, false);
});

test("redactSecrets: real credential values are still masked in value files", () => {
  const lines = [
    "password = Hunter2",       // bare keyword
    'DB_PASSWORD="s3cret"',     // SCREAMING_SNAKE prefix (Env Credential)
    "my_password:Hunter2",      // lowercase snake prefix
    "user: alice@example.com",  // account identifier
    "api_key = ak_live_123456",
  ].join("\n");
  const result = redactSecrets(lines, ".env");
  assert.equal(result.redacted, true);
  assert.ok(!result.text.includes("Hunter2"));
  assert.ok(!result.text.includes("s3cret"));
  assert.ok(!result.text.includes("alice@example.com"));
  assert.ok(!result.text.includes("ak_live_123456"));
});

test("redactSecrets: keyword patterns stay out of ordinary source files", () => {
  const code = [
    'const password = "hunter2-pass";',
    "const user = req.user;",
    "const token = issueToken(user);",
  ].join("\n");
  const result = redactSecrets(code, "src/routes/handler.ts");
  assert.equal(result.text, code);
  assert.equal(result.redacted, false);
});

test("redactSecrets: format-anchored secrets are masked only in value files", () => {
  const secrets = [
    "url=jdbc:mysql://root:p%40ss@localhost/db",
    "token=ghp_0123456789abcdef0123456789abcdefabcdef",
  ].join("\n");
  const envResult = redactSecrets(secrets, ".env");
  assert.ok(!envResult.text.includes("p%40ss"));
  assert.ok(!envResult.text.includes("ghp_0123456789"));

  // The same content in an ordinary source file is untouched.
  const java = [
    'String url = "jdbc:mysql://root:p%40ss@localhost/db";',
    'String token = "ghp_0123456789abcdef0123456789abcdefabcdef";',
  ].join("\n");
  const javaResult = redactSecrets(java, "src/App.java");
  assert.equal(javaResult.text, java);
  assert.equal(javaResult.redacted, false);
});

test("redactSecrets: pathless tool output is not redacted", () => {
  const output = "password = Hunter2\nuser: alice@example.com\n";
  const result = redactSecrets(output, "");
  assert.equal(result.text, output);
  assert.equal(result.redacted, false);
});

test("redactSecrets: Spring application.properties gets keyword masking", () => {
  const props = [
    "spring.datasource.url=jdbc:mysql://localhost/db",
    "spring.datasource.password=root-pass",
    "spring.datasource.username=admin",
  ].join("\n");
  const result = redactSecrets(props, "src/main/resources/application.properties");
  assert.ok(!result.text.includes("root-pass"));
  assert.ok(!result.text.includes("admin"));
  assert.ok(result.text.includes("spring.datasource.password"));
});

test("redactSecrets: env example files stay readable", () => {
  const example = "password=changeme\nDB_PASSWORD=changeme\n";
  const result = redactSecrets(example, ".env.example");
  assert.equal(result.text, example);
  assert.equal(result.redacted, false);
});

test("redactSecrets: ordinary Java files are never touched", () => {
  const java = 'String password = "hunter2-pass";\nString url = "jdbc:mysql://root:p%40ss@localhost/db";\n';
  const result = redactSecrets(java, "src/App.java");
  assert.equal(result.text, java);
  assert.equal(result.redacted, false);
});

test("redactSecrets: lines that merely mention the words stay readable", () => {
  const doc =
    "// read the password policy\n" +
    "logger.debug(\"user = \" + user);\n" +
    "if (account == null) throw new LoginRequired();\n";
  const result = redactSecrets(doc, "docs/README.md");
  assert.equal(result.text, doc);
  assert.equal(result.redacted, false);
});

test("redactSecrets: YAML comment after empty keyword value is not mistakenly redacted", () => {
  // Regression: \s* in the lookbehind was matching across newlines, causing
  // `password:` (empty value) to capture `#timeout:` on the next line as its
  // value. After the fix, horizontal-whitespace-only [ \t]* prevents this.
  const yaml = [
    "    data:",
    "      redis:",
    "        database: 1",
    "        host: localhost",
    "        port: 6379",
    "        password:",
    "        #timeout: 6000ms  # 连接超时时长（毫秒）",
  ].join("\n");

  const result = redactSecrets(yaml, "application-testlocal.yml");

  assert.ok(
    result.text.includes("#timeout: 6000ms"),
    `#timeout comment line should not be redacted.\nGot:\n${result.text}`,
  );
  assert.ok(
    result.text.match(/password:\s*$/m),
    "empty password: line should remain unchanged",
  );
});

test("redactSecrets: cross-line lookbehind does not capture YAML comments", () => {
  const yaml = [
    "token:",
    "# just a comment about timeout settings",
    "secret:",
    "# another comment",
  ].join("\n");

  const result = redactSecrets(yaml, "application.yml");

  assert.ok(result.text.includes("# just a comment"));
  assert.ok(result.text.includes("# another comment"));
});

test("redactSecrets: Bearer token on same line still redacted", () => {
  const env = "AUTH_TOKEN=Bearer eyJhbGciOiJIUzI1NiJ9.abc123";
  const result = redactSecrets(env, ".env");
  assert.ok(result.redacted, "Bearer token should be redacted");
  assert.ok(!result.text.includes("eyJhbGci"), "JWT should be masked");
});

test("redactSecrets: Bearer followed by newline is not falsely matched", () => {
  // Regression: \s+ in Bearer pattern was replaced with [ \t]+ to prevent
  // matching across lines.
  const text = [
    "Authorization: Bearer",
    "#timeout: 6000ms",
  ].join("\n");
  const result = redactSecrets(text, ".env");
  assert.ok(result.text.includes("#timeout: 6000ms"), "comment should survive");
});
