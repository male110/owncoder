/**
 * MessageProjector - 从 TurnEvent 流构建结构化消息
 * 
 * 核心功能：
 * 1. 监听 TurnEvent 流，累积事件
 * 2. 构建 MessagePart[] 数组（保持时序）
 * 3. 在 done 事件或 finalize() 时生成完整的结构化消息
 * 
 * 架构：
 * - 每个 turn 创建一个 projector 实例
 * - onEvent 被调用时，立即构建 parts（保持事件顺序）
 * - finalize() 被调用时，封闭未完成的内容
 */

import type { TurnEvent, MessagePart, MessageMetadata } from "./harness/loop/types";

/**
 * MessageProjector - 事件流到结构化消息的投影器
 */
export class MessageProjector {
  private parts: MessagePart[] = [];
  private textChunks: string[] = [];
  private thinkingChunks: string[] = [];
  private pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private metadata: MessageMetadata = {};
  private isFinalized = false;

  /**
   * 处理单个事件（带错误处理和验证）
   * 
   * ⚠️ 并发假设：此方法必须被同步调用，不应包含 await。
   * 如果需要异步处理，应使用事件队列保证顺序。
   */
  handleEvent(ev: TurnEvent): void {
    try {
      switch (ev.type) {
        case "thinking_delta":
          if (typeof ev.text === 'string') {
            this.thinkingChunks.push(ev.text);
          }
          break;

        case "assistant_delta":
          if (typeof ev.text === 'string') {
            // 封闭当前 thinking（如果有）
            this.sealThinking();
            this.textChunks.push(ev.text);
          }
          break;

        case "tool_start":
          // 验证必需字段
          if (!ev.id || !ev.name) {
            console.warn('[MessageProjector] Invalid tool_start event, missing id or name');
            return;
          }
          
          // 封闭当前 thinking 和 text
          this.sealThinking();
          this.sealText();
          
          // 立即添加工具调用 part
          this.parts.push({
            type: "tool_use",
            id: ev.id,
            name: ev.name,
            input: ev.args || {},
          });
          
          // 记录待匹配的工具
          this.pendingTools.set(ev.id, { name: ev.name, input: ev.args || {} });
          break;

        case "tool_end":
          // 检查是否有对应的 tool_start
          if (!this.pendingTools.has(ev.id)) {
            console.warn(`[MessageProjector] tool_end without tool_start: ${ev.id}, adding synthetic tool_use`);
            // 补充一个 tool_use
            this.parts.push({
              type: "tool_use",
              id: ev.id,
              name: ev.name || 'unknown',
              input: {},
            });
          }
          
          // 立即添加工具结果 part
          this.parts.push({
            type: "tool_result",
            tool_use_id: ev.id,
            content: ev.output || '',
            is_error: !ev.ok,
          });
          
          // 移除待匹配记录
          this.pendingTools.delete(ev.id);
          break;


      }
    } catch (error) {
      console.error('[MessageProjector] Error handling event:', ev.type, error);
      // 继续处理其他事件，不中断整个流程
    }
  }

  /**
   * 封闭当前 thinking
   */
  private sealThinking(): void {
    if (this.thinkingChunks.length > 0) {
      const text = this.thinkingChunks.join('');
      if (text.trim()) {
        this.parts.push({
          type: "thinking",
          text,
        });
      }
      this.thinkingChunks = [];
    }
  }

  /**
   * 封闭当前 text
   */
  private sealText(): void {
    if (this.textChunks.length > 0) {
      const text = this.textChunks.join('');
      if (text.trim()) {
        this.parts.push({
          type: "text",
          text,
        });
      }
      this.textChunks = [];
    }
  }

  /**
   * 获取当前构建的 parts
   */
  getParts(): MessagePart[] {
    return [...this.parts];
  }

  /**
   * 获取元数据（深拷贝以保证不可变性）
   */
  getMetadata(): MessageMetadata {
    const copy: MessageMetadata = { ...this.metadata };
    
    // 深拷贝嵌套对象
    if (this.metadata.tokens) {
      copy.tokens = { ...this.metadata.tokens };
    }
    if (this.metadata.importantSnippets) {
      copy.importantSnippets = [...this.metadata.importantSnippets];
    }
    
    return copy;
  }

  /**
   * 设置元数据
   */
  setMetadata(metadata: Partial<MessageMetadata>): void {
    this.metadata = { ...this.metadata, ...metadata };
  }

  /**
   * 完成投影，返回最终结果（幂等性保护）
   * 
   * @param additionalMetadata - 可选的额外元数据（如错误信息、中止状态等）
   */
  finalize(additionalMetadata?: Partial<MessageMetadata>): { parts: MessagePart[]; metadata: MessageMetadata } {
    // 幂等性保护：如果已经 finalize，直接返回缓存结果
    if (this.isFinalized) {
      console.warn('[MessageProjector] finalize() called twice, returning cached result');
      return {
        parts: this.getParts(),
        metadata: this.getMetadata(),
      };
    }
    
    // 封闭所有未完成的内容（原 done 事件的职责）
    this.sealThinking();
    this.sealText();
    
    // 处理未完成的工具调用（只执行一次）
    if (this.pendingTools.size > 0) {
      console.warn(`[MessageProjector] ${this.pendingTools.size} tools never completed, adding error results`);
      for (const [id] of this.pendingTools.entries()) {
        // 添加一个标记为未完成的 tool_result
        this.parts.push({
          type: "tool_result",
          tool_use_id: id,
          content: "(工具调用未完成或超时)",
          is_error: true,
        });
      }
      this.pendingTools.clear();
    }

    // 添加时间戳（只执行一次）
    if (!this.metadata.timestamp) {
      this.metadata.timestamp = new Date().toISOString();
    }

    // ✅ 合并额外的 metadata（如错误信息、中止状态等）
    if (additionalMetadata) {
      this.metadata = { ...this.metadata, ...additionalMetadata };
    }

    // 标记已完成
    this.isFinalized = true;

    return {
      parts: this.getParts(),
      metadata: this.getMetadata(),
    };
  }

  /**
   * 从 parts 生成纯文本 content（向后兼容）
   */
  static partsToContent(parts: MessagePart[]): string {
    const segments: string[] = [];

    for (const part of parts) {
      switch (part.type) {
        case "text":
          segments.push(part.text);
          break;

        case "thinking":
          // 思考内容用特殊标记包裹
          segments.push(`<thinking>\n${part.text}\n</thinking>`);
          break;

        case "tool_use":
          segments.push(
            `<tool_use>\n` +
            `Tool: ${part.name}\n` +
            `Arguments: ${JSON.stringify(part.input, null, 2)}\n` +
            `</tool_use>`
          );
          break;

        case "tool_result":
          const status = part.is_error ? "ERROR" : "SUCCESS";
          segments.push(
            `<tool_result status="${status}">\n${part.content}\n</tool_result>`
          );
          break;
      }
    }

    return segments.join("\n\n");
  }

  /**
   * 从纯文本 content 解析 parts（旧数据迁移）
   */
  static contentToParts(content: string): MessagePart[] {
    const parts: MessagePart[] = [];

    // 简单的启发式解析
    // 1. 提取 <thinking> 块
    const thinkingRegex = /<thinking>\s*([\s\S]*?)\s*<\/thinking>/g;
    let match;
    let lastIndex = 0;

    while ((match = thinkingRegex.exec(content)) !== null) {
      // 添加之前的文本
      const before = content.slice(lastIndex, match.index).trim();
      if (before) {
        parts.push({ type: "text", text: before });
      }

      // 添加 thinking
      parts.push({ type: "thinking", text: match[1]!.trim() });
      lastIndex = match.index + match[0].length;
    }

    // 添加剩余文本
    const remaining = content.slice(lastIndex).trim();
    if (remaining) {
      parts.push({ type: "text", text: remaining });
    }

    // 如果没有找到任何结构，返回单个 text part
    if (parts.length === 0 && content.trim()) {
      parts.push({ type: "text", text: content.trim() });
    }

    return parts;
  }

  /**
   * 检查 content 是否看起来是结构化的（包含标记）
   */
  static isStructured(content: string): boolean {
    return (
      content.includes("<thinking>") ||
      content.includes("<tool_use>") ||
      content.includes("<tool_result>")
    );
  }
}

/**
 * 为 SessionOrchestrator 创建一个 projector 并绑定到 onEvent
 */
export function createProjector(): {
  projector: MessageProjector;
  onEvent: (ev: TurnEvent) => void;
} {
  const projector = new MessageProjector();
  
  return {
    projector,
    onEvent: (ev: TurnEvent) => projector.handleEvent(ev),
  };
}
