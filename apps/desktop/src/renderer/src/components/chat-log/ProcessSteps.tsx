import { useState, memo } from "react";
import type { ChatTurnDto } from "../../../../preload/index";
import { Markdown } from "../Markdown";
import { useI18n } from "../../i18n";
import { LiveToolCard } from "./LiveToolCard";

// ── ProcessSteps: 已完成轮次的过程步骤（工具链 + 中间过程文本）折叠控件 ──────

function ProcessStepsImpl({ items }: { items: ChatTurnDto[] }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="process-block">
      <button type="button" className="process-head" onClick={() => setOpen((v) => !v)}>
        <span className="process-icon">⚙</span>
        <span className="process-title">{t("执行过程 · {{count}} 步", { count: items.length })}</span>
        <span className="activity-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="process-body">
          {items.map((it, idx) => {
            const key = it.id ?? `p-${idx}`;
            if (it.role === "tool") {
              const failed = it.content.startsWith("Error:");
              return (
                <div key={key} className="process-step">
                  <LiveToolCard
                    tool={{
                      id: it.id ?? key,
                      name: it.toolName ?? "unknown",
                      args: it.toolArgs ?? {},
                      status: failed ? "error" : "done",
                      output: it.content || undefined,
                    }}
                  />
                </div>
              );
            }
            return (
              <div key={key} className="process-step-text">
                <Markdown content={it.content} showCopy={false} />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export const ProcessSteps = memo(ProcessStepsImpl, (prev, next) => prev.items === next.items);
