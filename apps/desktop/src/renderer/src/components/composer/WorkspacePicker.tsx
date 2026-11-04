import { useRef, useState } from "react";
import type { GitStatusDto, ProjectDto } from "../../../../preload/index";
import { useI18n } from "../../i18n";
import { useMenuDismiss } from "./useMenuDismiss";

interface WorkspacePickerProps {
  workspaceName: string | null;
  workspaceRoot: string | null;
  projects: ProjectDto[];
  gitStatus: GitStatusDto | null;
  /** 切换工作区；Composer 负责包装 projectSwitching 禁用态。 */
  onSelectProject: (root: string) => Promise<void>;
  onAddProject: () => void;
}

/** composer 顶部：工作区切换菜单 + git 分支 chip（仅空会话 / 新会话待输入时显示）。 */
export function WorkspacePicker({
  workspaceName,
  workspaceRoot,
  projects,
  gitStatus,
  onSelectProject,
  onAddProject,
}: WorkspacePickerProps) {
  const { t } = useI18n();
  const wsMenuRef = useRef<HTMLDivElement | null>(null);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  useMenuDismiss(wsMenuOpen, wsMenuRef, () => setWsMenuOpen(false), { escape: false });

  return (
    <div className="composer-top">
      <div className="ws-picker" ref={wsMenuRef}>
        <button
          type="button"
          className="ws-trigger"
          aria-expanded={wsMenuOpen}
          onClick={() => setWsMenuOpen((v) => !v)}
          title={workspaceRoot ?? t("切换工作区")}
        >
          <span className="ws-icon" aria-hidden>
            <span className="ws-icon-dark">📁</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            </svg>
          </span>
          <span className="ws-project-info">
            <span className="ws-menu-name">{workspaceName ?? t("未打开工作区")}</span>
            {workspaceRoot ? <span className="ws-project-path">{workspaceRoot}</span> : null}
          </span>
          <span className="mode-chevron" aria-hidden>
            ▾
          </span>
        </button>
        {wsMenuOpen ? (
          <ul className="ws-menu">
            {projects.map((p) => (
              <li key={p.root}>
                <button
                  type="button"
                  className={p.root === workspaceRoot ? "selected" : ""}
                  title={p.root}
                  onClick={async () => {
                    setWsMenuOpen(false);
                    if (p.root !== workspaceRoot) {
                      await onSelectProject(p.root);
                    }
                  }}
                >
                  <span className="ws-project-info">
                    <span className="ws-menu-name">{p.name}</span>
                    <span className="ws-project-path">{p.root}</span>
                  </span>
                  {p.root === workspaceRoot ? (
                    <span className="ws-menu-check" aria-hidden>
                      ✓
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
            {projects.length > 0 ? <li className="ws-menu-sep" aria-hidden /> : null}
            <li>
              <button
                type="button"
                className="ws-menu-open"
                onClick={() => {
                  setWsMenuOpen(false);
                  onAddProject();
                }}
              >
                <span className="ws-menu-name">{t("＋ 打开新目录…")}</span>
              </button>
            </li>
          </ul>
        ) : null}
      </div>
      {gitStatus?.isRepo && gitStatus.branch ? (
        <span className={gitStatus.dirty ? "ws-branch-chip dirty" : "ws-branch-chip"} title={gitStatus.summary}>
          <span className="ws-branch-dot" aria-hidden />
          <span className="ws-branch-name">{gitStatus.branch}</span>
        </span>
      ) : null}
    </div>
  );
}
