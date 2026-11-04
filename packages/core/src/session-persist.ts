import type { PersistedSession } from "./session-store.ts";
import type { SessionRuntime } from "./session-runtime.ts";

/**
 * 组装 saveSessionById 的会话持久化 payload。
 * persist() 与每轮执行结束的 directPersist() 共用，保证两条写路径字段一致。
 */
export function buildSessionPersistPayload(r: SessionRuntime) {
  return {
    mode: r.mode,
    history: r.history,
    terminalLog: r.terminalLog.slice(-80),
    lastPlanPath: r.lastPlanPath,
    currentFeature: r.currentFeature,
    todoAnchor: r.todoAnchor,
    lastCheckpointId: r.lastCheckpointId,
    documentWorkflow: r.documentWorkflow,
    queuedMessages: r.queuedMessages,
    taskRunState: r.taskRunState,
    createdAt: r.sessionCreatedAt ?? undefined,
  };
}

/**
 * 把一次保存挂到 runtime 的持久化队列尾并返回可等待的队列 promise。
 * 同一会话内的保存保持串行；前一个失败不影响后续保存入队。
 */
export function enqueueSessionPersist(r: SessionRuntime, run: () => Promise<void>): Promise<void> {
  r.persistQueue = r.persistQueue.then(run, run);
  return r.persistQueue;
}

/**
 * 验证会话数据的完整性
 */
export function validateSessionData(session: PersistedSession): boolean {
  try {
    // 基本结构验证
    if (!session || typeof session !== 'object') {
      console.warn('[session] 会话数据不是有效对象');
      return false;
    }

    // 版本验证
    if (session.version !== 1) {
      console.warn(`[session] 不支持的会话版本: ${session.version}`);
      return false;
    }

    // 历史数据验证
    if (!Array.isArray(session.history)) {
      console.warn('[session] 会话历史不是数组');
      return false;
    }

    // 验证历史条目结构
    for (let i = 0; i < session.history.length; i++) {
      const turn = session.history[i];
      if (!turn || typeof turn !== 'object') {
        console.warn(`[session] 历史条目 ${i} 结构无效`);
        return false;
      }
      if (!turn.role || !['user', 'assistant', 'tool', 'system'].includes(turn.role)) {
        console.warn(`[session] 历史条目 ${i} 角色无效: ${turn.role}`);
        return false;
      }
    }

    // 终端日志验证
    if (session.terminalLog && !Array.isArray(session.terminalLog)) {
      console.warn('[session] 终端日志不是数组');
      return false;
    }

    // 模式验证
    if (session.mode && !['agent', 'spec'].includes(session.mode)) {
      console.warn(`[session] 未知的会话模式: ${session.mode}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[session] 验证会话数据时发生错误:', error);
    return false;
  }
}
