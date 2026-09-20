/** Shared bash / terminal helpers. */

export interface TerminalEntry {
  id: string;
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  status: "running" | "ok" | "error" | "denied" | "pending_confirm";
  at: string;
}

export function looksDangerous(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return (
    /\brm\s+(-[a-z]*[rf]|\/s)\b/.test(c) ||
    /\bdel\s+(?:\/[sq]\s+|[^\r\n]*[*>?])/.test(c) ||
    /\brmdir\s+\/s\b/.test(c) ||
    /\bformat\s+/i.test(c) ||
    /\b(shutdown|restart-computer)\b/.test(c) ||
    /\breg\s+(delete|add)\b/.test(c) ||
    /\bgit\s+push\s+.*--force(?:-with-lease)?\b/.test(c) ||
    /\bgit\s+reset\s+--hard\b/.test(c) ||
    /\bgit\s+clean\s+-[^\s]*f/.test(c) ||
    // Discarding uncommitted work is just as destructive as `reset --hard`, and
    // these are the forms an agent actually reaches for. `git stash` in
    // particular *moves* the working tree away — it silently undoes edits.
    /\bgit\s+checkout\s+(?:.*\s)?--(?:\s|$)/.test(c) ||
    /\bgit\s+checkout\s+(?:-f\b|--force\b)/.test(c) ||
    /\bgit\s+restore\b/.test(c) ||
    /\bgit\s+stash\b(?!\s+(?:list|show)\b)/.test(c) ||
    /\bgit\s+rm\b/.test(c) ||
    /\bgit\s+switch\s+.*(?:-f\b|--force\b|--discard-changes\b)/.test(c) ||
    /\bgit\s+branch\s+.*-D\b/.test(cmd) ||
    /\bgit\s+worktree\s+remove\b/.test(c) ||
    /\bgit\s+filter-branch\b/.test(c) ||
    /\bgit\s+update-ref\s+-d\b/.test(c) ||
    /\bRemove-Item\b.*(?:-Recurse|-Force)/i.test(cmd) ||
    /\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item)\b/i.test(cmd) ||
    /\b(?:cp|mv|touch|mkdir|chmod|chown)\b/.test(c) ||
    /(?:^|\s)(?:>>?|2>)\s*[^&|]/.test(c) ||
    /\b(drop\s+(?:database|table)|truncate\s+table)\b/i.test(c)
  );
}

/** Safe single read-only commands allowed in Plan mode when bash=readonly. */
export function isReadonlyBash(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || looksDangerous(c)) return false;
  // Never permit command composition, substitution, pipelines, or redirection:
  // a safe-looking prefix such as `git status; Set-Content ...` must not escape.
  if (/[|&;`]|\$\(|[<>]/.test(c) || /\r|\n/.test(c)) return false;
  return /^(ls|dir|pwd|cd|cat|type|head|tail|wc|echo|which|where|git\s+(status|diff|log|show|branch|rev-parse)|rg|grep|findstr|Get-ChildItem|Get-Content|Get-Location|Select-String|Test-Path|Get-Item|Resolve-Path|Write-Output)\b/i.test(
    c,
  );
}
