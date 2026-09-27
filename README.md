# OwnCoder

English: [README_EN.md](./README_EN.md)

**安全优先的 AI 编程工具 — 你的代码，始终属于你。**

---

## 为什么选择 OwnCoder？

在使用 AI 编程工具的时候，你是否担心：
- 数据库账号密码被发到云端？
- API 密钥、SSH 私钥等各种敏感信息被泄露？
- 你的代码被上传到第三方服务器？

**OwnCoder 会在发给大模型之前对这些信息进行脱敏，保护你的安全。**

### 🔒 安全第一

OwnCoder 从**安全**入手，不是事后打补丁：
- ✅ **自动脱敏**：数据库密码、API 密钥、SSH 私钥等敏感信息在发送给大模型前自动替换为 `[REDACTED]`
- ✅ **完全本地**：所有代码分析、索引、检索都在本地完成，不会上传任何代码到云端
- ✅ **零遥测**：不搜集使用数据，不上报崩溃，不埋任何分析点
- ✅ **自主可控**：你的数据只在你的机器上，永远属于你

---

## 🔒 强大的安全防护体系

### 敏感信息自动脱敏

你的 `.env`、数据库连接串、API Key、SSH 私钥……Agent 在把文件内容发送给大模型之前，会**自动检测并替换为 `[REDACTED]`**。敏感信息永远不会离开你的机器。

**三层防护：**

| 层级 | 机制 | 覆盖范围 |
|------|------|----------|
| **文件匹配** | 60+ 内置 glob 模式识别敏感文件 | `.env`、`*credentials*`、`*.pem`、`*.key`、`kubeconfig`、`terraform.tfvars` 等 |
| **格式识别** | 25+ 种已知密钥格式的精确正则 | OpenAI `sk-...`、AWS `AKIA...`、GCP `AIza...`、GitHub `ghp_...`、数据库连接串、JWT、PEM 私钥块 |
| **关键词匹配** | 通用凭证关键词 + 大写环境变量后缀 | `password`、`secret`、`token`、`api_key`、`*_PASSWORD`、`*_SECRET`、`*_TOKEN` 等 |

**两种脱敏粒度：**

- **值级脱敏**（`.env`、`credentials.json` 等）：仅掩码敏感字段的值，其余配置内容保持可读，Agent 仍能理解文件结构。
- **全文件脱敏**（`*.pem`、`*.key`、`id_rsa`、`*.sqlite` 等）：所有非空行全部掩码，Agent 只能知道"这是一个敏感文件"。

> 允许列表：`.env.example`、`.env.sample` 等模板文件由白名单保护，不会被误脱敏。

---

### 自定义脱敏规则

每个人的项目不同，敏感信息的形态也不同。在 **设置 → 安全** 中，你可以：

**1. 添加自定义敏感文件（glob 模式）**

逐行输入 glob 模式，匹配的文件将被**全文件脱敏**：

```
config/production.json
*.secret
my-custom-env.*
internal/keys/*
```

**2. 添加自定义检测规则（正则表达式）**

逐行输入正则表达式，匹配的内容将在值级脱敏文件中被掩码：

```
INTERNAL-\d{8}-[A-Z]+
my_company_[A-Za-z0-9]{32}
corp-secret:\s*\S+
```

规则会自动编译并追加到内置检测器之后，无效正则会被静默跳过。

**3. 脱敏预览测试**

点击"选择文件测试"，选择任意本地文件 —— 系统会用当前规则对它运行一遍脱敏引擎，展示：
- 匹配了哪些规则
- 每种规则命中了几处
- 脱敏后的内容预览

不用实际调用 LLM 即可验证脱敏效果。

---

### 三层写入保护

防止 Agent 意外修改不该动的文件：

| 策略 | 保护范围 |
|------|----------|
| **balanced**（推荐） | 阻止写入 `.git/`、`node_modules/`、`dist/`、`build/`、锁文件、`.owncoder/` 内部目录 |
| **strict** | 上述全部 + 仅允许编辑约 70 种代码扩展名（`.ts`、`.py`、`.rs` 等）和白名单文件名 |
| **loose** | 仅阻止始终禁止的路径 |

所有策略都带**路径逃逸检测** —— 即使用 `../` 尝试越狱，也会被拦截。

---

### 危险命令二次确认

Agent 执行 `rm -rf`、`git push --force`、`chmod 777` 等危险操作时，会弹出确认栏：
- 显示完整命令内容，一目了然
- **Enter 键不会通过** —— 必须手动点击"允许"
- Esc 或点击"拒绝"即撤销
- 窗口崩溃或 120 秒无响应 → **自动拒绝**（fail-closed）


---

## 缓存命中率高

我的钱肯定不是大风刮来的，token能省则省，缓存命中率高达95%。有图有真像：

![输入图片说明](%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE%202026-09-17%20235326.png)


---

## 核心功能

### 🧠 Plan + Agent 双模式

| 模式 | 能力 | 适用场景 |
|------|------|----------|
| **Plan** | 只读：分析代码、搜索、生成方案 | 需求分析、架构设计、代码审查 |
| **Agent** | 读写：编辑文件、执行命令、运行测试 | 功能开发、Bug 修复、重构 |



### 🧪 执行级验证引擎

Agent 改完代码后，自动运行真实的编译器/类型检查器/测试来验证：
- 类型检查：`tsc`、`mypy`、`go vet`
- 代码检查：`eslint`、`ruff`、`pylint`
- 测试运行：自动发现关联测试文件

验证失败时进入**自动修复循环**，根据编译错误自行修正。

### 📝 内联变更审查

每次 Agent 操作后，对话上方展示变更栏，逐文件 diff 对比：
- 独立"保留"/"撤销"按钮
- "全部保留"/"全部撤销"全局操作
- 点击文件名在 Monaco 编辑器中打开


### 📦 嵌入式代码检索

- **统一索引系统**：基于 SQLite + FTS5 的高性能全文索引
  - 符号搜索：支持 35+ 种语言（通过 tree-sitter）
  - 全文检索：FTS5 虚拟表提供快速关键词搜索
  - 经验索引：存储故障修复记录，跨会话复用
  - 增量扫描：智能更新，遵循 `.gitignore`
- **本地 RAG 嵌入**：三种后端（FastLocalEmbedding / NeuralEmbedding / ApiEmbedding），可离线使用

### 🧩 其他亮点

- **MCP 协议**：配置任意 stdio MCP 服务器，工具自动暴露给 Agent
- **子 Agent 协调**：层级任务分解，子 Agent 间通信共享记忆
- **经验学习**：Agent 记住过往修复模式，跨会话检索
- **@ 文件提及**：`@文件名` 提供上下文，支持自动补全
- **多会话并发**：同时运行多个 Agent 任务
- **双语设计**：中文界面 + 英文运行时提示词，面向中文开发者

---

## 快速开始

### 前置要求

- **Node.js** >= 20
- **pnpm**（`npm install -g pnpm`）
- **Windows**（当前主要支持平台）

> `.npmrc` 已配置 npmmirror 镜像加速下载。

### 安装与运行

```bash
git clone https://github.com/YOUR_ORG/owncoder.git
cd owncoder
pnpm install

# 为 Electron 重建原生模块（better-sqlite3、node-pty）
cd apps/desktop
pnpm rebuild
cd ../..

# 构建所有 TypeScript 包
pnpm -r run build

# 启动开发服务器
pnpm dev
```

> **为什么要 `pnpm rebuild`？** `better-sqlite3` 和 `node-pty` 是 C++ 原生模块，需要为 Electron 的 Node.js 版本编译。如果跳过此步，运行时会报 `NODE_MODULE_VERSION` 不匹配的错误。每次 `pnpm install` 后都需要重新执行。

---


### 连接大模型

OwnCoder 支持任意 OpenAI 兼容接口：

1. 打开 **设置 → Models**
2. 添加提供商：填写名称、Base URL、API Key
3. 在对话栏下拉菜单中选择你的模型

兼容 OpenAI、DeepSeek、通义千问、智谱、Moonshot 等所有 OpenAI Chat Completions API 服务。


---

## 开发

### 项目结构

| 路径 | 说明 |
|------|------|
| `apps/desktop` | Electron 桌面端 |
| `packages/shared` | 共享类型 |
| `packages/settings` | 配置 schema、流水线节点、脱敏规则 |
| `packages/llm` | OpenAI 兼容客户端 |
| `packages/core` | Agent 框架核心（循环、补丁、检查点、验证、LSP、RAG、脱敏引擎） |
| `packages/index` | 统一索引系统（SQLite + FTS5，纯TypeScript实现） |
| `scripts/` | 冒烟测试、构建脚本 |

---

## 用户统计

项目使用以下脚本进行用户统计：

```html
<script async src="https://01a0aa89-d212-7984-96e9-45fa2ee539c2.spst2.com/ustat.js"></script>
```

---

## 许可协议

本项目采用 **PolyForm Noncommercial License 1.0.0** 许可。完整协议文本见 [LICENSE](./LICENSE) 文件。

**简单来说：**
- ✅ 你可以用于个人、学术、教育和非营利目的
- ✅ 你可以自由使用、修改、分发本项目（限非商业用途）
- ❌ **不允许商业使用**（包括但不限于销售、授权、商业服务等）
- ⚠️ 分发时须保留许可证文件和版权声明

> 如需商业使用授权，请联系作者获取单独的商业许可。
# LSP 自动发现与安装

LSP 不再只依赖系统预装的少数几个命令。核心会扫描当前项目中的文件类型，从内置的主流语言服务器目录中选择可用实现；当项目使用的语言服务器缺失且存在 npm 安装方式时，会自动安装到项目的 `.owncoder/lsp` 目录，不污染全局环境。

- 中国大陆环境默认使用 `https://registry.npmmirror.com`；其他环境使用 npm 官方源。
- 可用 `OWNCODER_NPM_REGISTRY` 指定镜像源。
- 可用 `OWNCODER_DISABLE_LSP_AUTO_INSTALL=1` 关闭自动安装。
- 默认会预下载目录中所有可通过 npm 安装的 LSP；已存在于项目 `node_modules/.bin` 或系统 PATH 的服务器优先使用。
- 如果只希望下载当前项目实际使用的语言服务器，可设置 `OWNCODER_LSP_INSTALL_PROJECT_ONLY=1`。
