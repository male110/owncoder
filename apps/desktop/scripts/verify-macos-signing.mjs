const required = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `[pack:mac] Missing required signing environment variables: ${missing.join(", ")}`,
  );
  console.error(
    "[pack:mac] Provide them from secure macOS CI secrets; unsigned macOS release builds are not allowed.",
  );
  process.exit(1);
}
