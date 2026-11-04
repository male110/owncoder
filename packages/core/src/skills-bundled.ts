/**
 * Bundled skills (scope: "system") are compiled into the package, always
 * enabled, and not manageable from the settings UI. They exist so users can
 * inspect a working SKILL.md example and so core workflows can ship guidance
 * without any files on disk.
 */
import type { BundledSkill } from "./skills.ts";

export const BUNDLED_SKILLS: BundledSkill[] = [
  {
    name: "code-review",
    description:
      "Use when the user asks to review code changes, a diff, or a pull request. " +
      "Runs a focused correctness review of the pending changes before they are considered done.",
    when_to_use:
      "Only for explicit review requests ('review my changes', 'check this diff'). " +
      "Do not activate for ordinary implementation tasks.",
    content: [
      "# Code review checklist",
      "",
      "Review the pending changes in this workspace (via bash `git status`) to find modified files and `read_file` to inspect them. Follow this checklist in order:",
      "",
      "1. **Correctness**: trace the changed logic for off-by-one errors, inverted conditions, null/undefined dereferences, and unhandled promise rejections.",
      "2. **Behavior preservation**: flag any change that alters public behavior (API shape, file formats, CLI flags) without a stated requirement.",
      "3. **Error handling**: every new failure path (I/O, parse, network) must surface a actionable message or be explicitly handled.",
      "4. **Security**: no secrets or credentials added; no unvalidated input reaching shell commands, SQL, or file paths; no new path-traversal surface.",
      "5. **Tests**: changed behavior must be covered — point out missing tests rather than writing them unless asked.",
      "6. **Style consistency**: naming, imports, and comment density must match the surrounding code.",
      "",
      "Report findings as a numbered list ordered by severity (blocking → warning → nit), each with file:line and a one-line rationale. If a finding is subjective, say so explicitly. End with a one-line verdict: APPROVE, REQUEST CHANGES, or COMMENT.",
    ].join("\n"),
  },
  {
    name: "install-skill",
    description:
      "Use when the user wants to find and install a skill (e.g. 'I want a skill that does X', " +
      "'install a skill for Y'). Searches the web for a matching SKILL.md, verifies it, and " +
      "installs it into the project or user skills directory.",
    when_to_use:
      "Only for requests to obtain a NEW skill from outside (search/GitHub). " +
      "To write a custom skill from scratch, propose it and write SKILL.md directly.",
    content: [
      "# Installing skills",
      "",
      "A skill is a directory containing a `SKILL.md` whose YAML frontmatter declares `name` and " +
      "`description` (optionally `when_to_use` / `enabled`), followed by Markdown instructions for " +
      "the model. It may carry resource files (scripts/, references/, assets/) referenced from the " +
      "body. Installed skills appear in the \"Available skills\" section and load on demand via `use_skill`.",
      "",
      "## Install targets",
      "",
      "The \"Available skills\" section above names the two skill directories. Use them verbatim:",
      "- Project: `<workspace>/.owncoder/skills/<name>/` — travels with the repository; write with " +
      "`write_file` using the workspace-relative path `.owncoder/skills/<name>/SKILL.md`.",
      "- User: the ABSOLUTE user skills directory printed in the section header — applies to every " +
      "project on this machine; write with `write_file` using that absolute path (outside the " +
      "workspace, which is allowed — it is tracked as an external write, not session-undoable).",
      "Default to project scope unless the user asks for user scope or no workspace is open.",
      "",
      "## Procedure",
      "",
      "1. **Search**: `web_search(\"<topic> skill SKILL.md\")` — skills are a cross-tool convention; " +
      "GitHub repos/gists containing a `SKILL.md` are the normal source. Open 2-3 promising results " +
      "with `web_fetch`.",
      "2. **Verify**: the candidate must have a `SKILL.md` with frontmatter `name` + `description`, " +
      "and the body must be followable instructions — not code to execute blindly, not a demand for " +
      "credentials or an install script to run.",
      "3. **Fetch raw**: convert `https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md` to " +
      "`https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>/SKILL.md` and `web_fetch` it. " +
      "For gists use `https://gist.githubusercontent.com/...`. You need the raw text, not the HTML page.",
      "4. **Install**: `write_file` the raw SKILL.md to `<target-dir>/<name>/SKILL.md`, using the " +
      "frontmatter `name` as the directory name. Then copy every resource file the body references " +
      "the same way, preserving subdirectories (e.g. `scripts/run.sh`). A referenced `scripts/` the " +
      "body actually runs must be fetched — if it is unavailable, tell the user and do not install.",
      "5. **Verify + report**: call `use_skill` with the new skill name to confirm it loads, then " +
      "tell the user the name, description and where it was installed (it can be toggled later in " +
      "Settings → Skills).",
      "",
      "## Rules",
      "",
      "- NEVER run an install script or `curl … | bash` from a skill repo. Skills are text " +
      "instructions; resource scripts are invoked later by the skill's own body, not by you now.",
      "- When the source is unfamiliar, show the user the frontmatter and the first lines of the " +
      "body before installing; use `ask_user` if anything looks untrusted.",
      "- Do NOT fabricate a skill and present it as if it came from the web. If nothing suitable " +
      "is found, say so and offer to write a local custom skill instead (with the user's approval).",
    ].join("\n"),
  },
];
