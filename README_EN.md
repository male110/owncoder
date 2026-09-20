# OwnCoder

中文: [README.md](./README.md)

**Security-first AI coding tool — your code always stays yours.**

---

## Why OwnCoder?

When using AI coding tools, do you worry about:
- Database credentials being sent to the cloud?
- API keys, SSH private keys, and other secrets leaking?
- Your source code being uploaded to third-party servers?

**OwnCoder redacts sensitive information before anything is sent to the model, so your security stays protected.**

### Security First

OwnCoder starts from **security**, not after-the-fact patches:
- **Automatic redaction**: Database passwords, API keys, SSH private keys, and similar secrets are replaced with `[REDACTED]` before they reach the model
- **Fully local**: Code analysis, indexing, and retrieval all run on your machine — no source is uploaded to the cloud
- **Zero telemetry**: No usage analytics, no crash reporting, no tracking endpoints
- **You stay in control**: Your data lives only on your machine and always belongs to you

---

## Strong Security Protection

### Automatic Sensitive-Data Redaction

Your `.env` files, database connection strings, API keys, SSH private keys… before the Agent sends file contents to the model, they are **detected and replaced with `[REDACTED]`**. Secrets never leave your machine.

**Three layers of protection:**

| Layer | Mechanism | Coverage |
|------|-----------|----------|
| **File matching** | 60+ built-in glob patterns for sensitive files | `.env`, `*credentials*`, `*.pem`, `*.key`, `kubeconfig`, `terraform.tfvars`, and more |
| **Format detection** | 25+ precise regexes for known secret formats | OpenAI `sk-...`, AWS `AKIA...`, GCP `AIza...`, GitHub `ghp_...`, DB connection strings, JWT, PEM private key blocks |
| **Keyword matching** | Common credential keywords + uppercase env suffixes | `password`, `secret`, `token`, `api_key`, `*_PASSWORD`, `*_SECRET`, `*_TOKEN`, and more |

**Two redaction granularities:**

- **Value-level redaction** (`.env`, `credentials.json`, etc.): Only sensitive field values are masked; the rest stays readable so the Agent can still understand structure.
- **Full-file redaction** (`*.pem`, `*.key`, `id_rsa`, `*.sqlite`, etc.): Every non-empty line is masked; the Agent only learns that “this is a sensitive file.”

> Allowlist: template files such as `.env.example` and `.env.sample` are whitelisted and will not be redacted by mistake.

---

### Custom Redaction Rules

Every project is different. In **Settings → Security**, you can:

**1. Add custom sensitive files (glob patterns)**

Enter one glob per line. Matching files get **full-file redaction**:

```
config/production.json
*.secret
my-custom-env.*
internal/keys/*
```

**2. Add custom detection rules (regular expressions)**

Enter one regex per line. Matches are masked in value-level redaction files:

```
INTERNAL-\d{8}-[A-Z]+
my_company_[A-Za-z0-9]{32}
corp-secret:\s*\S+
```

Rules are compiled and appended after the built-in detectors. Invalid regexes are skipped silently.

**3. Redaction preview**

Click “Choose file to test”, pick any local file — the engine runs your current rules and shows:
- Which rules matched
- How many hits each rule produced
- A preview of the redacted content

You can validate redaction without calling an LLM.

---

### Three-Layer Write Protection

Stops the Agent from touching files it should not modify:

| Policy | Scope |
|--------|--------|
| **balanced** (recommended) | Blocks writes to `.git/`, `node_modules/`, `dist/`, `build/`, lockfiles, and internal `.owncoder/` paths |
| **strict** | Everything above, plus only ~70 code extensions (`.ts`, `.py`, `.rs`, etc.) and whitelisted filenames may be edited |
| **loose** | Only always-forbidden paths are blocked |

Every policy includes **path-escape detection** — attempts like `../` are intercepted.

---

### Dangerous Command Confirmation

When the Agent runs risky commands such as `rm -rf`, `git push --force`, or `chmod 777`, a confirmation bar appears:
- Shows the full command clearly
- **Enter does not approve** — you must click “Allow”
- Esc or “Deny” cancels the action
- Window crash or 120s with no response → **auto-deny** (fail-closed)

---

## High Cache Hit Rate

Tokens cost money. OwnCoder is built to reuse context aggressively, with cache hit rates up to about 95%:

![Screenshot](%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE%202026-09-17%20235326.png)

---

## Core Features

### Plan + Agent Dual Modes

| Mode | Capabilities | Best for |
|------|--------------|----------|
| **Plan** | Read-only: analyze code, search, produce plans | Requirements, architecture, code review |
| **Agent** | Read/write: edit files, run commands, run tests | Feature work, bug fixes, refactors |

### Execution-Level Verification Engine

After the Agent changes code, it runs real compilers / type checkers / tests:
- Type checks: `tsc`, `mypy`, `go vet`
- Linters: `eslint`, `ruff`, `pylint`
- Tests: discovers related test files automatically

On failure it enters an **auto-fix loop** and corrects issues from compiler errors.

### Inline Change Review

After each Agent action, a change bar appears above the chat with per-file diffs:
- Per-file Keep / Undo
- Keep all / Undo all
- Click a filename to open it in the Monaco editor

### Embedded Code Retrieval

- **Unified index**: high-performance full-text index on SQLite + FTS5
  - Symbol search: 35+ languages via tree-sitter
  - Full-text search: FTS5 virtual tables for fast keyword lookup
  - Experience index: stores fix records for cross-session reuse
  - Incremental scan: smart updates, respects `.gitignore`
- **Local RAG embeddings**: three backends (FastLocalEmbedding / NeuralEmbedding / ApiEmbedding), usable offline

### Other Highlights

- **MCP protocol**: configure any stdio MCP server; tools are exposed to the Agent automatically
- **Sub-agent coordination**: hierarchical task breakdown with shared memory between sub-agents
- **Experience learning**: the Agent remembers past fix patterns and retrieves them across sessions
- **@ file mentions**: `@filename` injects context with autocomplete
- **Multi-session concurrency**: run multiple Agent tasks at once
- **Bilingual design**: Chinese UI + English runtime prompts, aimed at Chinese-speaking developers

---

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **pnpm** (`npm install -g pnpm`)
- **Windows** (primary supported platform today)

> `.npmrc` is preconfigured with the npmmirror registry for faster installs.

### Install and Run

```bash
git clone https://github.com/YOUR_ORG/owncoder.git
cd owncoder
pnpm install

# Rebuild native modules for Electron (better-sqlite3, node-pty)
cd apps/desktop && pnpm rebuild && cd ../..

# Build all TypeScript packages
pnpm -r run build

# Start the dev server
pnpm dev
```

> **Why `pnpm rebuild`?** `better-sqlite3` and `node-pty` are native C++ modules and must be compiled for Electron’s Node.js ABI. Skipping this step often causes `NODE_MODULE_VERSION` mismatch errors. Re-run after every `pnpm install`.

---

### Connect a Model

OwnCoder works with any OpenAI-compatible API:

1. Open **Settings → Models**
2. Add a provider: name, Base URL, API Key
3. Pick the model from the chat dropdown

Compatible with OpenAI, DeepSeek, Tongyi Qianwen, Zhipu, Moonshot, and any service that speaks the OpenAI Chat Completions API.

---

## Development

### Project Structure

| Path | Description |
|------|-------------|
| `apps/desktop` | Electron desktop app |
| `packages/shared` | Shared types |
| `packages/settings` | Config schema, pipeline nodes, redaction rules |
| `packages/llm` | OpenAI-compatible client |
| `packages/core` | Agent core (loop, patches, checkpoints, verification, LSP, RAG, redaction engine) |
| `packages/index` | Unified index (SQLite + FTS5, pure TypeScript) |
| `scripts/` | Smoke tests and build scripts |

---

## Usage Stats

The project uses the following script for usage statistics:

```html
<script async src="https://01a0aa89-d212-7984-96e9-45fa2ee539c2.spst2.com/ustat.js"></script>
```

---

## License

This project is licensed under the **PolyForm Noncommercial License 1.0.0**. See [LICENSE](./LICENSE) for the full text.

**In short:**
- You may use it for personal, academic, educational, and non-profit purposes
- You may freely use, modify, and distribute the project for non-commercial use
- **Commercial use is not allowed** (including sale, licensing, commercial services, etc.)
- Redistribution must keep the license file and copyright notices

> For commercial licensing, contact the author for a separate commercial license.

---

> Chinese version: [README.md](./README.md)
