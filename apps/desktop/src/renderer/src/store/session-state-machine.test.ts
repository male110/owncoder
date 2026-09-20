/**
 * SessionStateMachine 测试
 * 
 * 验证会话状态机的核心功能：
 * - 串行执行同一会话的操作
 * - 支持操作入队
 * - 正确处理中断
 * - 会话清理
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionStateMachine } from './session-state-machine';

describe('SessionStateMachine', () => {
  let stateMachine: SessionStateMachine;

  beforeEach(() => {
    stateMachine = new SessionStateMachine();
  });

  describe('基本状态管理', () => {
    it('应该创建初始状态为 idle 的会话', () => {
      const status = stateMachine.getStatus('session-1');
      expect(status).toBe('idle');
    });

    it('应该在执行时标记为 busy', async () => {
      const promise = stateMachine.executeForSession('session-1', 'test', async () => {
        expect(stateMachine.getStatus('session-1')).toBe('busy');
        await new Promise(resolve => setTimeout(resolve, 10));
      });

      // 立即检查应该是 busy
      expect(stateMachine.isBusy('session-1')).toBe(true);
      
      await promise;
      
      // 完成后应该是 idle
      expect(stateMachine.getStatus('session-1')).toBe('idle');
    });

    it('应该跟踪活跃操作名称', async () => {
      const promise = stateMachine.executeForSession('session-1', 'switch', async () => {
        const state = stateMachine.getState('session-1');
        expect(state.activeOperation).toBe('switch');
        await new Promise(resolve => setTimeout(resolve, 10));
      });

      await promise;

      const state = stateMachine.getState('session-1');
      expect(state.activeOperation).toBe(null);
    });
  });

  describe('串行执行', () => {
    it('应该串行执行同一会话的操作', async () => {
      const executionOrder: number[] = [];

      const op1 = stateMachine.executeForSession('session-1', 'op1', async () => {
        executionOrder.push(1);
        await new Promise(resolve => setTimeout(resolve, 50));
        executionOrder.push(2);
      });

      // 稍微延迟后提交第二个操作，确保第一个操作已经开始
      await new Promise(resolve => setTimeout(resolve, 10));

      const op2 = stateMachine.executeForSession('session-1', 'op2', async () => {
        executionOrder.push(3);
        await new Promise(resolve => setTimeout(resolve, 10));
        executionOrder.push(4);
      });

      await Promise.all([op1, op2]);

      // 验证执行顺序：op1 完全执行完成后才开始 op2
      expect(executionOrder).toEqual([1, 2, 3, 4]);
    });

    it('应该允许不同会话并发执行', async () => {
      const executionOrder: string[] = [];

      const session1 = stateMachine.executeForSession('session-1', 'op', async () => {
        executionOrder.push('s1-start');
        await new Promise(resolve => setTimeout(resolve, 30));
        executionOrder.push('s1-end');
      });

      const session2 = stateMachine.executeForSession('session-2', 'op', async () => {
        executionOrder.push('s2-start');
        await new Promise(resolve => setTimeout(resolve, 20));
        executionOrder.push('s2-end');
      });

      await Promise.all([session1, session2]);

      // 两个会话应该并发执行，session-2 应该先完成
      expect(executionOrder).toEqual([
        's1-start',
        's2-start',
        's2-end',
        's1-end'
      ]);
    });
  });

  describe('队列管理', () => {
    it('应该将忙碌时的操作加入队列', async () => {
      const results: number[] = [];

      // 启动长时间操作
      const op1 = stateMachine.executeForSession('session-1', 'op1', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        results.push(1);
      });

      // 确保第一个操作已开始
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(stateMachine.isBusy('session-1')).toBe(true);
      expect(stateMachine.getQueueLength('session-1')).toBe(0);

      // 提交第二个操作（应该入队）
      const op2 = stateMachine.executeForSession('session-1', 'op2', async () => {
        results.push(2);
      });

      // 第二个操作应该在队列中
      expect(stateMachine.getQueueLength('session-1')).toBe(1);

      await Promise.all([op1, op2]);

      // 验证执行顺序
      expect(results).toEqual([1, 2]);
      expect(stateMachine.getQueueLength('session-1')).toBe(0);
    });

    it('应该按 FIFO 顺序处理队列', async () => {
      const results: number[] = [];

      // 启动长时间操作
      const op1 = stateMachine.executeForSession('session-1', 'op1', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        results.push(1);
      });

      // 确保第一个操作已开始
      await new Promise(resolve => setTimeout(resolve, 10));

      // 快速提交多个操作
      const op2 = stateMachine.executeForSession('session-1', 'op2', async () => {
        results.push(2);
      });

      const op3 = stateMachine.executeForSession('session-1', 'op3', async () => {
        results.push(3);
      });

      const op4 = stateMachine.executeForSession('session-1', 'op4', async () => {
        results.push(4);
      });

      await Promise.all([op1, op2, op3, op4]);

      // 验证 FIFO 顺序
      expect(results).toEqual([1, 2, 3, 4]);
    });
  });

  describe('错误处理', () => {
    it('应该在操作失败时标记为 error', async () => {
      await expect(
        stateMachine.executeForSession('session-1', 'failing', async () => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');

      expect(stateMachine.getStatus('session-1')).toBe('error');
      const state = stateMachine.getState('session-1');
      expect(state.error?.message).toBe('Test error');
    });

    it('应该在错误后继续处理队列', async () => {
      const results: string[] = [];

      const op1 = stateMachine.executeForSession('session-1', 'op1', async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        results.push('op1');
        throw new Error('Op1 failed');
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      const op2 = stateMachine.executeForSession('session-1', 'op2', async () => {
        results.push('op2');
      });

      await expect(op1).rejects.toThrow('Op1 failed');
      await op2;

      // op2 应该仍然执行
      expect(results).toEqual(['op1', 'op2']);
    });
  });

  describe('中断操作', () => {
    it('应该清除队列', async () => {
      // 启动长时间操作
      const op1 = stateMachine.executeForSession('session-1', 'op1', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // 加入队列
      const op2Promise = stateMachine.executeForSession('session-1', 'op2', async () => {
        // 不应该执行
      });

      expect(stateMachine.getQueueLength('session-1')).toBe(1);

      // 中断
      stateMachine.interrupt('session-1');

      // 队列应该被清空
      expect(stateMachine.getQueueLength('session-1')).toBe(0);
      expect(stateMachine.getStatus('session-1')).toBe('interrupted');

      // op2 应该被拒绝
      await expect(op2Promise).rejects.toThrow('Operation op2 interrupted');

      await op1;
    });
  });

  describe('立即执行', () => {
    it('应该清除队列并等待当前操作完成', async () => {
      const results: string[] = [];

      // 启动普通操作
      const op1 = stateMachine.executeForSession('session-1', 'op1', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        results.push('op1');
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // 加入队列的操作
      const op2Promise = stateMachine.executeForSession('session-1', 'op2', async () => {
        results.push('op2');
      });

      expect(stateMachine.getQueueLength('session-1')).toBe(1);

      // 立即执行
      const immediateOp = stateMachine.executeImmediately('session-1', 'immediate', async () => {
        results.push('immediate');
      });

      await Promise.all([op1, immediateOp]);

      // op2 应该被清除，immediate 应该在 op1 后执行
      expect(results).toEqual(['op1', 'immediate']);
      await expect(op2Promise).rejects.toBeDefined();
    });
  });

  describe('会话清理', () => {
    it('应该清除所有会话状态', async () => {
      // 执行一些操作
      await stateMachine.executeForSession('session-1', 'op1', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });

      expect(stateMachine.getStatus('session-1')).toBe('idle');

      // 清理
      stateMachine.cleanup('session-1');

      // 状态应该被完全清除
      const state = stateMachine.getState('session-1');
      expect(state.status).toBe('idle'); // 新的默认状态
      expect(state.lastActivity).toBeGreaterThan(0);
    });

    it('应该拒绝清理后队列中的操作', async () => {
      // 启动长时间操作
      const op1 = stateMachine.executeForSession('session-1', 'op1', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // 加入队列
      const op2Promise = stateMachine.executeForSession('session-1', 'op2', async () => {
        // 不应该执行
      });

      // 清理
      stateMachine.cleanup('session-1');

      // 队列中的操作应该被拒绝
      await expect(op2Promise).rejects.toThrow('Session session-1 deleted');

      await op1;
    });
  });

  describe('重置', () => {
    it('应该重置会话状态到 idle', async () => {
      // 创建错误状态
      await expect(
        stateMachine.executeForSession('session-1', 'failing', async () => {
          throw new Error('Test error');
        })
      ).rejects.toThrow();

      expect(stateMachine.getStatus('session-1')).toBe('error');

      // 重置
      stateMachine.reset('session-1');

      expect(stateMachine.getStatus('session-1')).toBe('idle');
    });
  });

  describe('调试信息', () => {
    it('应该返回所有会话的状态', async () => {
      // 创建多个会话
      const op1 = stateMachine.executeForSession('session-1', 'op1', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      await stateMachine.executeForSession('session-2', 'op2', async () => {
        // 立即完成
      });

      const states = stateMachine.getAllStates();
      expect(states.size).toBeGreaterThanOrEqual(2);
      expect(states.has('session-1')).toBe(true);
      expect(states.has('session-2')).toBe(true);

      await op1;
    });
  });
});
