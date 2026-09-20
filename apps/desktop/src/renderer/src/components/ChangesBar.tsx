import { useState, useMemo } from "react";
import type { ChangeFileDto } from "../../../preload/index";

interface Props {
  changes: ChangeFileDto[];
  busy?: boolean;
  keepAllBusy?: boolean;
  onKeepAll: () => void;
  onUndoAll: () => void;
  onKeepFile: (path: string) => void;
  onUndoFile: (path: string) => void;
  /** 点击「查看变更」时调用，传入文件路径、变更前和变更后的内容 */
  onViewDiff?: (path: string, before: string, after: string) => void;
  /** 打开文件查看内容（非 diff） */
  onOpenFile?: (path: string) => void;
}

const KIND_LABEL: Record<ChangeFileDto["kind"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
};

const KIND_ICON: Record<ChangeFileDto["kind"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

/**
 * 计算真实的 diff 统计（逐行对比）
 * 使用改进的算法，能正确处理重复行
 */
function calculateDiffStats(before: string, after: string): { additions: number; deletions: number } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  
  // 使用 Map 记录每行出现的次数
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  
  for (const line of beforeLines) {
    beforeCounts.set(line, (beforeCounts.get(line) || 0) + 1);
  }
  
  for (const line of afterLines) {
    afterCounts.set(line, (afterCounts.get(line) || 0) + 1);
  }
  
  let additions = 0;
  let deletions = 0;
  
  // 计算删除：before中的行减去after中共同的部分
  for (const [line, beforeCount] of beforeCounts) {
    const afterCount = afterCounts.get(line) || 0;
    const deleted = Math.max(0, beforeCount - afterCount);
    deletions += deleted;
  }
  
  // 计算新增：after中的行减去before中共同的部分
  for (const [line, afterCount] of afterCounts) {
    const beforeCount = beforeCounts.get(line) || 0;
    const added = Math.max(0, afterCount - beforeCount);
    additions += added;
  }
  
  return { additions, deletions };
}

/** Inline collapsible review bar shown above the composer. */
export function ChangesBar({
  changes,
  busy,
  keepAllBusy,
  onKeepAll,
  onUndoAll,
  onKeepFile,
  onUndoFile,
  onViewDiff,
  onOpenFile,
}: Props) {
  const [open, setOpen] = useState(false);

  // 计算每个文件的统计信息（使用 useMemo 避免重复计算）
  const fileStats = useMemo(() => {
    return changes.map((c) => {
      if (c.kind === "added") {
        return { path: c.path, additions: c.after.split("\n").length, deletions: 0 };
      }
      if (c.kind === "deleted") {
        return { path: c.path, additions: 0, deletions: c.before.split("\n").length };
      }
      // 对于修改的文件，使用真实的 diff 计算
      return { path: c.path, ...calculateDiffStats(c.before, c.after) };
    });
  }, [changes]);

  // 从文件统计中派生总体统计和类型计数
  const stats = useMemo(() => {
    const totals = fileStats.reduce(
      (acc, stat) => ({
        additions: acc.additions + stat.additions,
        deletions: acc.deletions + stat.deletions,
      }),
      { additions: 0, deletions: 0 }
    );

    const counts = changes.reduce(
      (acc, c) => {
        acc[c.kind]++;
        return acc;
      },
      { added: 0, modified: 0, deleted: 0 }
    );

    return { ...totals, ...counts };
  }, [fileStats, changes]);

  if (changes.length === 0) return null;

  return (
    <section className={open ? "review-bar open" : "review-bar"}>
      {/* ── Header ── */}
      <div className="review-bar-head">
        <button type="button" className="review-bar-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="activity-chev">{open ? "▾" : "▸"}</span>
          <span className="review-bar-title">变更</span>
          <span className="review-bar-count">{changes.length}</span>
          {open && (stats.additions > 0 || stats.deletions > 0) ? (
            <span className="review-bar-stats">
              {stats.additions > 0 ? <span className="stat-add">+{stats.additions}</span> : null}
              {stats.deletions > 0 ? <span className="stat-del">-{stats.deletions}</span> : null}
            </span>
          ) : null}
        </button>
        <div className="review-bar-actions">
          <button type="button" className="ghost tiny" disabled={busy} onClick={onUndoAll}>
            全部撤销
          </button>
          <button type="button" className="ghost tiny accent" disabled={keepAllBusy} onClick={onKeepAll}>
            全部保留
          </button>
        </div>
      </div>

      {/* ── File list ── */}
      {open ? (
        <div className="changes-list">
          {changes.map((c, index) => {
            // 使用预计算的统计信息
            const fileStat = fileStats[index];

            return (
              <div
                key={c.path}
                className="change-item"
                title={c.kind !== "deleted" ? "双击打开文件" : undefined}
                onDoubleClick={() => {
                  if (c.kind !== "deleted") onOpenFile?.(c.path);
                }}
              >
                {/* Left: kind badge + file path + stats */}
                <div className="change-item-main">
                  <span className={`change-kind ${c.kind}`}>
                    <span className="change-kind-icon">{KIND_ICON[c.kind]}</span>
                    <span className="change-kind-label">{KIND_LABEL[c.kind]}</span>
                  </span>
                  <span className="change-path" title={c.path}>{c.path}</span>
                  {(fileStat.additions > 0 || fileStat.deletions > 0) ? (
                    <span className="change-stats">
                      {fileStat.additions > 0 ? <span className="stat-add">+{fileStat.additions}</span> : null}
                      {fileStat.deletions > 0 ? <span className="stat-del">-{fileStat.deletions}</span> : null}
                    </span>
                  ) : null}
                </div>

                {/* Right: actions */}
                <div
                  className="change-item-actions"
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  {c.kind !== "deleted" ? (
                    <>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => onViewDiff?.(c.path, c.before, c.after)}
                      >
                        查看变更
                      </button>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => onOpenFile?.(c.path)}
                        title="在编辑器中打开"
                      >
                        打开
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={busy}
                    onClick={() => onUndoFile(c.path)}
                  >
                    撤销
                  </button>
                  <button
                    type="button"
                    className="ghost tiny accent"
                    disabled={busy}
                    onClick={() => onKeepFile(c.path)}
                  >
                    保留
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
