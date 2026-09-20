/**
 * SessionStateMachine
 * 
 * 管理每个会话的执行状态，确保同一会话的操作串行执行，避免竞态条件。
 * 
 * 核心原则：
 * - 一个会话 → 最多一个活跃操作
 * - 不同会话可以并发执行
 * - 操作失败不影响其他会话
 */

export type SessionStatus = 'idle' | 'busy' | 'error' | 'interrupted';

export interface SessionState {
  id: string;
  status: SessionStatus;
  lastActivity: number;
  activeOperation: string | null; // 当前正在执行的操作名称
  error: Error | null;
}

interface QueuedOperation {
  operation: string;
  fn: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

class SessionStateMachine {
  private states = new Map<string, SessionState>();
  private queues = new Map<string, QueuedOperation[]>();
  private activePromises = new Map<string, Promise<any>>();

  /**
   * 串行执行会话操作
   * 如果会话正忙，操作会入队等待
   */
  async executeForSession<T>(
    sessionId: string,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const state = this.getOrCreate(sessionId);

    console.log(`[StateMachine] executeForSession:`, {
      sessionId,
      operation,
      currentStatus: state.status,
      activeOperation: state.activeOperation,
    });

    // 如果会话正忙，入队等待
    if (state.status === 'busy' && state.activeOperation !== operation) {
      console.log(`[StateMachine] Session ${sessionId} is busy with ${state.activeOperation}, queueing ${operation}`);
      return this.enqueue(sessionId, operation, fn);
    }

    // 标记为忙碌
    this.setState(sessionId, 'busy', operation, null);

    try {
      const result = await fn();
      this.setState(sessionId, 'idle', null, null);
      
      // 执行完成后，处理队列中的下一个操作
      this.processQueue(sessionId);
      
      return result;
    } catch (error) {
      console.error(`[StateMachine] Operation ${operation} failed for session ${sessionId}:`, error);
      this.setState(sessionId, 'error', null, error as Error);
      
      // 即使失败也要处理队列
      this.processQueue(sessionId);
      
      throw error;
    }
  }

  /**
   * 将操作加入队列
   */
  private enqueue<T>(
    sessionId: string,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(sessionId) || [];
      queue.push({ operation, fn, resolve, reject });
      this.queues.set(sessionId, queue);
      
      console.log(`[StateMachine] Queued operation ${operation} for session ${sessionId}, queue length: ${queue.length}`);
    });
  }

  /**
   * 处理队列中的下一个操作
   */
  private processQueue(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) {
      return;
    }

    const next = queue.shift()!;
    this.queues.set(sessionId, queue);
    
    console.log(`[StateMachine] Processing queued operation ${next.operation} for session ${sessionId}, remaining: ${queue.length}`);

    // 执行队列中的操作
    this.executeForSession(sessionId, next.operation, next.fn)
      .then(next.resolve)
      .catch(next.reject);
  }

  /**
   * 立即执行操作（不排队）
   * 用于需要立即响应的操作，如中断
   */
  async executeImmediately<T>(
    sessionId: string,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    console.log(`[StateMachine] executeImmediately:`, { sessionId, operation });
    
    // 拒绝队列中的所有操作
    const queue = this.queues.get(sessionId);
    if (queue) {
      for (const op of queue) {
        op.reject(new Error(`Operation ${op.operation} cancelled by immediate execution`));
      }
      this.queues.delete(sessionId);
    }
    
    // 等待当前操作完成（如果有）
    const activePromise = this.activePromises.get(sessionId);
    if (activePromise) {
      try {
        await activePromise;
      } catch {
        // 忽略错误，继续执行
      }
    }
    
    this.setState(sessionId, 'busy', operation, null);
    
    const promise = fn()
      .then((result) => {
        this.setState(sessionId, 'idle', null, null);
        this.activePromises.delete(sessionId);
        return result;
      })
      .catch((error) => {
        this.setState(sessionId, 'error', null, error as Error);
        this.activePromises.delete(sessionId);
        throw error;
      });
    
    this.activePromises.set(sessionId, promise);
    return promise;
  }

  /**
   * 中断会话的所有操作
   */
  interrupt(sessionId: string): void {
    console.log(`[StateMachine] Interrupting session ${sessionId}`);
    
    const queue = this.queues.get(sessionId);
    if (queue) {
      // 拒绝所有排队的操作
      queue.forEach((op) => {
        op.reject(new Error(`Operation ${op.operation} interrupted`));
      });
      this.queues.delete(sessionId);
    }
    
    this.setState(sessionId, 'interrupted', null, null);
  }

  /**
   * 获取会话状态
   */
  getStatus(sessionId: string): SessionStatus {
    return this.getOrCreate(sessionId).status;
  }

  /**
   * 获取会话状态详情
   */
  getState(sessionId: string): SessionState {
    return { ...this.getOrCreate(sessionId) };
  }

  /**
   * 检查会话是否忙碌
   */
  isBusy(sessionId: string): boolean {
    return this.getOrCreate(sessionId).status === 'busy';
  }

  /**
   * 获取队列长度
   */
  getQueueLength(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /**
   * 清理会话状态（会话删除时调用）
   */
  cleanup(sessionId: string): void {
    console.log(`[StateMachine] Cleaning up session ${sessionId}`);
    
    // 清除队列
    const queue = this.queues.get(sessionId);
    if (queue) {
      queue.forEach((op) => {
        op.reject(new Error(`Session ${sessionId} deleted`));
      });
    }
    
    this.states.delete(sessionId);
    this.queues.delete(sessionId);
    this.activePromises.delete(sessionId);
  }

  /**
   * 重置会话状态到 idle
   */
  reset(sessionId: string): void {
    this.setState(sessionId, 'idle', null, null);
    this.queues.delete(sessionId);
  }

  /**
   * 获取所有会话状态（用于调试）
   */
  getAllStates(): Map<string, SessionState> {
    return new Map(this.states);
  }

  // ── 私有方法 ──────────────────────────────────────────────────────────

  private setState(
    id: string,
    status: SessionStatus,
    operation: string | null,
    error: Error | null,
  ): void {
    const state = this.getOrCreate(id);
    state.status = status;
    state.activeOperation = operation;
    state.error = error;
    state.lastActivity = Date.now();
  }

  private getOrCreate(id: string): SessionState {
    if (!this.states.has(id)) {
      this.states.set(id, {
        id,
        status: 'idle',
        lastActivity: Date.now(),
        activeOperation: null,
        error: null,
      });
    }
    return this.states.get(id)!;
  }
}

// 单例实例
export const sessionStateMachine = new SessionStateMachine();

// 开发环境下暴露到 window 用于调试
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as any).__sessionStateMachine = sessionStateMachine;
}
