# Terminal completion

The interactive terminal supports automatic completion in Windows PowerShell with a compatible PSReadLine Windows/Emacs editor. No additional npm package or PowerShell profile change is required. Open a new terminal after updating the desktop main/preload code.

## Using it

- Type `git checkout ` or `git switch ` to see local and remote-tracking branches.
- Continue typing, such as `git checkout ex`, to filter the candidates.
- Use Up/Down or Shift+Tab to select; Tab or Enter inserts the selected candidate without executing the command. Press Enter again to execute once the menu is closed. Escape dismisses the list.
- Click a candidate to insert it while retaining terminal focus.
- Literal filesystem paths are also supported, including directories after `cd` and paths after `git checkout --`.
- With no visible completion menu, keys are forwarded to the native terminal editor. The old application-managed history ghost text has been removed; shell history and native suggestions remain available.

## Architecture

`main/terminal/powershell.ts` creates a session-local bootstrap script, preserving the existing profile and prompt. The PSReadLine integration reports actual buffer text, cursor, cwd and input/execution state using authenticated OSC frames. `protocol.ts` handles frames split across PTY chunks and removes private protocol data from terminal output.

`session.ts` assigns monotonic context revisions, rejects stale asynchronous queries and only accepts items issued for the current revision. Acceptance writes a private pending edit and sends a data-free PSReadLine action. The shell revalidates its buffer, cursor, cwd and sequence before replacing text. Selected text is never evaluated as PowerShell or dispatched as a command.

`completions.ts` parses a deliberately small literal command grammar. Git queries run with fixed argument arrays, a timeout and an output limit; branch results are cached briefly. Providers do not fetch remotes or change Git state. Filesystem candidates are escaped as PowerShell literals.

The renderer's `components/terminal/completion-controller.ts` debounces authoritative context updates, cancels stale requests and coordinates menu selection. The menu is only interactive when visible in the focused active terminal. Unsupported environments retain native terminal behavior.

## First-version boundaries

- Bash, Zsh, cmd, WSL/SSH nested shells and remote completion integration are not implemented.
- Vi mode, unknown custom line readers, conflicting private action bindings, unsupported PSReadLine internals or subsequently changed editor bindings disable enhanced completion rather than guessing shell input.
- Non-ASCII/IME insertion may not refresh suggestions until a wrapped editor action reports the current buffer. Normal input is still passed through.
- Scripts, pipelines, variables, command substitutions, aliases and complex Git argument combinations are not parsed. New-branch names are not incorrectly treated as existing-branch positions.
- Completing an existing exact token is omitted to avoid repeatedly intercepting Enter.
- Authentication prevents accidental output from being mistaken for integration messages; it is not a security boundary against programs already running as the same local user.

## Tests

From the repository root:

```sh
pnpm exec vitest run --root apps/desktop --config vitest.config.ts src/main/terminal src/renderer/src/components/terminal
pnpm --filter @owncoder/desktop build
pnpm --filter @owncoder/desktop typecheck
```

PowerShell runtime tests run on Windows and are skipped on other platforms. They use temporary directories and exercise the installed PowerShell/PSReadLine implementation, including native editing, cancellation, completion, existing custom handlers, command execution boundaries and stale edit rejection.
