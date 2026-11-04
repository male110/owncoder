import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ACCEPT_CHORD = "\x1b[24;5~"; // Ctrl+F12: data-free editor action, never a command.

export interface PowerShellIntegration {
  nonce: string;
  editPath: string;
  scriptPath: string;
  args: string[];
  dispose(): void;
}

export function createPowerShellIntegration(): PowerShellIntegration {
  const nonce = randomBytes(32).toString("hex");
  const dir = mkdtempSync(join(tmpdir(), "owncoder-terminal-"));
  const editPath = join(dir, "edit.json");
  const scriptPath = join(dir, "integration.ps1");
  try {
    writeFileSync(scriptPath, "\ufeff" + powerShellScript(nonce, editPath), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const encodedPath = Buffer.from(scriptPath, "utf8").toString("base64");
  const startup = `. ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')))`;
  return {
    nonce, editPath, scriptPath,
    // Keep profiles. Bootstrap is encoded only to avoid argv/PowerShell quoting differences.
    args: ["-NoLogo", "-NoExit", "-EncodedCommand", Buffer.from(startup, "utf16le").toString("base64")],
    dispose() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* exited shell may still hold files */ } },
  };
}

/** Deliberately no per-keystroke subprocesses or polling. Unknown PSReadLine internals fail closed. */
export function powerShellScript(nonce: string, editPath: string): string {
  const literal = (s: string) => `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(s, "utf8").toString("base64")}')))`;
  return `
try {
  Import-Module PSReadLine -ErrorAction Stop
  if ((Get-PSReadLineOption).EditMode -eq 'Vi') { throw 'Vi mode is not supported' }
  $originalReadLine = (Get-Item Function:\\PSConsoleHostReadLine -ErrorAction Stop).ScriptBlock
  # Only enable for a known direct PSReadLine host reader. A custom Read-Host/REPL
  # wrapper cannot truthfully advertise the PSReadLine buffer; leave it untouched.
  $knownReader = '\\A\\s*(?:(?:Microsoft\\.PowerShell\\.Core\\\\)?Set-StrictMode\\s+-Off\\s*;?\\s*)?\\[Microsoft\\.PowerShell\\.PSConsoleReadLine\\]::ReadLine\\(\\s*\\$host\\.Runspace\\s*,\\s*\\$ExecutionContext\\s*\\)\\s*\\z'
  if ($originalReadLine.ToString() -notmatch $knownReader) { throw 'Unsupported custom line reader' }
  $global:__ocTerminal = @{
    Nonce = ${literal(nonce)}; EditPath = ${literal(editPath)}; Sequence = 0L; Reading = $false
    OriginalReadLine = $originalReadLine
    OriginalPrompt = (Get-Item Function:\\prompt -ErrorAction Stop).ScriptBlock
  }
  function global:__ocPublish([bool]$Active, [bool]$Empty = $false) {
    try {
      $line = ''; $cursor = 0
      if ($Active -and !$Empty) {
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        # AcceptLine can return before the host reader's finally runs. Never announce
        # an editable state in that interval (the next recipient might be a program).
        if ($global:__ocTerminal.Accepted.GetValue($global:__ocTerminal.Editor)) { $Active = $false }
      }
      $location = Get-Location
      if ($location.Provider.Name -ne 'FileSystem' -or $line.Length -gt 32768) { $Active = $false }
      $global:__ocTerminal.Sequence++
      $json = @{ sequence = $global:__ocTerminal.Sequence; cwd = $location.Path; line = $line; cursor = $cursor; active = $Active } | ConvertTo-Json -Compress
      $bytes = [Text.Encoding]::UTF8.GetBytes($json)
      # JSON escapes can expand a short buffer (e.g. 30k apostrophes) past the
      # protocol bound. Publish a small inactive state instead of a huge OSC.
      if ($bytes.Length -gt 131072) {
        $json = @{ sequence = $global:__ocTerminal.Sequence; cwd = ''; line = ''; cursor = 0; active = $false } | ConvertTo-Json -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
      }
      $encoded = [Convert]::ToBase64String($bytes)
      [Console]::Write(([string][char]27) + ']633;OwnCoder;' + $global:__ocTerminal.Nonce + ';' + $encoded + [char]7)
    } catch { $global:__ocTerminal.Reading = $false }
  }

  # Snapshot the real dispatch delegates, including custom scriptblock handlers. Public
  # Get-PSReadLineKeyHandler exposes only names, which would silently destroy custom bindings.
  $flags = [Reflection.BindingFlags]'NonPublic,Instance,Static'
  $type = [Microsoft.PowerShell.PSConsoleReadLine]
  $singleton = $type.GetField('_singleton', $flags).GetValue($null)
  $dispatch = $type.GetField('_dispatchTable', $flags).GetValue($singleton)
  $chords = $type.GetField('_chordDispatchTable', $flags).GetValue($singleton)
  $global:__ocTerminal.Editor = $singleton
  $global:__ocTerminal.Accepted = $type.GetField('_inputAccepted', $flags)
  if (!$dispatch -or !$chords -or !$global:__ocTerminal.Accepted) { throw 'Unsupported PSReadLine dispatch layout' }
  foreach ($entry in $dispatch.GetEnumerator()) {
    if ($entry.Key.KeyStr -eq 'Ctrl+F12') { throw 'Private editor chord already in use' }
  }
  # Preserve native exception and dispatch semantics (notably Ctrl+C cancellation).
  # Calling native delegates via a PowerShell ScriptBlock would wrap their exceptions
  # in MethodInvocationException and PSReadLine would swallow cancellation.
  if (!('OwnCoderTerminalKeys' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
public static class OwnCoderTerminalKeys {
  public static Action<ConsoleKeyInfo?, object> Wrap(Action<ConsoleKeyInfo?, object> original, Action report, Action failed) {
    return (key, arg) => {
      bool completed = false;
      try { original(key, arg); completed = true; }
      finally { if (completed) report(); else failed(); }
    };
  }
}
'@ -ErrorAction Stop
  }
  $report = [Action]{ if ($global:__ocTerminal.Reading) { __ocPublish $true } }
  $failed = [Action]{ $global:__ocTerminal.Reading = $false; __ocPublish $false }
  $saved = @{}
  foreach ($entry in $dispatch.GetEnumerator()) {
    if ($entry.Value.Action -and $entry.Value.BriefDescription -ne 'Chord') {
      $saved[$entry.Key.KeyStr] = $true
      $entry.Value.Action = [OwnCoderTerminalKeys]::Wrap($entry.Value.Action, $report, $failed)
    }
  }
  foreach ($prefix in $chords.GetEnumerator()) {
    foreach ($entry in $prefix.Value.GetEnumerator()) {
      if ($entry.Value.Action) { $entry.Value.Action = [OwnCoderTerminalKeys]::Wrap($entry.Value.Action, $report, $failed) }
    }
  }
  # Unbound printable ASCII uses SelfInsert internally, so it needs explicit wrappers.
  # Unhandled Unicode/IME input remains inactive backend-side until a wrapped action reports it.
  for ($i = 32; $i -le 126; $i++) {
    $chord = [string][char]$i
    if ($saved.ContainsKey($chord)) { continue }
    Set-PSReadLineKeyHandler -Chord $chord -ScriptBlock {
      param($key, $arg)
      [Microsoft.PowerShell.PSConsoleReadLine]::SelfInsert($key, $arg)
      if ($global:__ocTerminal.Reading) { __ocPublish $true }
    } -ErrorAction Stop
  }
  Set-PSReadLineKeyHandler -Chord 'Ctrl+F12' -ScriptBlock {
    param($key, $arg)
    try {
      if (!$global:__ocTerminal.Reading -or !(Test-Path -LiteralPath $global:__ocTerminal.EditPath)) { return }
      $raw = [IO.File]::ReadAllText($global:__ocTerminal.EditPath)
      [IO.File]::Delete($global:__ocTerminal.EditPath)
      if ($raw.Length -gt 196608) { return }
      $edit = $raw | ConvertFrom-Json -ErrorAction Stop
      $line = ''; $cursor = 0
      [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
      if ($edit.nonce -cne $global:__ocTerminal.Nonce -or $edit.sequence -ne $global:__ocTerminal.Sequence -or
          $edit.line -cne $line -or $edit.cursor -ne $cursor -or $edit.cwd -cne (Get-Location).Path -or
          $edit.from -isnot [int] -or $edit.to -isnot [int] -or $edit.from -lt 0 -or $edit.to -lt $edit.from -or
          $edit.to -gt $line.Length -or $edit.text -isnot [string] -or $edit.text.Length -gt 32768 -or
          $edit.text -match '[\\x00-\\x1f\\x7f\\u2018-\\u201f]') { return }
      [Microsoft.PowerShell.PSConsoleReadLine]::Replace($edit.from, $edit.to - $edit.from, $edit.text)
    } catch { } finally { if ($global:__ocTerminal.Reading) { __ocPublish $true } }
  } -ErrorAction Stop

  $global:__ocTerminal.Dispatch = $dispatch
  $global:__ocTerminal.DispatchField = $type.GetField('_dispatchTable', $flags)
  $global:__ocTerminal.EditMode = (Get-PSReadLineOption).EditMode
  $global:__ocTerminal.Bindings = @{}
  foreach ($entry in $dispatch.GetEnumerator()) { $global:__ocTerminal.Bindings[$entry.Key] = $entry.Value.Action }
  function global:__ocCanRead {
    try {
      if ((Get-PSReadLineOption).EditMode -ne $global:__ocTerminal.EditMode -or
          ![object]::ReferenceEquals($global:__ocTerminal.DispatchField.GetValue($global:__ocTerminal.Editor), $global:__ocTerminal.Dispatch) -or
          $global:__ocTerminal.Dispatch.Count -ne $global:__ocTerminal.Bindings.Count) { return $false }
      foreach ($entry in $global:__ocTerminal.Bindings.GetEnumerator()) {
        if (![object]::ReferenceEquals($global:__ocTerminal.Dispatch[$entry.Key].Action, $entry.Value)) { return $false }
      }
      return $true
    } catch { return $false }
  }
  function global:prompt {
    # Invoke first so the existing prompt can observe the previous command's $?.
    # The reader's finally already marked execution inactive before the prompt.
    try { & $global:__ocTerminal.OriginalPrompt }
    finally { $global:__ocTerminal.Reading = $false; __ocPublish $false }
  }
  function global:PSConsoleHostReadLine {
    $global:__ocTerminal.Reading = __ocCanRead
    __ocPublish $global:__ocTerminal.Reading $true
    try { & $global:__ocTerminal.OriginalReadLine }
    finally {
      $global:__ocTerminal.Reading = $false
      __ocPublish $false
    }
  }
} catch {
  # Preserve a usable native terminal even on unknown PSReadLine versions/profiles.
  if ($global:__ocTerminal) {
    $global:__ocTerminal.Reading = $false
    if (Get-Command __ocPublish -ErrorAction SilentlyContinue) { __ocPublish $false }
  }
}
`;
}
