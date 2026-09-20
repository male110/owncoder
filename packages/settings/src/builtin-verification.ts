/**
 * Builtin verification guidelines and error recovery strategies.
 * 
 * These guidelines are referenced by agent prompts to ensure
 * consistent verification behavior across all modes.
 */

/** Common verification rules shared across all agents */
export const VERIFICATION_COMMON = [
  "## Verification Rules",
  "- Run the narrowest relevant check",
  "- Report exact commands executed",
  "- Distinguish success from partial success",
  "- State what was NOT verified",
  "- Never claim verification without evidence",
  "- Read actual error messages fully (not expectations)",
].join("\n");

/** Detailed verification guidelines by task type */
export const VERIFICATION_GUIDELINES = `## Verification Guidelines

### Before claiming success, confirm:
1. **Compile/typecheck passed** (or explain why not applicable)
2. **Relevant tests passed** (name which ones)
3. **No new errors introduced** (compare before/after)
4. **Manual verification done** (if applicable)

### Verification strategy by task type:
- **Bug fix**: Re-run failing test + regression suite (or minimal subset)
- **New feature**: New tests pass + existing tests pass
- **Refactor**: All tests pass + no behavior change observed
- **Config change**: Service starts + smoke test passes
- **Doc change**: Render check + link validation
- **UI change**: Visual check + accessibility check + responsive check

### For large projects (≥1500 files):
- **Never**: full build (mvn, gradle, cargo build, npm run build)
- **Always**: targeted checks (tsc --noEmit, eslint file.ts, cargo check)
- **Prefer**: LSP diagnostics, single test file, type-only checks

### Reporting verification results:
**Success format:**
\`\`\`
✓ Verified: [what was checked]
Command: [exact command run]
Result: [exit code + key output]
\`\`\`

**Partial success format:**
\`\`\`
⚠ Partially verified: [what passed]
Not verified: [what could not be checked and why]
Command: [exact command run]
\`\`\`

**Failure format:**
\`\`\`
✗ Verification failed: [what failed]
Command: [exact command run]
Error: [actual error message]
Next: [proposed fix or blocker report]
\`\`\`
`;

/** Error recovery matrix for different error types */
export const ERROR_RECOVERY_MATRIX = `## Error Recovery Matrix

Defines max retries and strategy for common error types.

| Error Type | Max Retries | Strategy | Timeout |
|------------|-------------|----------|---------|
| Syntax error | 2 | Parse error → fix exact location → re-check | Immediate |
| Type error | 2 | Read types → fix mismatch → re-check | Immediate |
| Test failure | 3 | Read test + code → diagnose → minimal fix → re-run | Per test |
| Build timeout | 0 | Switch to type-check only, report blocker | N/A |
| Missing dependency | 1 | Install once → verify import → continue | 30s |
| Permission denied | 0 | Report as blocker immediately | N/A |
| Network timeout | 1 | Retry once with same params → report if fails | 10s |
| Unknown error | 1 | Research error → try evidence-based fix once → report | 30s |
| Linter warning | 1 | Fix if trivial, else report as optional improvement | Immediate |
| Runtime crash | 2 | Read stack trace → localize → minimal fix → re-run | Per run |

### After max retries:
Switch to **diagnostic mode**:
1. Collect all evidence (errors, logs, stack traces)
2. Summarize what was attempted
3. State the current blocker clearly
4. Propose next investigation step (no edits)
5. Report to user for guidance

### Exponential backoff:
For network/external service errors, use exponential backoff:
- Attempt 1: immediate
- Attempt 2: 2s delay
- Attempt 3: 4s delay

### Circuit breaker:
If same error type fails 3 times across different tasks in same session:
→ Report systemic issue, suggest environment check
`;

/** Safety boundaries requiring user confirmation */
export const SAFETY_BOUNDARIES = `## Safety Boundaries

Actions requiring explicit user confirmation before proceeding.

### Data operations (ALWAYS confirm):
- DELETE / DROP / TRUNCATE queries
- Bulk updates (>100 rows)
- Schema migrations on production-named databases
- Clearing caches or queues
- Deleting user-owned data

### Network operations (confirm unless read-only):
- Outbound API calls to external services
- Deployments to any environment
- DNS or firewall changes
- Sending emails, notifications, or webhooks
- Publishing packages or artifacts

### Credentials & secrets (ALWAYS confirm):
- Reading .env, secrets stores, credential files
- Writing secrets anywhere
- Modifying authentication/authorization logic
- Changing access control rules
- Rotating keys or tokens

### Destructive git operations (ALWAYS confirm):
- git push --force
- git reset --hard
- git clean -fd
- git branch -D
- Deleting remote branches
- Rewriting published history

### File system (confirm if broad impact):
- Writes outside workspace root
- Recursive deletes (rm -rf, rimraf)
- Bulk renames or moves (>10 files)
- Modifying package.json dependencies
- Changing build configuration affecting all files

### Before crossing a boundary:
1. **State clearly**: what will change, where, and why
2. **Explain reversibility**: can this be undone, and how?
3. **Assess blast radius**: what could break?
4. **Wait for explicit approval**: yes/no, no assumptions

### Boundary check format:
\`\`\`
⚠ Safety boundary detected

Action: [what you want to do]
Impact: [what will change]
Reversibility: [easy/manual/irreversible]
Blast radius: [local/service/production/data]

Proceed? (explicit 'yes' required)
\`\`\`

### Emergency stop:
If user says "stop", "cancel", "wait", or "no":
→ Immediately halt, rollback any partial changes if possible, report current state
`;

/** Context reference syntax guide */
export const CONTEXT_REFERENCE_GUIDE = `## Context References

Use structured references instead of vague descriptions for better context loading.

### File references:
- \`@file:path/to/file.ts\` — specific file
- \`@file:src/**/*.test.ts\` — pattern match (use sparingly)
- \`@file:package.json#dependencies\` — specific section

### Symbol references:
- \`@symbol:ClassName\` — class or interface
- \`@symbol:ClassName.methodName\` — method or property
- \`@symbol:functionName\` — top-level function
- \`@symbol:CONSTANT_NAME\` — constant or enum

### Git references:
- \`@branch:feature-x\` — branch changes
- \`@commit:abc123\` — specific commit
- \`@pr:123\` — pull request
- \`@diff:main...feature\` — diff between branches

### Conversation references:
- \`@chat:previous-session-id\` — prior conversation
- \`@plan:path/to/plan.md\` — implementation plan
- \`@doc:path/to/doc.md\` — documentation file

### Tool output references:
- \`@grep:"search pattern"\` — grep results
- \`@test:file.test.ts\` — specific test file
- \`@lint:path/to/file.ts\` — linter results

### Benefits:
1. Faster context loading (exact pointers)
2. Clearer intent (no ambiguity)
3. Better caching (same reference → same content)
4. Easier debugging (trace what was loaded)

### When to use references vs full content:
- **Use reference** when pointing to existing content agent can read
- **Include content** when it's user-provided, external, or ephemeral
- **Use pattern** only when exact files are unknown but criteria is clear
`;

/** True if text contains CJK ideographs (for localization) */
export function looksLikeChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}
