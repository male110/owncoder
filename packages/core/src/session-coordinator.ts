/**
 * SessionRunCoordinator
 * 
 * 会话执行协调器 - 确保每个会话最多有一个活跃的 drain loop。
 * 
 * 核心原则（参考 OpenCode 架构）：
 * 1. 一个会话 → 最多一个活跃执行
 * 2. 不同会话可以并发运行
 * 3. 新输入在会话忙碌时入队，当前执行完成后自动继续
 * 4. 中断清除队列并停止当前执行
 * 
 * 设计参考：
 * - OpenCode SessionRunCoordinator (V2/core)
 * - VS Code Agent Host execution model
 */

export interface SessionInput<TContext = any> {
  id: string;
  text: string;
  timestamp: number;
  admitted: boolean; // 是否已被协调器接受
  context?: TContext; // 额外的上下文（如 onEvent 回调等）
  // Promise 回调（内部使用，由 admit() 设置）
  _resolve?: (value: any) => void;
  _reject?: (reason?: any) => void;
}

interface ExecutionEntry<TContext = any> {
  sessionId: string;
  active: boolean; // 是否有活跃的 drain loop
  pendingWake: boolean; // 执行完成后是否需要再次唤醒
  fiber: Promise<any> | null; // 当前执行的 Promise
  abortController: AbortController | null;
  pendingInputs: SessionInput<TContext>[]; // 待处理的输入队列
  lastActivity: number;
  currentContext?: TContext; // 当前执行的上下文
  disposed: boolean;
}

type DrainHandler<T, TContext = any> = (
  sessionId: string, 
  input: SessionInput<TContext>
) => Promise<T>;
type ContinuationCheck<TContext = any> = (
  sessionId: string, 
  lastResult: any,
  context?: TContext
) => Promise<boolean>;

export interface CoordinatorStats {
  totalSessions: number;
  activeSessions: number;
  totalPendingInputs: number;
  sessions: Array<{
    sessionId: string;
    active: boolean;
    pendingInputs: number;
    lastActivity: number;
  }>;
}

/**
 * 会话执行协调器
 * 
 * 使用方式：
 * ```typescript
 * const coordinator = new SessionRunCoordinator(
 *   async (sessionId, input) => {
 *     // 执行一轮代理循环，可以访问 input.context
 *     const { onEvent } = input.context || {};
 *     return await runAgentLoop(...);
 *   },
 *   async (sessionId, lastResult, context) => {
 *     // 检查是否需要继续（例如工具调用）
 *     return lastResult.needsContinuation;
 *   }
 * );
 * 
 * // 提交输入（带上下文）
 * const result = await coordinator.admit(sessionId, text, { onEvent, ...other });
 * 
 * // 中断会话
 * await coordinator.interrupt(sessionId);
 * ```
 */
export class SessionRunCoordinator<T = any, TContext = any> {
  private entries = new Map<string, ExecutionEntry<TContext>>();
  private drainHandler: DrainHandler<T, TContext>;
  private continuationCheck: ContinuationCheck<TContext>;
  private readonly maxPendingInputs: number;

  constructor(
    drainHandler: DrainHandler<T, TContext>, 
    continuationCheck: ContinuationCheck<TContext>,
    options?: { maxPendingInputs?: number },
  ) {
    this.drainHandler = drainHandler;
    this.continuationCheck = continuationCheck;
    this.maxPendingInputs = options?.maxPendingInputs ?? 32;
  }

  /**
   * 接纳输入并唤醒执行
   * 
   * 如果会话空闲，立即开始执行；如果会话忙碌，输入入队等待。
   * 这是 OpenCode "prompt admission" 模式的完整实现。
   */
  async admit(sessionId: string, text: string, context?: TContext): Promise<T> {
    const entry = this.getOrCreate(sessionId);
    if (entry.disposed) {
      throw new Error(`Session ${sessionId} is disposed`);
    }
    if (entry.pendingInputs.length >= this.maxPendingInputs) {
      throw new Error(`Session ${sessionId} input queue is full`);
    }
    
    const input: SessionInput<TContext> = {
      id: `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      text,
      timestamp: Date.now(),
      admitted: false,
      context,
    };

    console.log(`[SessionCoordinator] admit:`, {
      sessionId,
      textLength: text.length,
      hasContext: !!context,
      active: entry.active,
      queueLength: entry.pendingInputs.length,
    });

    // 标记为已接纳并加入队列
    input.admitted = true;
    entry.pendingInputs.push(input);

    // 返回一个 Promise，在 drain loop 完成时 resolve
    return new Promise<T>((resolve, reject) => {
      // 将 resolve/reject 附加到 input 上，以便 drain loop 可以通知完成
      input._resolve = resolve;
      input._reject = reject;
      
      // 唤醒执行（如果已经在运行，wake 会设置 pendingWake 标志）
      // 如果 wake 失败，拒绝 Promise
      this.wake(sessionId).catch((error) => {
        console.error(`[SessionCoordinator] wake failed for session ${sessionId}:`, error);
        // 从队列中移除这个输入
        const index = entry.pendingInputs.indexOf(input);
        if (index > -1) {
          entry.pendingInputs.splice(index, 1);
        }
        reject(error);
      });
    });
  }

  /**
   * 唤醒会话执行
   * 
   * 如果会话已经在运行，设置 pendingWake；否则启动 drain loop。
   */
  async wake(sessionId: string): Promise<void> {
    const entry = this.getOrCreate(sessionId);
    if (entry.disposed) return;
    console.log(`[SessionCoordinator] wake:`, {
      sessionId,
      active: entry.active,
      pendingWake: entry.pendingWake,
      pendingInputs: entry.pendingInputs.length,
    });

    // 如果已经有活跃执行，标记 pendingWake
    if (entry.active) {
      entry.pendingWake = true;
      console.log(`[SessionCoordinator] Session ${sessionId} already active, marking pendingWake`);
      return;
    }

    // 如果没有待处理输入，不启动
    if (entry.pendingInputs.length === 0) {
      console.log(`[SessionCoordinator] No pending inputs for session ${sessionId}`);
      return;
    }

    // 开始新的 drain loop
    entry.active = true;
    entry.abortController = new AbortController();
    entry.fiber = this.drain(sessionId);

    try {
      await entry.fiber;
    } finally {
      entry.active = false;
      entry.fiber = null;
      entry.abortController = null;

      // 如果有待处理的唤醒，递归执行
      if (entry.pendingWake) {
        entry.pendingWake = false;
        console.log(`[SessionCoordinator] Processing pendingWake for session ${sessionId}`);
        await this.wake(sessionId);
      }
    }
  }

  /**
   * 中断会话执行
   * 
   * 停止当前执行，清除所有待处理输入。
   */
  async interrupt(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      // 常见于：渲染进程重载后 cancelAllTurns、或会话仅有 runtime 尚未 admit。
      // 不是错误，避免误报成迁移/查找失败。
      return;
    }

    console.log(`[SessionCoordinator] Interrupting session ${sessionId}`, {
      active: entry.active,
      pendingInputs: entry.pendingInputs.length,
    });

    // 清除待处理标志
    entry.pendingWake = false;
    
    // 拒绝所有队列中的输入
    const pendingInputs = entry.pendingInputs.splice(0);
    for (const input of pendingInputs) {
      if (input._reject) {
        input._reject(new Error(`Session ${sessionId} interrupted`));
      }
    }

    // 取消当前执行
    if (entry.abortController) {
      entry.abortController.abort();
    }

    // 等待当前 fiber 完成（如果有）
    if (entry.fiber) {
      try {
        await entry.fiber;
      } catch (error) {
        // 忽略中断错误
        console.log(`[SessionCoordinator] Interrupt error (expected):`, error);
      }
    }

    console.log(`[SessionCoordinator] Session ${sessionId} interrupted`);
  }

  /**
   * 检查会话是否正在执行
   */
  isActive(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return entry?.active ?? false;
  }

  /**
   * 获取会话的待处理输入数量
   */
  getPendingCount(sessionId: string): number {
    const entry = this.entries.get(sessionId);
    return entry?.pendingInputs.length ?? 0;
  }

  /**
   * 获取会话的 AbortController（用于外部中断）
   */
  getAbortController(sessionId: string): AbortController | null {
    const entry = this.entries.get(sessionId);
    return entry?.abortController ?? null;
  }

  /**
   * 清理会话状态（会话删除时调用）
   */
  async cleanup(sessionId: string): Promise<void> {
    console.log(`[SessionCoordinator] Cleaning up session ${sessionId}`);
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.disposed = true;
    entry.pendingWake = false;
    for (const input of entry.pendingInputs.splice(0)) {
      input._reject?.(new Error(`Session ${sessionId} deleted`));
    }
    entry.abortController?.abort();
    if (entry.fiber) {
      try { await entry.fiber; } catch { /* cancellation is expected */ }
    }
    if (this.entries.get(sessionId) === entry) {
      this.entries.delete(sessionId);
    }
  }

  /**
   * 获取协调器统计信息（用于调试和监控）
   */
  getStats(): CoordinatorStats {
    const sessions = Array.from(this.entries.values()).map((entry) => ({
      sessionId: entry.sessionId,
      active: entry.active,
      pendingInputs: entry.pendingInputs.length,
      lastActivity: entry.lastActivity,
    }));

    return {
      totalSessions: this.entries.size,
      activeSessions: sessions.filter((s) => s.active).length,
      totalPendingInputs: sessions.reduce((sum, s) => sum + s.pendingInputs, 0),
      sessions,
    };
  }

  // ── 私有方法 ──────────────────────────────────────────────────────────

  /**
   * Drain loop - 处理会话的所有待处理输入
   * 
   * 这是核心执行循环，持续处理输入直到：
   * 1. 没有更多待处理输入
   * 2. 不需要继续（没有工具调用等）
   * 3. 被中断
   */
  private async drain(sessionId: string): Promise<T | void> {
    console.log(`[SessionCoordinator] Starting drain loop for session ${sessionId}`);
    
    const entry = this.entries.get(sessionId);
    if (!entry) {
      throw new Error(`Session ${sessionId} not found in drain loop`);
    }

    let lastResult: T | undefined;

    while (true) {
      // 检查是否被中断
      if (entry.disposed || entry.abortController?.signal.aborted) {
        break;
      }

      const input = entry.pendingInputs.shift();
      if (!input) {
        console.log(`[SessionCoordinator] No more pending inputs for session ${sessionId}`);
        break;
      }

      entry.lastActivity = Date.now();
      entry.currentContext = input.context;

      // 执行一轮
      try {
        console.log(`[SessionCoordinator] Executing turn for session ${sessionId}`, {
          inputId: input.id,
          textLength: input.text.length,
          hasContext: !!input.context,
        });

        lastResult = await this.drainHandler(sessionId, input);

        console.log(`[SessionCoordinator] Turn completed for session ${sessionId}`);
        
        // 通知 admit() 调用者操作完成
        if (input._resolve) {
          input._resolve(lastResult);
        }
      } catch (error) {
        console.error(`[SessionCoordinator] Turn failed for session ${sessionId}:`, error);
        
        // 通知 admit() 调用者操作失败
        if (input._reject) {
          input._reject(error);
        }
        
        // 执行失败后继续处理队列中的其他输入
        // 不要 throw，让后续输入有机会执行
        continue;
      }

      // 检查是否需要继续（例如工具调用）
      try {
        const needsContinuation = await this.continuationCheck(
          sessionId, 
          lastResult, 
          input.context
        );
        
        if (!needsContinuation) {
          console.log(`[SessionCoordinator] No continuation needed for session ${sessionId}`);
          // 当前输入已完成，但队列中可能还有后续输入；不要因本轮不需要
          // 工具续跑而终止整个 drain 循环。
          continue;
        }
        
        console.log(`[SessionCoordinator] Continuation needed for session ${sessionId}, continuing drain loop`);
      } catch (error) {
        console.error(`[SessionCoordinator] Continuation check failed for session ${sessionId}:`, error);
        // continuationCheck 只决定当前轮是否需要继续，不应丢弃队列中的
        // 后续输入。继续 drain，让下一个输入仍有机会执行。
        continue;
      }
    }

    console.log(`[SessionCoordinator] Drain loop complete for session ${sessionId}`);
    entry.currentContext = undefined;
    return lastResult;
  }

  private getOrCreate(sessionId: string): ExecutionEntry<TContext> {
    if (!this.entries.has(sessionId)) {
      this.entries.set(sessionId, {
        sessionId,
        active: false,
        pendingWake: false,
        fiber: null,
        abortController: null,
        pendingInputs: [],
        lastActivity: Date.now(),
        currentContext: undefined,
        disposed: false,
      });
    }
    return this.entries.get(sessionId)!;
  }
}

/**
 * 创建一个简化的协调器（无 continuation check）
 */
export function createSimpleCoordinator<T, TContext = any>(
  drainHandler: DrainHandler<T, TContext>,
): SessionRunCoordinator<T, TContext> {
  return new SessionRunCoordinator(
    drainHandler,
    async () => false, // 不自动继续
  );
}
