/**
 * Session Migration - 旧会话数据迁移工具
 * 
 * 将旧格式的 ChatTurn（纯文本 content）迁移到新格式（parts + metadata）
 */

import type { ChatTurn, MessageMetadata } from "./harness/loop/types";
import { MessageProjector } from "./message-projector.ts";

/**
 * 迁移单个 ChatTurn
 * 
 * 如果已有 parts，直接返回
 * 如果没有 parts，从 content 提取结构
 */
export function migrateChatTurn(turn: ChatTurn): ChatTurn {
  // 已经有 parts，无需迁移
  if (turn.parts && turn.parts.length > 0) {
    return turn;
  }

  // 空内容，跳过
  if (!turn.content || !turn.content.trim()) {
    return turn;
  }

  // 用户消息和系统消息通常不需要结构化
  if (turn.role === "user" || turn.role === "system") {
    // 但如果 content 包含结构标记，仍然尝试解析
    if (!MessageProjector.isStructured(turn.content)) {
      return {
        ...turn,
        parts: [{ type: "text", text: turn.content }],
        metadata: buildMetadataFromLegacy(turn),
      };
    }
  }

  // 从 content 提取 parts
  const parts = MessageProjector.contentToParts(turn.content);

  // 构建 metadata
  const metadata = buildMetadataFromLegacy(turn);

  return {
    ...turn,
    parts,
    metadata,
  };
}

/**
 * 从旧字段构建 metadata
 */
function buildMetadataFromLegacy(turn: ChatTurn): MessageMetadata {
  const metadata: MessageMetadata = {};

  // 保留压缩相关字段
  if (turn.isCompressed) {
    metadata.isCompressed = turn.isCompressed;
    metadata.originalLength = turn.originalLength;
    metadata.compressedAt = turn.compressedAt;
    metadata.compressionReason = turn.compressionReason;
    metadata.importantSnippets = turn.importantSnippets;
  }

  return metadata;
}

/**
 * 迁移整个会话历史
 */
export function migrateHistory(history: ChatTurn[]): ChatTurn[] {
  return history.map(migrateChatTurn);
}

/**
 * 检查会话是否需要迁移
 * 
 * 如果任何一条消息没有 parts，返回 true
 */
export function needsMigration(history: ChatTurn[]): boolean {
  return history.some((turn) => {
    // 有内容但没有 parts
    return turn.content && turn.content.trim() && (!turn.parts || turn.parts.length === 0);
  });
}

/**
 * 批量迁移会话（用于启动时检查所有会话）
 */
export interface SessionSnapshot {
  id: string;
  history: ChatTurn[];
}

export function migrateSessionsInPlace(sessions: SessionSnapshot[]): {
  migrated: number;
  total: number;
} {
  let migrated = 0;

  for (const session of sessions) {
    if (needsMigration(session.history)) {
      session.history = migrateHistory(session.history);
      migrated++;
    }
  }

  return { migrated, total: sessions.length };
}

/**
 * 生成迁移报告
 */
export function generateMigrationReport(history: ChatTurn[]): {
  total: number;
  migrated: number;
  alreadyStructured: number;
  empty: number;
  details: Array<{
    index: number;
    role: string;
    hadParts: boolean;
    contentLength: number;
    extractedParts: number;
  }>;
} {
  const details: Array<{
    index: number;
    role: string;
    hadParts: boolean;
    contentLength: number;
    extractedParts: number;
  }> = [];

  let migrated = 0;
  let alreadyStructured = 0;
  let empty = 0;

  history.forEach((turn, index) => {
    const hadParts = Boolean(turn.parts && turn.parts.length > 0);
    const contentLength = turn.content?.length || 0;

    if (!turn.content || !turn.content.trim()) {
      empty++;
    } else if (hadParts) {
      alreadyStructured++;
    } else {
      migrated++;
    }

    const migratedTurn = migrateChatTurn(turn);

    details.push({
      index,
      role: turn.role,
      hadParts,
      contentLength,
      extractedParts: migratedTurn.parts?.length || 0,
    });
  });

  return {
    total: history.length,
    migrated,
    alreadyStructured,
    empty,
    details,
  };
}
