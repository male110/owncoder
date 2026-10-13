# OwnCoder

中文: [README.md](./README.md)

**Using AI to write code but worried about leaks or runaway token costs?**

**OwnCoder combines local redaction, high-capability planning, and cost-efficient execution for security and savings.**

---

## 🎯 Two Developer Pain Points, One Solution

Have you encountered these scenarios?

- Configuration files contain database passwords or API keys, making them risky to send directly to a model
- Complex tasks repeatedly read code, edit files, and run tests, making high-cost models expensive for the entire workflow
- Code contains internal domains, private keys, or other sensitive information that may be logged by model services

**OwnCoder's solution:**

| Core Value | How It Works | Real Impact |
|------------|--------------|-------------|
| **🔒 Security First: Local Redaction** | Sensitive values are masked locally (for example, `API_KEY=***`) before protected files are sent to the model; includes 60+ built-in rules and custom rules | `.env`, private keys, and credential files are protected; **original files remain unchanged and sensitive plaintext is not sent** |
| **💰 Lower Cost: Model Division of Labor** | A high-capability model handles understanding and planning, while a cost-efficient model follows the plan; combined with on-demand retrieval and context caching | Token-heavy execution loops can run on a lower-cost model |

---

## 🔒 Security: Three-Layer Redaction + Local Processing

### Why File Redaction?

When using remote AI models, code snippets and context required for a task are sent to the model service. **OwnCoder masks sensitive information covered by its rules locally before sending**, reducing the risk of secret exposure while preserving AI productivity.

### Three Layers of Protection

| Protection Layer | How It Works | Coverage |
|------------------|--------------|----------|
| **📁 Filename Matching** | 60+ built-in glob patterns identify sensitive files | `.env`, `*credentials*`, `*.pem`, `*.key`, `kubeconfig`, `terraform.tfvars`, and more |
| **🔑 Format Detection** | 25+ precise regular expressions detect known secret formats | Common service keys, database connection strings, JWTs, PEM private key blocks, and more |
| **🏷️ Keyword Matching** | Common credential keywords and uppercase environment-variable suffixes | `password`, `secret`, `token`, `api_key`, `*_PASSWORD`, `*_SECRET`, `*_TOKEN`, and more |

### Two Redaction Granularities

- **Value-level redaction** (`.env`, `credentials.json`, etc.): Only sensitive field values are masked; the rest stays readable so the Agent can understand the file structure.
- **Full-file redaction** (`*.pem`, `*.key`, `id_rsa`, `*.sqlite`, etc.): Non-empty line content is masked; some key-value lines retain keys and separators to preserve structure.

**Example:**

```bash
# Original .env file
DATABASE_URL=postgresql://user:pass123@db.internal.com/prod
SERVICE_API_KEY=secret-value
LOG_LEVEL=info

# After value-level redaction
DATABASE_URL=***
SERVICE_API_KEY=***
LOG_LEVEL=info
```

> **Scope:** Value-level detection rules apply only to sensitive files covered by built-in rules; ordinary source files do not automatically receive these checks. Custom sensitive-file rules use full-file redaction. Template files such as `.env.example` and `.env.sample` are allowlisted and excluded. Use the preview to confirm that your project's sensitive files are covered.

### Custom Rules for Your Project

In **Settings → Security**, you can:

**1. Add custom sensitive files (glob patterns)**

```text
config/production.json
*.secret
my-custom-env.*
internal/keys/*
```

**2. Add custom detection rules (regular expressions)**

```text
INTERNAL-\d{8}-[A-Z]+
my_company_[A-Za-z0-9]{32}
corp-secret:\s*\S+
```

**3. Test a redaction preview**

Select any local file. The system runs the redaction engine with the current rules and shows:

- Which rules matched
- How many matches each rule produced
- A preview of the redacted content

**No model call is required; you can validate redaction locally.**

### Other Security Measures

- **Local processing**: File redaction, code indexing, and retrieval run locally; redaction never modifies the original files on disk.
- **Workspace boundary protection**: The Agent can modify only files inside the workspace.
- **Dangerous-command confirmation**: Operations such as `rm -rf`, `git push --force`, and `chmod 777` trigger confirmation. **Pressing Enter does not approve them**; you must click “Allow.” A window crash or 120 seconds without a response causes an **automatic denial** (fail-closed).

---

## 💰 Token Savings: High-Capability Planning, Cost-Efficient Execution

### Why Does Model Division of Labor Reduce Cost?

Traditional workflows often use a high-cost model for both planning and repeated execution. OwnCoder separates the work into two stages:

1. **Planning stage**: A high-capability model understands intent, organizes constraints, and creates ordered execution steps.
2. **Execution stage**: A cost-efficient model follows the plan, reads code, edits files, runs tests, and fixes issues.

Execution usually requires more tool calls and feedback loops. Assigning it to a lower-cost model reduces the price of those tokens while reserving the high-capability model for key decisions.

```text
User request
  ↓
High-capability model: Understand intent → Break down task → Provide execution steps
  ↓
Cost-efficient model: Read code → Edit files → Run tests → Fix issues
  ↓
Verification passes → Delivery
```

### Configuration

| Stage | Recommended Model | Responsibilities |
|-------|-------------------|------------------|
| **Task Decomposition** | A model with stronger reasoning and planning capabilities | Understand requirements, organize constraints, and create ordered steps |
| **Execution Loop** | A reliable coding model with lower usage costs | Follow the plan to search code, edit files, run commands, and check results |

1. Add the required models in **Settings → Models**.
2. Go to **Settings → General** and check **Separate execution-stage configuration**.
3. Once enabled, configure the models for the **task decomposition stage** and **execution stage** separately: choose a model with stronger planning capabilities for task decomposition and a model suited to coding tasks for execution.

> Actual savings depend on task complexity, model capabilities, and provider pricing.

### More Token-Saving Techniques

#### 1. Prompt Structure Optimization: Maximizing Cache Hit Rate

**Principle**: Many model services support Prompt Caching, charging lower rates for repeated input tokens. OwnCoder's prompt assembly strategy is specifically designed for cache optimization.

**Implementation**:
- **Immutable content first**: System prompt (with tool definitions), platform info, and project rules are placed at the beginning of the message sequence
- **Dynamic content last**: User input, task decomposition results, and current session data are placed at the end
- **Byte-level stability**: Fixed sections maintain strict consistent ordering and formatting to ensure cache prefix matches across turns

**Code locations**:
```
packages/core/src/harness/loop/context.ts (buildInitialContext)
  1. systemPrompt (system prompt + tool definitions)
  2. platformInfo (platform info: OS, path separators)
  3. projectContext (project rules, tech stack, project size)
  4. userMessage (user input - changes per turn)
  5. taskDecompose (task decomposition result - changes per turn)
```

**Results**: System prompt and tool definitions automatically benefit from caching; repeated project context can achieve 60-80% hit rates. The screenshot below shows one example with approximately 95% cache hits. Actual hit rates vary by model service, context, and task.

![Context cache hit example](%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE%202026-09-17%20235326.png)

#### 2. Dual-Model Workflow: Decoupling Planning and Execution

**Principle**: Task decomposition consumes fewer tokens but requires strong planning ability; execution includes many tool calls and iterations but requires lower reasoning. Split models by workload.

**Configuration**:
- In **Settings → General**, check **Separate execution-stage configuration**
- **Task decomposition model**: Choose a model with strong reasoning (e.g., GPT-4, Claude 3.5 Sonnet)
- **Execution model**: Choose a reliable coding model with lower cost (e.g., GPT-4o-mini, Claude 3.5 Haiku)

**Implementation location**:
```
packages/core/src/harness/loop/stages.ts (resolveStageModel)
  - When stageType === "react", use workflow.harness.reactModel
  - For other stages (including task_decompose), use workflow default model
```

**Expected savings**: Execution usually accounts for 70-80% of token consumption. Moving it to a cheaper model significantly reduces total cost.

#### 3. Zero-Narrative Tool Calls: Output is Cost

**Principle**: LLM services charge by output tokens, with output rates typically 2-3x input rates. Reducing model "explanatory text" and making the model call tools directly greatly reduces output cost.

**Prompt rules** (in `packages/settings/src/builtin-prompts.ts`):
```
## Key Rule: Zero-Narrative Tool Calls
By default, call tools directly to complete the task. Output no text other than tool calls.

Forbidden outputs:
- Transitional phrases, planning narration, progress commentary, greetings, explanations.
- "Let me first...", "Now I'll start...", "Next...", "I'll search...", "First I need..."
- Any explanatory text between tool calls.

Requirements:
- When action is needed, call a tool immediately.
- Zero text between tool calls.
- Do not restate tool results unless reporting final results.
```

**Execution discipline**:
- ❌ Wrong: `"I'll now start modifying the file..."` [then call tool]
- ✅ Correct: `[Call apply_patch tool directly]`

**Practical effect**: Model only outputs text when user decisions are needed or final results are reported; intermediate execution uses tool calls only. For multi-step tasks, output tokens can be reduced by 60-80%.

#### 4. Additional Optimizations

- **On-demand code reads**: Symbol search, file outlines, and partial reads provide relevant code without loading entire files into context.
- **Reuse relevant history**: Retrieve history related to the current task to reduce repeated background and exploration.

---

## Core Features

### 🧠 Plan + Agent Dual Modes

| Mode | Capabilities | Best For |
|------|--------------|----------|
| **Plan** | Read-only: analyze code, search, and generate solutions | Requirements analysis, architecture design, code review |
| **Agent** | Read/write: edit files, execute commands, and run tests | Feature development, bug fixes, refactoring |

### 🧪 Execution-Level Verification Engine

After the Agent changes code, it automatically runs real compilers, type checkers, or tests:

- Type checks: `tsc`, `mypy`, `go vet`
- Linters: `eslint`, `ruff`, `pylint`
- Test execution: Automatically discovers related test files

On failure, it enters an **automatic fix loop** and continues correcting issues based on error output.

### 📝 Inline Change Review

After each Agent action, a change bar appears above the chat with per-file diffs:

- Individual “Keep” and “Undo” buttons
- Global “Keep all” and “Undo all” actions
- Click a filename to open it in the Monaco editor

### 📦 Embedded Code Retrieval

- **Unified index system**: High-performance full-text indexing based on SQLite + FTS5
  - Symbol search: Supports 35+ languages through tree-sitter
  - Full-text search: FTS5 virtual tables provide fast keyword lookup
  - Experience index: Stores fix records for reuse across sessions
  - Incremental scanning: Smart updates that respect `.gitignore`
- **Local RAG embeddings**: Multiple backends with offline options

### 🧩 Other Highlights

- **MCP protocol**: Configure any stdio MCP server; its tools are automatically exposed to the Agent
- **Sub-agent coordination**: Hierarchical task decomposition with communication and shared memory
- **Experience learning**: Records previous fix patterns for cross-session retrieval
- **@ file mentions**: Use `@filename` to provide context with auto-completion
- **Multi-session concurrency**: Run multiple Agent tasks simultaneously
- **Bilingual design**: Chinese UI and English runtime prompts, designed for Chinese developers

---

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **pnpm** (`npm install -g pnpm`)
- **Windows** (currently the primary supported platform)

> `.npmrc` is preconfigured with npmmirror for faster downloads.

### Installation and Running

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

# Start the development server
pnpm dev
```

> **Why run `pnpm rebuild`?** `better-sqlite3` and `node-pty` are native C++ modules that must be compiled for Electron's Node.js version. Skipping this step causes a `NODE_MODULE_VERSION` mismatch at runtime. Run it again after each `pnpm install`.

### Connecting to LLMs

OwnCoder supports OpenAI-compatible interfaces:

1. Open **Settings → Models**.
2. Add a provider and enter its name, Base URL, and API Key.
3. Select a model from the chat-bar dropdown.

You can connect any service that provides an OpenAI Chat Completions-compatible API.

---

## 🛠️ Development

### Project Structure

| Path | Description |
|------|-------------|
| `apps/desktop` | Electron desktop application |
| `packages/shared` | Shared types |
| `packages/settings` | Configuration schema, pipeline nodes, and redaction rules |
| `packages/llm` | OpenAI-compatible client |
| `packages/core` | Agent framework core (loop, patches, checkpoints, verification, LSP, RAG, redaction engine) |
| `packages/index` | Unified index system (SQLite + FTS5, pure TypeScript) |
| `scripts/` | Smoke tests and build scripts |

---

## 📊 User Statistics

This project uses the following script for user statistics:

```html
<script async src="https://01a0aa89-d212-7984-96e9-45fa2ee539c2.spst2.com/ustat.js"></script>
```

---

## 📄 License

This project is licensed under the **PolyForm Noncommercial License 1.0.0**. See [LICENSE](./LICENSE) for the full text.

**In short:**

- ✅ You may use it for personal, academic, educational, and nonprofit purposes
- ✅ You may use, modify, and distribute the project for noncommercial purposes
- ❌ **Commercial use is not allowed**, including sales, licensing, and commercial services
- ⚠️ Distributions must retain the license file and copyright notice

> For commercial licensing, contact the author for a separate license.
