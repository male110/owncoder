import { useChatStore } from "../store/chat-store";
import { getFocusSessionId } from "../store/focus-session";

/**
 * Inline confirmation bar shown above the composer for each session.
 *
 * Replaces the former global overlay dialog. The main process remains the
 * security boundary; this component only returns the user's decision for the
 * current request. Requests are routed per-session via `chat-store`, so
 * concurrent sessions each show their own pending confirmation independently.
 *
 * Intentionally does NOT steal focus or bind Escape/Enter: if the bar appears
 * while the user is typing in the composer, keystrokes must not dismiss or
 * approve the prompt. Only an explicit click on 允许/拒绝 counts.
 */
export function DangerousCommandBar() {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const confirmations = useChatStore((s) => s.dangerousConfirmations);

  const current = confirmations[0] ?? null;

  const respond = (allowed: boolean) => {
    if (!current) return;
    const sid = getFocusSessionId() ?? activeSessionId ?? undefined;
    useChatStore.getState().removeDangerousConfirmation(current.requestId, sid);
    window.owncoder.respondDangerousCommand(current.requestId, allowed);
  };

  if (!current) return null;

  const queuedCount = confirmations.length - 1;
  const description = describeDangerousCommand(current.command);

  return (
    <div className="danger-confirm-bar" role="alert" aria-live="assertive">
      <pre className="danger-confirm-bar-command">{current.command}</pre>
      <p className="danger-confirm-bar-desc">{description}</p>

      <div className="danger-confirm-bar-footer">
        <div className="danger-confirm-bar-meta">
          <span className="danger-confirm-bar-eyebrow">需要确认后才会执行</span>
          <span className="danger-confirm-bar-hint">
            {queuedCount > 0 ? `还有 ${queuedCount} 条等待确认` : "请点击下方按钮决定"}
          </span>
        </div>
        <div className="danger-confirm-bar-actions">
          <button
            type="button"
            className="danger-confirm-bar-reject"
            onClick={() => respond(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="danger-confirm-bar-allow"
            onClick={() => respond(true)}
          >
            允许一次
          </button>
        </div>
      </div>
    </div>
  );
}

/** Short Chinese summary of what a pending shell command is likely to do. */
function describeDangerousCommand(command: string): string {
  const c = command.toLowerCase();
  if (/\brm\s+(-[a-z]*[rf]|\/s)\b/.test(c) || /\bRemove-Item\b.*(?:-Recurse|-Force)/i.test(command)) {
    return "删除文件或目录（可能不可恢复）";
  }
  if (/\bdel\s+(?:\/[sq]\s+|[^\r\n]*[*>?])/.test(c) || /\brmdir\s+\/s\b/.test(c)) {
    return "删除文件或目录（可能不可恢复）";
  }
  if (/\bgit\s+push\s+.*--force(?:-with-lease)?\b/.test(c)) {
    return "强制推送，可能覆盖远程提交历史";
  }
  if (/\bgit\s+reset\s+--hard\b/.test(c)) {
    return "硬重置工作区，未提交改动会丢失";
  }
  if (/\bgit\s+clean\s+-[^\s]*f/.test(c)) {
    return "清理未跟踪文件，相关内容会被删除";
  }
  if (/\bgit\s+checkout\s+(?:.*\s)?--(?:\s|$)/.test(c) || /\bgit\s+restore\b/.test(c)) {
    return "丢弃工作区改动，恢复到已提交版本";
  }
  if (/\bgit\s+stash\b(?!\s+(?:list|show)\b)/.test(c)) {
    return "暂存或移动工作区改动";
  }
  if (/\bgit\s+rm\b/.test(c)) {
    return "从仓库中删除文件";
  }
  if (/\bgit\s+branch\s+.*-D\b/.test(command)) {
    return "强制删除 Git 分支";
  }
  if (/\b(shutdown|restart-computer)\b/.test(c) || /\bformat\s+/i.test(c)) {
    return "系统级危险操作，可能关机或格式化磁盘";
  }
  if (/\breg\s+(delete|add)\b/.test(c)) {
    return "修改 Windows 注册表";
  }
  if (/\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item)\b/i.test(command)) {
    return "写入或改动文件系统内容";
  }
  if (/\b(?:cp|mv|touch|mkdir|chmod|chown)\b/.test(c) || /(?:^|\s)(?:>>?|2>)\s*[^&|]/.test(c)) {
    return "写入或改动文件系统内容";
  }
  if (/\b(drop\s+(?:database|table)|truncate\s+table)\b/i.test(c)) {
    return "删除或清空数据库对象";
  }
  if (/^mcp tool:/i.test(command.trim())) {
    return "调用可能产生副作用的 MCP 工具";
  }
  return "这条命令可能修改系统或项目状态，执行前请确认";
}
