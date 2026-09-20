import upath from "upath";
import {
  BUILTIN_VALUE_REDACTION_FILES,
  BUILTIN_WHOLE_FILE_REDACTION_FILES,
  SENSITIVE_FILE_ALLOWLIST,
} from "@owncoder/settings";

/**
 * Secret redaction module — Layer 1 (file path matching) + Layer 3 (known format regex).
 *
 * This module detects and masks sensitive information in file content before
 * it is sent to the LLM. It does NOT modify the actual files on disk.
 */

// File defaults live in @owncoder/settings so runtime behavior and the settings UI
// share a single source of truth. Re-export them for existing core consumers.
export { BUILTIN_SENSITIVE_FILES } from "@owncoder/settings";

/**
 * Convert a glob pattern to a RegExp.
 * Supports: * (any chars), ? (single char), literal matching.
 */
function globToRegex(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (ch === "?") {
      pattern += "[^/]";
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`(^|/)${pattern}$`, "i");
}

/**
 * Check if a file path matches any of the sensitive file patterns.
 * @param filePath - Relative file path (e.g., "config/.env.production")
 * @param patterns - Array of glob patterns (built-in + user-defined)
 */
export function isSensitiveFile(filePath: string, patterns: readonly string[]): boolean {
  // Normalize path separators
  const normalized = upath.normalize(filePath);
  // Get just the filename for patterns that don't include path separators
  const fileName = normalized.split("/").pop() ?? normalized;

  // Check allowlist first — these files are safe regardless of glob matches
  for (const allowed of SENSITIVE_FILE_ALLOWLIST) {
    if (fileName.toLowerCase() === allowed.toLowerCase()) return false;
  }

  for (const pattern of patterns) {
    const re = globToRegex(pattern);
    // Match against full path or just filename
    if (re.test(normalized) || re.test(fileName)) {
      return true;
    }
  }
  return false;
}

// ── Layer 3: Known secret format patterns ──────────────────────────────────────

/**
 * Descriptor for a built-in secret pattern.
 * Storing source + flags instead of a RegExp instance avoids shared mutable
 * state: each call to redactSecrets() constructs fresh RegExp objects, so
 * lastIndex can never leak between calls even if exec()/test() is used.
 */
export interface SecretPatternDescriptor {
  name: string;
  source: string;
  flags: string;
}

/**
 * Expand one keyword into its quoted and bare credential pattern variants.
 *
 * quoted: `keyword = "value"` - masks the value, keeps the quotes so the line
 * stays readable and patchable. Real secrets embedded in source code are
 * string literals, so this variant applies everywhere.
 *
 * bare: `keyword = value` with no surrounding quote. Skipped when the line
 * ends with a statement-terminating `;` (a code assignment whose RHS is an
 * expression, e.g. `String token = UUID.randomUUID();`) and when the
 * separator is actually a comparison operator (`==`, `>=`, `!=`, ...).
 */
function credentialVariants(
  name: string,
  keywordBody: string,
  bareMin: number,
): SecretPatternDescriptor[] {
  const quotedMin = Math.min(bareMin, 4);
  return [
    {
      name,
      // [ \t] instead of \s prevents the lookbehind from matching across
      // newlines, which would cause a keyword on one line (e.g. `password:`)
      // to capture a comment on the next line (e.g. `#timeout: 6000ms`) as
      // its value, redacting the wrong text.
      source: `(?<=${keywordBody}[ \\t]*[=:][ \\t]*)(["'])[^"'}\\n]{${quotedMin},}\\1`,
      flags: "g",
    },
    {
      name,
      source:
        `(?<=${keywordBody}[ \\t]*[=:][ \\t]*)` +
        `(?<!["'])(?![=><!])[^\\s"';'}\\]]{${bareMin},}` +
        `(?![^;\\r\\n]*;[ \\t\\r]*$)`,
      flags: "gm",
    },
  ];
}

/**
 * Format-anchored secret patterns (API tokens, private keys, JWTs, connection
 * strings). Prefix-anchored formats have negligible false-positive risk.
 * Like all Layer 3 patterns, they apply only to value-level sensitive files
 * (see BUILTIN_VALUE_REDACTION_FILES); ordinary source files are untouched.
 */
export const BUILTIN_FORMAT_SECRET_PATTERNS: readonly SecretPatternDescriptor[] = [
  // ── API service tokens (prefix-anchored - low false-positive risk) ──

  // OpenAI: legacy sk-<alnum> and current sk-proj-* / sk-svcacct-* formats
  // Allows hyphens so sk-proj-... and sk-ant-... style keys are captured.
  { name: "OpenAI API Key",            source: String.raw`sk-[A-Za-z0-9-]{20,}`,              flags: "g" },
  // Anthropic Claude API keys (sk-ant-api03-...)
  { name: "Anthropic API Key",         source: String.raw`sk-ant-[A-Za-z0-9-]{20,}`,          flags: "g" },
  // AWS Access Key IDs
  { name: "AWS Access Key ID",         source: String.raw`AKIA[0-9A-Z]{16}`,                   flags: "g" },
  // AWS Secret Access Key - captured via context keyword (40-char base64)
  { name: "AWS Secret Access Key",     source: String.raw`(?<=aws_secret_access_key[ \t]*=[ \t]*["']?)[A-Za-z0-9/+=]{40}`, flags: "gi" },
  // Google / GCP API keys
  { name: "GCP API Key",               source: String.raw`AIza[0-9A-Za-z\-_]{35}`,             flags: "g" },
  // HuggingFace access tokens
  { name: "HuggingFace Token",         source: String.raw`hf_[A-Za-z0-9]{34,}`,               flags: "g" },
  // GitHub personal access tokens (classic)
  { name: "GitHub Token",              source: String.raw`ghp_[A-Za-z0-9]{36}`,                flags: "g" },
  // GitHub fine-grained tokens
  { name: "GitHub Fine-grained Token", source: String.raw`github_pat_[A-Za-z0-9_]{22,}`,      flags: "g" },
  // GitLab tokens
  { name: "GitLab Token",              source: String.raw`glpat-[A-Za-z0-9\-]{20}`,            flags: "g" },
  // Slack tokens
  { name: "Slack Token",               source: String.raw`xox[baprs]-[A-Za-z0-9\-]+`,          flags: "g" },
  // Stripe keys
  { name: "Stripe Key",                source: String.raw`(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{20,}`, flags: "g" },

  // ── Transport-layer credentials ──

  // Bearer tokens in HTTP headers
  { name: "Bearer Token",              source: String.raw`Bearer[ \t]+[A-Za-z0-9\-._~+/]+=*`,  flags: "gi" },
  // JWT tokens (three base64url segments)
  { name: "JWT",                       source: String.raw`eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`, flags: "g" },

  // ── Private key blocks (PEM / OpenSSH) ──
  // Covers: RSA, EC, DSA, ENCRYPTED, and OpenSSH (default since OpenSSH 6.5)
  {
    name: "Private Key",
    source: String.raw`-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|ENCRYPTED\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|ENCRYPTED\s+|OPENSSH\s+)?PRIVATE\s+KEY-----`,
    flags: "g",
  },

  // ── Database connection strings ──
  { name: "Connection String (mongodb)", source: String.raw`(?<=mongodb(?:\+srv)?:\/\/)[^\s"']+@[^\s"']+`,  flags: "gi" },
  { name: "Connection String (postgres)", source: String.raw`(?<=postgres(?:ql)?:\/\/)[^\s"']+@[^\s"']+`,  flags: "gi" },
  { name: "Connection String (mysql)",    source: String.raw`(?<=mysql:\/\/)[^\s"']+@[^\s"']+`,             flags: "gi" },
  { name: "Connection String (redis)",    source: String.raw`(?<=redis(?:s)?:\/\/)[^\s"']+@[^\s"']+`,       flags: "gi" },
  { name: "Connection String (amqp)",     source: String.raw`(?<=amqp(?:s)?:\/\/)[^\s"']+@[^\s"']+`,        flags: "gi" },
];

/**
 * Keyword-based credential patterns (password=, token=, user=, ...). These
 * guess from field NAMES, so they carry real false-positive risk on ordinary
 * source code (`String token = UUID.randomUUID();`). Like all Layer 3
 * patterns, they apply only to value-level sensitive files - the set
 * configured in BUILTIN_VALUE_REDACTION_FILES.
 */
export const BUILTIN_KEYWORD_SECRET_PATTERNS: readonly SecretPatternDescriptor[] = [
  // ── Generic keyword-based patterns ──
  // Each keyword expands into two variants via credentialVariants():
  //   quoted - `keyword = "value"`: masks the value, keeps the quotes.
  //   bare   - `keyword = value`: skipped when the line ends with a
  //            statement-terminating `;` (code assignment whose RHS is an
  //            expression, e.g. `String token = UUID.randomUUID();`) or when
  //            the separator is actually a comparison operator (`==`, ...).
  ...credentialVariants("Password", String.raw`[A-Za-z0-9_]?[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]`, 3),
  ...credentialVariants("Passwd",   String.raw`[A-Za-z0-9_]?[Pp][Aa][Ss][Ss][Ww][Dd]`, 3),
  // api_key / apiKey / API_KEY
  ...credentialVariants("API Key",  String.raw`[A-Za-z0-9_]?[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]`, 8),
  // secret / SECRET / MY_SECRET
  ...credentialVariants("Secret",   String.raw`[A-Za-z0-9_]?[Ss][Ee][Cc][Rr][Ee][Tt]`, 8),
  // token / TOKEN / ACCESS_TOKEN
  ...credentialVariants("Token",    String.raw`[A-Za-z0-9_]?[Tt][Oo][Kk][Ee][Nn]`, 8),
  // Accounts identify private access. Keep the field name visible for
  // troubleshooting while masking its value like other credentials.
  // Identifiers like "superUser" are excluded structurally: the keyword must
  // start its own identifier (preceded by a non-word char or line start).
  ...credentialVariants("Username", String.raw`(?:^|[^A-Za-z0-9_])[Uu][Ss][Ee][Rr][Nn][Aa][Mm][Ee]`, 1),
  ...credentialVariants("Account",  String.raw`(?:^|[^A-Za-z0-9_])[Aa][Cc][Cc][Oo][Uu][Nn][Tt]`, 1),
  ...credentialVariants("Login",    String.raw`(?:^|[^A-Za-z0-9_])[Ll][Oo][Gg][Ii][Nn]`, 1),
  ...credentialVariants("User",     String.raw`(?:^|[^A-Za-z0-9_])[Uu][Ss][Ee][Rr]`, 1),

  // ── Catch-all for SCREAMING_SNAKE_CASE env vars ending in credential suffixes ──
  // e.g. MYSQL_ROOT_PASSWORD=, POSTGRES_PASSWORD=, SECRET_KEY=, GH_TOKEN=
  // Lookbehind ensures only the value is masked, preserving the key name.
  ...credentialVariants(
    "Env Credential",
    String.raw`\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:PASSWORD|PASSWD|SECRET|TOKEN|KEY|CREDENTIAL|CREDENTIALS|AUTH|ACCESS_KEY|SECRET_KEY|API_KEY|PRIVATE_KEY)`,
    3,
  ),
];

/**
 * All built-in secret pattern descriptors (format-anchored + keyword-based).
 * Use `buildSecretPatterns()` to obtain ready-to-use RegExp instances.
 */
export const BUILTIN_SECRET_PATTERN_DESCRIPTORS: readonly SecretPatternDescriptor[] = [
  ...BUILTIN_FORMAT_SECRET_PATTERNS,
  ...BUILTIN_KEYWORD_SECRET_PATTERNS,
];

/**
 * Construct fresh RegExp instances from a descriptor list.
 * Call this inside redactSecrets() so each invocation gets its own objects
 * with lastIndex = 0, eliminating shared mutable state entirely.
 */
function buildSecretPatterns(
  descriptors: readonly SecretPatternDescriptor[],
  extra: readonly string[] = [],
): Array<{ name: string; pattern: RegExp }> {
  const result = descriptors.map(({ name, source, flags }) => ({
    name,
    pattern: new RegExp(source, flags),
  }));
  extra.forEach((src, i) => {
    try {
      result.push({ name: `自定义规则 ${i + 1}`, pattern: new RegExp(src, "g") });
    } catch {
      // Invalid user expressions must never break read_file/grep or disable the
      // remaining built-in protections. The settings UI labels them as ignored.
      console.warn(`[redact] ignored invalid custom pattern ${i + 1}`);
    }
  });
  return result;
}

/** The mask string used to replace sensitive values. */
export const REDACTED_MASK = "***";

/**
 * Apply redaction to text content.
 *
 * @param text     - The text content to redact
 * @param filePath - The relative file path (for Layer 1 matching)
 * @param options  - Optional user-defined patterns and sensitive file lists
 * @returns The redacted text, and info about what was redacted
 */
export function redactSecrets(
  text: string,
  filePath: string,
  options?: {
    sensitiveFiles?: readonly string[];
    patterns?: readonly string[];
  },
): { text: string; redacted: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Built-in protected files may be field-level or whole-file. User-defined
  // sensitive file patterns intentionally retain the stricter whole-file mode.
  const wholeFilePatterns = [
    ...BUILTIN_WHOLE_FILE_REDACTION_FILES,
    ...(options?.sensitiveFiles ?? []),
  ];

  // ── Layer 1: Whole-file redaction for opaque credentials and custom rules ──
  if (isSensitiveFile(filePath, wholeFilePatterns)) {
    reasons.push(`文件 "${filePath}" 被标记为敏感文件`);
    const lines = text.split(/\r?\n/);
    const redactedLines = lines.map((line) => {
      if (line.trim().length === 0) return line;
      // Show the key name for key=value lines (sep position ≤ 60 chars)
      const eqIdx = line.indexOf("=");
      const colonIdx = line.indexOf(":");
      const sepIdx = eqIdx >= 0 ? eqIdx : colonIdx;
      if (sepIdx > 0 && sepIdx < 60) {
        return `${line.slice(0, sepIdx + 1)} ${REDACTED_MASK}`;
      }
      return REDACTED_MASK;
    });
    return { text: redactedLines.join("\n"), redacted: true, reasons };
  }

  // ── Layer 3: Value-level redaction via regex patterns ──
  // ALL patterns - format-anchored (token formats) and keyword-based alike -
  // apply ONLY to value-level sensitive files (the file-type settings).
  // Ordinary source files are never touched. Path-less tool output (e.g.
  // bash `cat` results) has no origin file and is therefore not redacted.
  // User-defined custom patterns follow the same file gate for consistency.
  if (!isSensitiveFile(filePath, BUILTIN_VALUE_REDACTION_FILES)) {
    return { text, redacted: false, reasons };
  }
  const allPatterns = buildSecretPatterns(BUILTIN_SECRET_PATTERN_DESCRIPTORS, options?.patterns ?? []);
  let result = text;

  for (const { name, pattern } of allPatterns) {
    const matches = result.match(pattern);
    if (matches && matches.length > 0) {
      reasons.push(`${name}: ${matches.length} 处`);
      // Quoted variants capture the surrounding quote in group 1; keep it so
      // `password = "***"` stays structurally intact for review and patches.
      // pattern.lastIndex is 0 because match() resets it; replace() is safe.
      result = result.replace(pattern, (...args: unknown[]) => {
        const quote = args[1];
        return quote === '"' || quote === "'"
          ? `${quote}${REDACTED_MASK}${quote}`
          : REDACTED_MASK;
      });
    }
  }

  return { text: result, redacted: result !== text, reasons };
}

/**
 * Check if redaction is enabled in the workflow config.
 */
export function isRedactionEnabled(workflow: { secrets?: { enabled: boolean } }): boolean {
  return workflow.secrets?.enabled !== false;
}
