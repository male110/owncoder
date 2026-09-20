/**
 * Shared security defaults used by both the runtime and settings UI.
 * Keep these declarations free of Node APIs so renderer code can import them safely.
 */

/**
 * Configuration files that stay protected from writes but use field-level
 * redaction. This keeps ordinary settings (for example PORT and NODE_ENV)
 * readable while masking account, password, token, key, and secret values.
 */
export const BUILTIN_VALUE_REDACTION_FILES = [
  ".env",
  ".env.*",
  "*credentials*.json",
  "*credentials*.yaml",
  "*credentials*.yml",
  "*credentials*.toml",
  "*credentials*.ini",
  "*credentials*.env",
  "*secrets*.json",
  "*secrets*.yaml",
  "*secrets*.yml",
  "*secrets*.toml",
  "*secrets*.ini",
  "*secrets*.env",
  "credentials",
  "secrets",
  "application.properties",
  "application*.properties",
  "application*.yml",
  "application*.yaml",
  "bootstrap.properties",
  "bootstrap*.properties",
  "bootstrap*.yml",
  "bootstrap*.yaml",
  ".netrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".yarnrc.yaml",
  ".pypirc",
  "pip.conf",
  ".m2/settings.xml",
  "auth.json",
  "google-services.json",
  "GoogleService-Info.plist",
  "key.properties",
  ".aws/credentials",
  "*service-account*.json",
  "*service_account*.json",
  "vault.yaml",
  "vault.yml",
  "*vault*secrets*.yaml",
  "*vault*secrets*.yml",
  "*vault*secrets*.json",
  "kubeconfig",
  "*.kubeconfig",
  ".docker/config.json",
  "docker-compose.override.yml",
  "terraform.tfvars",
  "*.tfvars",
  "*.tfvars.json",
] as const;

/** Files that contain opaque credentials, encrypted payloads, or database data. */
export const BUILTIN_WHOLE_FILE_REDACTION_FILES = [
  ".htpasswd",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "config/master.key",
  "config/credentials.yml.enc",
  "*dump*.sql",
  "*backup*.sql",
  "*.sqlite",
  "*.db",
] as const;

/**
 * All built-in protected file patterns. These retain write protection and are
 * accepted by the safety test; only the smaller whole-file subset hides every
 * non-empty line.
 */
export const BUILTIN_SENSITIVE_FILES = [
  ...BUILTIN_VALUE_REDACTION_FILES,
  ...BUILTIN_WHOLE_FILE_REDACTION_FILES,
] as const;

export const SENSITIVE_FILE_ALLOWLIST = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
  "application-example.properties",
  "application-example.yml",
  "application-example.yaml",
  "application-sample.properties",
  "application-sample.yml",
  "application-sample.yaml",
] as const;

/** Human-readable coverage shown in Settings > Security. */
export const SECURITY_STACK_COVERAGE = [
  { name: "通用 / 密钥", files: ".env*、credentials/secrets、PEM/JKS/P12、SSH 私钥" },
  { name: "Node.js / 前端", files: ".npmrc、.yarnrc、dotenv" },
  { name: "Python", files: ".pypirc、pip.conf、dotenv" },
  { name: "Java / Spring", files: "application*/bootstrap*/Gradle 敏感值检测；Maven settings、JKS 整体保护" },
  { name: ".NET", files: "appsettings*.json 敏感值检测、证书文件整体保护" },
  { name: "PHP / Ruby", files: "Composer auth.json、Rails master.key / credentials" },
  { name: "移动端", files: "Firebase 配置、iOS plist、Android/Flutter 签名配置" },
  { name: "云原生 / 数据库", files: "AWS/GCP、Kubernetes、Docker、Vault、Terraform、数据库备份" },
] as const;

/** Extensions accepted by strict write policy after protected/generated paths are rejected. */
export const STRICT_WRITABLE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".pyi", ".ipynb", ".rs", ".go",
  ".java", ".kt", ".kts", ".groovy", ".gradle", ".scala",
  ".c", ".h", ".cc", ".hh", ".cpp", ".hpp", ".m", ".mm", ".swift",
  ".cs", ".fs", ".fsx", ".vb",
  ".rb", ".php", ".pl", ".pm", ".lua", ".r", ".dart",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".md", ".mdx", ".txt", ".rst", ".adoc",
  ".json", ".jsonc", ".toml", ".yaml", ".yml", ".xml", ".ini", ".cfg", ".conf", ".properties",
  ".css", ".scss", ".sass", ".less", ".styl", ".html", ".htm",
  ".vue", ".svelte", ".astro",
  ".sql", ".graphql", ".gql", ".proto", ".thrift",
] as const;

/** Common source/config entry points without an extension. */
export const STRICT_WRITABLE_FILENAMES = [
  "dockerfile",
  "makefile",
  "rakefile",
  "gemfile",
  "procfile",
  "jenkinsfile",
  "gradlew",
  "mvnw",
] as const;
