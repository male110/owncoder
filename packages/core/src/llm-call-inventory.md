# LLM 调用点与消息构造位置完整清单

> 汇总范围：`packages/core/src/**/*.ts`（206 个 TS 文件，含测试）
> 生成方式：glob 全量文件列表 + grep 多模式检索 + 逐文件 read_file 确认
> 生成日期：2026-05-30

---

## 一、LLM API 调用（chatCompletionStream / chatCompletion / completions.create）

### 1. `harness/loop/react-llm-call.ts`
| 行号 | 用途 |
|------|------|
| L9 | `import { chatCompletionStream, ... } from "@owncoder/llm"` |
| L64 | `chatCompletionStream(ctx.model, messagesForCall, { ... })` — 核心 LLM 调用，含重试、空响应兜底、token 用量记录 |

### 2. `harness/loop/react-extract.ts`（已删除：工具结果提取功能整体移除，2026-11-01）
| 行号 | 用途 |
|------|------|
| ~~L13~~ | ~~`import { chatCompletionStream, ... }`~~ |
| ~~L140~~ | ~~`chatCompletionStream(model, makeRequest(...), { ... })` — 分批提取工具结果~~ |

### 3. `harness/loop/react-forced-report.ts`
| 行号 | 用途 |
|------|------|
| L10 | `import { chatCompletionStream, ... }` |
| L48 | `chatCompletionStream(ctx.model, callMessages, { tools: [], ... })` — 预算耗尽时强制终态报告 |

### 4. `harness/loop/react-verify.ts`
| 行号 | 用途 |
|------|------|
| L8 | `import { assertLlmAuth, chatCompletionStream, ... }` |
| L40 | `chatCompletionStream(verifyModel, verifyMessages, { ... })` — 验证报告调用 |

### 5. `harness/loop/stage-handlers/index.ts`
| 行号 | 用途 |
|------|------|
| L16 | `import { chatCompletionStream, ... }` |
| L198 | `chatCompletionStream(model, messages, { ... })` — doPlainCompletion，无工具循环的普通 LLM 完成 |

### 6. `harness/loop/stage-handlers/task-decompose.ts`
| 行号 | 用途 |
|------|------|
| L16 | `import { chatCompletion, ... }` |
| L161 | `chatCompletion(model, decomposeMessages, { ... })` — 非流式任务分解调用 |

### 7. `harness/loop/stage-handlers/decompose-context.ts`
| 行号 | 用途 |
|------|------|
| L12 | `import { chatCompletion, ... }` |
| L194 | `chatCompletion(model, [{ role: "system", ... }, { role: "user", ... }], { ... })` — 历史压缩摘要调用 |

---

## 二、System 消息注入（role: "system" 消息构造）

### 1. `harness/loop.ts`
| 行号 | 用途 |
|------|------|
| L224 | `{ role: "system", content: tagSystemInstructions(systemPrompt) }` — 主系统消息 |
| L228–229 | `{ role: "system", content: localeSystemPrompt(...) }` — 语言环境系统消息 |

### 2. `harness/loop/react-llm-call.ts`
| 行号 | 用途 |
|------|------|
| L47 | `{ role: "system", content: tagCurrentTask(formatCurrentTaskContext(ctx.currentTask)) }` — 当前任务 system 消息 |
| ~~L49~~ | ~~`{ role: "system", content: tagCurrentTask(formatTurnInformationContext(informationTask)) }`~~ — 已删除（死代码分支，2026-11-01） |

### 3. `harness/loop/react-extract.ts`（已删除：工具结果提取功能整体移除，2026-11-01）
| 行号 | 用途 |
|------|------|
| ~~L119~~ | ~~`{ role: "system", content: SUMMARY_PROMPT }` — 工具结果提取的系统提示~~ |
| ~~L150~~ | ~~`{ role: "system", content: 'Excerpt of earlier tool results:\n${summary}' }` — 提取摘要替换消息~~ |

### 4. `harness/loop/react-verify.ts`
| 行号 | 用途 |
|------|------|
| L34 | `{ role: "system", content: '## Verify stage\n${verifyPrompt}' }` — 验证阶段系统消息 |

### 5. `harness/loop/stage-handlers/task-decompose.ts`
| 行号 | 用途 |
|------|------|
| L140 | `{ role: "system", content: systemPrompt }` — 分解提示词系统消息 |
| ~~L141~~ | ~~`{ role: "system", content: localePrompt }`~~ — 已删除：`localeJsonValuesPrompt` 已移除（2026-11-01），分解阶段不再注入语言指令 |
| L290 | `messages.push({ role: "system", content: decomposeBlock })` — 分解结果注入 |

### 6. `harness/loop/stage-handlers/decompose-context.ts`
| 行号 | 用途 |
|------|------|
| L195 | `{ role: "system", content: instruction }` — 历史压缩指令系统消息 |

### 8. `harness/loop/stage-handlers/verify.ts`
| 行号 | 用途 |
|------|------|
| L130 | `{ role: "system", content: '## 📋 Final Verification Report\n...' }` — 验证失败报告系统消息 |

### 9. `harness/loop/react-text-branch.ts`
| 行号 | 用途 |
|------|------|
| L122 | `{ role: "system", content: 'You just executed a tool...' }` — 工具执行后 nudge 消息 |

### 10. `harness/loop/react-tool-exec.ts`
| 行号 | 用途 |
|------|------|
| L306 | `{ role: "system", content: '...transition to implementation now...' }` — 只读探索转实现 nudge |
| L417 | `{ role: "system", content: 'Verified information evidence satisfies...' }` — 探索跳过 nudge |

### 11. `harness/loop/context.ts`
| 行号 | 用途 |
|------|------|
| L141 | `messages.push({ role: "system", content: wrappedContent })` — 平台信息注入 |
| L513 | `messages.push({ role: "system", content: wrappedProjectContext })` — 项目上下文注入 |

### 12. `harness/auto-fix.ts`
| 行号 | 用途 |
|------|------|
| L205 | `{ role: "system", content: ... }` — auto-fix 验证系统消息 |
| L245 | `{ role: "system", content: ... }` — auto-fix 修复结果系统消息 |

### 13. `harness/loop/stage-handlers/index.ts`
| 行号 | 用途 |
|------|------|
| L258 | `systemPrompt: messages[0]?.content ?? ""` — 从消息数组提取 system prompt 传给 stage handler |

---

## 三、提示词格式化函数定义与调用

### 1. `harness/loop/react-prompt.ts`
| 行号 | 用途 |
|------|------|
| L61 | `formatCurrentTaskContext(task)` — 构造当前任务的 system 提示内容 |
| ~~L91~~ | ~~`formatTurnInformationContext(task)`~~ — 已删除（死代码：`turnInformationTask` 恒为 null，运行时从不注入；2026-11-01） |

### 2. `harness/loop/react-llm-call.ts`
| 行号 | 用途 |
|------|------|
| L12 | `import { formatCurrentTaskContext, formatTurnInformationContext }` |
| L47 | 调用 `formatCurrentTaskContext(ctx.currentTask)` |
| L49 | 调用 `formatTurnInformationContext(informationTask)` |

---

## 四、平台信息注入

### 1. `harness/loop/context-control.ts`
| 行号 | 用途 |
|------|------|
| L3 | `import { platform } from "node:os"` |
| L56 | `platform() === "win32"` — 运行时 OS 判断 |

### 2. `harness/loop/context.ts`
| 行号 | 用途 |
|------|------|
| L108–147 | `buildPlatformInfo()` 构造平台信息字符串，`pushSystem(buildPlatformInfo(), "platform")` 注入 system 消息 |
| L121 | `pushSystem` 辅助函数，`tag === "platform"` 时调用 `tagPlatformInfo(content)` |
| L134–135 | `tagPlatformInfo` 包装平台信息 |

### 3. `harness/message-tags.ts`
| 行号 | 用途 |
|------|------|
| L70, 72–73 | `tagPlatformInfo` 函数实现 |

### 4. `harness/tools/shared.ts`
| 行号 | 用途 |
|------|------|
| L3 | `import { platform, release } from "node:os"` |
| L14 | `export const PLATFORM = platform()` |
| L16 | `export const IS_WINDOWS = PLATFORM === "win32"` |

### 5. `harness/subagent/run-subagent.ts`
| 行号 | 用途 |
|------|------|
| L81 | `platform: process.platform` — 将 OS 信息传递给子智能体 |

### 6. `harness/subagent/explore-subagent.ts`
| 行号 | 用途 |
|------|------|
| L20 | `platform?: string` — 子智能体环境类型定义 |
| L46 | `env.platform ? \`- Platform: ${env.platform}\`` — 平台信息注入到子智能体提示 |

---

## 五、LLM 厂商相关（OpenAI / Anthropic / Vertex / Gemini）

### 1. `harness/loop/continuation-intent.ts`
| 行号 | 用途 |
|------|------|
| L9 | 正则匹配弱模型名称（gemini-2.5-flash, claude-3-5-haiku, gpt-4o-mini 等） |

### 2. `harness/loop/streaming-snapshot.ts`
| 行号 | 用途 |
|------|------|
| L4 | 注释提及 LLM codec（openai-chat / openai-responses / anthropic / gemini） |

### 3. `harness/loop/termination.ts`
| 行号 | 用途 |
|------|------|
| L85, L270 | 注释提及 OpenAI Agents / Anthropic Computer Use 启发式 |

### 4. `harness/parser.ts`
| 行号 | 用途 |
|------|------|
| L13 | 注释提及 valid OpenAI tool_calls JSON |

### 5. `harness/redact.ts`
| 行号 | 用途 |
|------|------|
| L131–135 | OpenAI API Key（sk-...）和 Anthropic API Key（sk-ant-...）脱敏规则 |

### 6. `mcp/client.ts`
| 行号 | 用途 |
|------|------|
| L267–268 | `mcpToolsToOpenAi()` — MCP 工具转 OpenAI 工具定义 |

### 7. `harness/lsp-npm.ts`
| 行号 | 用途 |
|------|------|
| L61 | `process.platform === "win32"` — Windows 平台 npm 执行判断 |

### 8. `harness/lsp-client.ts`
| 行号 | 用途 |
|------|------|
| L1195, L1216 | `process.platform === "win32"` — Windows 平台 LSP 客户端判断 |

### 9. `harness/tools/read-file.test.ts`
| 行号 | 用途 |
|------|------|
| L168–180 | 测试中模拟 anthropic-messages / openai-chat 两种格式的 LLM 编解码 |

---

## 六、消息类型与接口定义

### 1. `harness/loop/types.ts`
| 行号 | 用途 |
|------|------|
| L245 | `role: "user" | "assistant" | "tool" | "system"` — ChatMessage role 类型 |
| L352 | `availableSkills` — 注入 system prompt 的技能目录 |
| L386 | `memories` — 注入 system prompt 的记忆块 |
| L444 | `systemPromptOverride` — 覆盖 pipeline node 的 system prompt |

### 2. `harness/loop/stage-handlers/types.ts`
| 行号 | 用途 |
|------|------|
| L94 | `messages: ChatMessage[]` — StageHandlerContext 中的消息数组 |

---

## 七、验证方式

1. **文件清单**：通过 `glob('packages/core/src/**/*.ts')` 获取 206 个 TS 文件，与 `list_dir` 逐层探查结果一致
2. **模式检索**：使用 `grep` 工具对以下模式进行 `files_with_matches` / `content` 检索：
   - `chatCompletionStream` / `chatCompletion[^S]` / `completions\.create` / `chat\.completions`
   - `role.*system` / `system.*prompt` / `systemPrompt` / `system_message`
   - `formatCurrentTaskContext` / `formatTurnInformationContext`
   - `decompose.*prompt` / `BUILTIN_TASK_DECOMPOSE_PROMPT`
   - `os.*info` / `platform` / `process\.platform`
   - `anthropic` / `openai` / `vertex` / `gemini` / `claude` / `gpt`
   - `user\.message` / `assistant\.message` / `MessageRole` / `ChatMessage`
3. **逐文件确认**：对每个命中文件使用 `read_file` 验证具体行号和上下文
4. **交叉核对**：t1 的文件清单与 t3 的逐文件确认结果交叉比对，无遗漏

---

## 八、残留风险

- 部分文件命中多个模式（如 `react-llm-call.ts` 同时命中 LLM API 调用、消息构造、提示词格式化、分解提示词四类），属于正常交叉
- 测试文件（`.test.ts`）中可能包含模拟 LLM 调用的桩代码，已按原样纳入清单，未做过滤
- `harness/loop.ts` L571 仅为注释提及 `chatCompletionStream`，非实际调用
- `harness/loop/stage-handlers/verify.ts` L188 仅为注释提及 `chatCompletionStream`，非实际调用
- `harness/loop/stage-handlers/history.ts` L31 仅为注释提及 `systemPrompt`，非实际消息构造
- `harness/loop/stage-handlers/decompose-history.ts` L131 仅为 `turn.role === "system"` 的条件判断，非消息构造
