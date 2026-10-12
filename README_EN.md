# OwnCoder

中文: [README.md](./README.md)

**An AI coding tool focused on security and token savings: file redaction protects sensitive information, a higher-cost model plans and guides, and a lower-cost model executes.**

---

## Why OwnCoder?

AI coding tools need to protect passwords and keys in your files while controlling the token costs of repeatedly reading code, editing files, and running checks. OwnCoder focuses on both:

| Core value | How it works |
|------------|--------------|
| **Security: file redaction** | Sensitive values in protected files are masked locally before the redacted content reaches the model; custom file rules and redaction previews are supported |
| **Token savings and lower costs: separate model roles** | A higher-cost model understands the request, breaks down the task, and provides execution steps; a lower-cost model follows those steps to edit and verify code, with on-demand retrieval and context caching to reduce costs |

### 🔒 Security: Redact File Contents Before Sending Them to the Model

- **Automatic redaction**: Configuration, credential, and private key files covered by the rules receive value-level or full-file redaction, masking sensitive content with `***`.
- **Local processing**: File redaction, code indexing, and retrieval run locally. Redaction does not modify the original files on disk.
- **Configurable rules**: Add project-specific sensitive file and detection rules, and preview the results in Settings.

When using a remote model, code snippets and context needed for the task are still sent to your configured model service. Redaction protects sensitive content covered by the rules; see the scope described below.

### 💰 Token Savings: A Higher-Cost Model Plans, a Lower-Cost Model Executes

**Let a higher-cost model guide a lower-cost model through the task.** The higher-cost model first understands the request, organizes constraints, and creates ordered steps. The lower-cost model then follows those steps to retrieve code, edit files, run commands, and verify results. The execution loop, which consumes more tokens, can use a lower-cost model while the higher-cost model focuses on planning.

On-demand code reads and context caching further reduce unnecessary input tokens and execution costs.

---

## Strong Security Protection

### Automatic Sensitive-Data Redaction

With redaction enabled, when the Agent reads protected files such as `.env`, credential configurations, and SSH private keys through built-in file-reading tools, the contents are redacted locally before being returned to the model. Matching sensitive content is replaced with `***`, and the original files remain unchanged.

**Three layers of protection:**

| Layer | Mechanism | Coverage |
|------|-----------|----------|
| **File matching** | 60+ built-in glob patterns for sensitive files | `.env`, `*credentials*`, `*.pem`, `*.key`, `kubeconfig`, `terraform.tfvars`, and more |
| **Format detection** | 25+ precise regexes for known secret formats | OpenAI `sk-...`, AWS `AKIA...`, GCP `AIza...`, GitHub `ghp_...`, DB connection strings, JWT, PEM private key blocks |
| **Keyword matching** | Common credential keywords + uppercase env suffixes | `password`, `secret`, `token`, `api_key`, `*_PASSWORD`, `*_SECRET`, `*_TOKEN`, and more |

**Two redaction granularities:**

- **Value-level redaction** (`.env`, `credentials.json`, etc.): Only sensitive field values are masked; the rest stays readable so the Agent can still understand structure.
- **Full-file redaction** (`*.pem`, `*.key`, `id_rsa`, `*.sqlite`, etc.): Non-empty line contents are masked. Some key-value lines retain their keys and separators to help the Agent understand the structure.

> Scope: Value-level detection rules apply only to sensitive files covered by the built-in rules; ordinary source files do not automatically receive these checks. Custom sensitive file rules use full-file redaction. Template files such as `.env.example` and `.env.sample` are allowlisted and excluded from redaction. Use the preview to confirm that your project's sensitive files are covered.

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

### File Writes and Security Boundaries

Built-in file tools allow the Agent to modify files inside the workspace. There is no longer a write policy that blocks sensitive files, dependency directories, build artifacts, lockfiles, or particular file extensions. File contents are still redacted before being sent to the model, and redaction never changes the local files.

Workspace boundaries are still checked. Potentially destructive writes or deletes performed through Agent commands still require dangerous-command confirmation.

---

### Dangerous Command Confirmation

When the Agent runs risky commands such as `rm -rf`, `git push --force`, or `chmod 777`, a confirmation bar appears:
- Shows the full command clearly
- **Enter does not approve** — you must click “Allow”
- Esc or “Deny” cancels the action
- Window crash or 120s with no response → **auto-deny** (fail-closed)

---

## 💰 Token Savings and Model Cost Optimization

### A Higher-Cost Model Plans, a Lower-Cost Model Executes

OwnCoder lets you configure models and reasoning effort separately for task decomposition and the execution loop, so a plan produced by a more capable model guides a lower-cost model's execution.

| Stage | Recommended model | Responsibilities |
|-------|-------------------|------------------|
| **Task decomposition** | A more capable, higher-cost model | Understand user intent, organize relevant history and constraints, and break the goal into ordered execution steps with dependencies |
| **Execution loop** | A lower-cost model suited to coding | Follow the plan to search and read code, edit files, run commands and checks, and continue based on the results |

Workflow: **User request → Higher-cost model breaks down the task and provides guidance → Lower-cost model executes the steps → Verification and delivery**.

Execution typically involves multiple rounds of tool calls and feedback. Assigning this work to a lower-cost model reduces the unit price of the many tokens consumed during execution. Clear steps also help reduce repeated exploration and unsuccessful attempts. Actual savings depend on task complexity, model capabilities, and provider pricing.

**Configuration:**

1. Add the models you need in **Settings → Models**.
2. Enable **Separate execution-stage configuration** in Settings.
3. Select the **Task decomposition model** and **Execution loop model** separately in the chat bar, and adjust reasoning effort for each stage as needed.

Without separate stage configuration, task decomposition and execution use the same model configuration.

### On-Demand Reads and Context Caching

- **Retrieve code on demand**: Symbol search, file outlines, and partial reads provide relevant code, reducing the tokens needed to include entire files in context.
- **Reuse relevant history**: Retrieve history related to the current task to reduce repeated background input and exploration.
- **Use the model service's context cache**: Cache hits can reduce the cost of repeated input; billing details depend on the provider.

The screenshot below shows one example with approximately 95% cache hits. Actual hit rates vary with the model service, context, and task.

![Context cache hit example](%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE%202026-09-17%20235326.png)

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
cd apps/desktop
pnpm rebuild
cd ../..

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
