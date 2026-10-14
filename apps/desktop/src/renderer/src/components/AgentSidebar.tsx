import { useState } from "react";
import type { ChatSessionMetaDto, ProjectDto } from "../../../preload/index";
import type { WorkspaceInfo } from "@owncoder/shared";
import type { SessionStatus } from "../store/chat-store";
import { ProjectFileTree } from "./ProjectFileTree";
import { t } from "../../../shared/i18n/core";
import { useI18n } from "../i18n";

const SESSION_PAGE_SIZE = 5;

type ProjectViewMode = "sessions" | "files";

function parseProjectPath(root: string): { name: string; parent: string } {
  // 兼容 Windows 和 Unix 路径分隔符
  const normalized = root.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return { name: root, parent: "" };
  const name = parts[parts.length - 1];
  // 父路径：Windows 盘符保留（如 f:\），Unix 保留根 /
  const parentParts = parts.slice(0, -1);
  let parent = parentParts.join("/");
  if (/^[a-zA-Z]$/.test(parent)) {
    // Windows 盘符：f -> f:\
    parent = parent + ":\\";
  } else if (normalized.startsWith("/") && parentParts.length > 0) {
    parent = "/" + parent;
  } else if (normalized.startsWith("/") && parentParts.length === 0) {
    parent = "/";
  }
  return { name, parent };
}

function relativeTime(iso: string): string {
  // 注意：局部变量不能叫 t，会遮蔽 i18n 的 t()
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return t("刚刚");
  if (sec < 3600) return t("{{n}}分钟", { n: Math.floor(sec / 60) });
  if (sec < 86400) return t("{{n}}小时", { n: Math.floor(sec / 3600) });
  if (sec < 86400 * 30) return t("{{n}}天", { n: Math.floor(sec / 86400) });
  return t("{{n}}月", { n: Math.floor(sec / (86400 * 30)) });
}

interface Props {
  projects: ProjectDto[];
  sessions: ChatSessionMetaDto[];
  sessionsByProject: Record<string, ChatSessionMetaDto[]>;
  workspace: WorkspaceInfo | null;
  activeSessionId: string | null;
  expanded: Record<string, boolean>;
  collapsed?: boolean;
  disabled?: boolean;
  /** Returns true when the given session has an in-flight turn. Used to keep
   * the delete button disabled for a running session. */
  isSessionRunning?: (id: string) => boolean;
  /** Returns the sidebar status icon state for a session. */
  getSessionStatus?: (id: string) => SessionStatus;
  /** Clear a non-running status icon (user clicked completed/needs_confirmation). */
  onClearSessionStatus?: (id: string) => void;
  onToggleCollapse?: () => void;
  onToggleExpand?: (root: string) => void;
  onNewSession: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
  onSelectProject: (root: string, focusSessionId?: string) => Promise<void>;
  onRemoveProject: (root: string) => Promise<void>;
  onMoveProject: (root: string, targetRoot: string, after: boolean) => Promise<void>;
  onSwitchSession: (id: string, projectRoot?: string) => Promise<void>;
  onDeleteSession: (id: string, projectRoot: string) => void;
  /** Open a workspace-relative file path in the editor (double-click from file tree). */
  onOpenFile?: (path: string) => void;
}

export function AgentSidebar({
  projects,
  sessions,
  sessionsByProject,
  workspace,
  activeSessionId,
  expanded,
  collapsed = false,
  disabled = false,
  isSessionRunning,
  getSessionStatus,
  onClearSessionStatus,
  onToggleCollapse,
  onToggleExpand,
  onNewSession,
  onAddProject,
  onOpenSettings,
  onSelectProject,
  onRemoveProject,
  onMoveProject,
  onSwitchSession,
  onDeleteSession,
  onOpenFile,
}: Props) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragRoot, setDragRoot] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ root: string; after: boolean } | null>(null);
  const { t } = useI18n();
  const [visibleCountByProject, setVisibleCountByProject] = useState<Record<string, number>>({});
  /** Per-project sidebar view; default is sessions. */
  const [viewModeByProject, setViewModeByProject] = useState<Record<string, ProjectViewMode>>({});
  /** Per-project file-tree expanded dirs; survives sidebar collapse / view switches. */
  const [expandedDirsByProject, setExpandedDirsByProject] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const getViewMode = (root: string): ProjectViewMode => viewModeByProject[root] ?? "sessions";
  const setViewMode = (root: string, mode: ProjectViewMode) => {
    setViewModeByProject((prev) => (prev[root] === mode ? prev : { ...prev, [root]: mode }));
  };
  const toggleExpandedDir = (projectRoot: string, dirPath: string) => {
    setExpandedDirsByProject((prev) => {
      const current = prev[projectRoot] ?? {};
      const nextForProject = { ...current, [dirPath]: !current[dirPath] };
      return { ...prev, [projectRoot]: nextForProject };
    });
  };
  return (
    <aside className={`nav-rail${collapsed ? " collapsed" : ""}`}>
      {collapsed ? (
        <>
          <div className="nav-header">
            <button type="button" className="nav-item collapse-btn" onClick={onToggleCollapse} title={t("展开侧边栏")}>
              <span className="nav-item-icon">«</span>
            </button>
          </div>
          <nav className="nav-menu">
            <button type="button" className="nav-item primary" onClick={() => void onNewSession()} title={t("新建对话")} disabled={disabled}>
              <span className="nav-item-icon">＋</span>
            </button>
            <button type="button" className="nav-item" onClick={() => void onAddProject()} title={t("添加项目")} disabled={disabled}>
              <span className="nav-item-icon">📁</span>
            </button>
          </nav>
          <div className="nav-footer">
            <button type="button" className="nav-item settings" onClick={onOpenSettings} title={t("设置")}>
              <span className="nav-item-icon">⚙</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="nav-header">
            <button type="button" className="nav-item collapse-btn" onClick={onToggleCollapse} title={t("收缩侧边栏")}>
              <span className="nav-item-icon">»</span>
            </button>
          </div>
          <nav className="nav-menu">
            <button type="button" className="nav-item primary" onClick={() => void onNewSession()} disabled={disabled}>
              <span className="nav-item-icon">＋</span>
              <span className="nav-item-label">{t("新建对话")}</span>
              <kbd>Ctrl+N</kbd>
            </button>
            <button type="button" className="nav-item" onClick={() => void onAddProject()} disabled={disabled}>
              <span className="nav-item-icon">📁</span>
              <span className="nav-item-label">{t("添加项目")}</span>
            </button>
          </nav>

          <div className="nav-section-label">{t("项目")}</div>

          <div className="project-tree">
            {projects.length === 0 ? (
              <p className="nav-empty">{t("内置 OwnCoderProject 将自动出现；也可点击「添加项目」打开本地仓库。")}</p>
            ) : (
              projects.map((p) => {
                const open = expanded[p.root] !== false;
                const isCurrent = workspace?.root === p.root;
                const projectSessions = isCurrent ? sessions : (sessionsByProject[p.root] ?? []);
                const activeIndex = isCurrent && activeSessionId
                  ? projectSessions.findIndex((s) => s.id === activeSessionId)
                  : -1;
                const needed = activeIndex >= 0 ? activeIndex + 1 : 0;
                const storedVisible = visibleCountByProject[p.root] ?? SESSION_PAGE_SIZE;
                const visibleCount = Math.max(
                  storedVisible,
                  Math.ceil(needed / SESSION_PAGE_SIZE) * SESSION_PAGE_SIZE || SESSION_PAGE_SIZE,
                );
                const visibleSessions = projectSessions.slice(0, visibleCount);
                const hasMoreSessions = projectSessions.length > visibleCount;
                const viewMode = getViewMode(p.root);
                return (
                  <div
                    key={p.root}
                    className={`project-block${dropTarget?.root === p.root ? ` drop-${dropTarget.after ? "after" : "before"}` : ""}`}
                    onDragOver={(e) => {
                      if (!dragRoot || dragRoot === p.root) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const header = e.currentTarget.querySelector(".project-header")?.getBoundingClientRect();
                      const after = header ? e.clientY >= header.top + header.height / 2 : false;
                      if (dropTarget?.root !== p.root || dropTarget.after !== after) setDropTarget({ root: p.root, after });
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragRoot && dragRoot !== p.root) void onMoveProject(dragRoot, p.root, dropTarget?.root === p.root ? dropTarget.after : false);
                      setDragRoot(null);
                      setDropTarget(null);
                    }}
                  >
                    <div
                      className="project-header"
                      onDragStart={(e) => {
                        setDragRoot(p.root);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", p.root);
                      }}
                      onDragEnd={() => { setDragRoot(null); setDropTarget(null); }}
                    >

                      <button
                        type="button"
                        className="project-chevron"
                        title={open ? t("折叠") : t("展开")}
                        onClick={() => onToggleExpand?.(p.root)}
                      >
                        <svg
                          className="chev-icon"
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          style={{ transform: open ? "rotate(90deg)" : "none" }}
                        >
                          <path d="M4 2 L8 6 L4 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="project-row"
                        aria-current={workspace?.root === p.root ? "true" : undefined}
                        title={p.root}
                        draggable={!disabled}
                        onClick={async () => {
                          await onSelectProject(p.root);
                        }}
                        disabled={disabled}
                      >
                        <span className="project-name">
                          {(() => {
                            const { name, parent } = parseProjectPath(p.root);
                            return (
                              <>
                                {name}
                                {parent && <span className="project-path">({parent})</span>}
                              </>
                            );
                          })()}
                        </span>
                      </button>
                      <div className="project-view-toggle" role="group" aria-label={t("项目视图切换")}>
                        <button
                          type="button"
                          className={`project-view-btn${viewMode === "sessions" ? " active" : ""}`}
                          title={t("会话列表")}
                          aria-pressed={viewMode === "sessions"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setViewMode(p.root, "sessions");
                            if (!open) onToggleExpand?.(p.root);
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                            <path
                              d="M3 3.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-2.5 2v-2H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.3"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className={`project-view-btn${viewMode === "files" ? " active" : ""}`}
                          title={t("文件目录")}
                          aria-pressed={viewMode === "files"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setViewMode(p.root, "files");
                            if (!open) onToggleExpand?.(p.root);
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                            <path
                              d="M2.5 4.5h4l1.2 1.2H13.5v6.3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.3"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      </div>
                      <button
                        type="button"
                        className="project-remove"
                        title={t("移除项目")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onRemoveProject(p.root);
                        }}
                      >
                        ×
                      </button>
                    </div>
                    {open && viewMode === "files" ? (
                      <div className="file-tree-wrap">
                        <ProjectFileTree
                          root={p.root}
                          expandedDirs={expandedDirsByProject[p.root] ?? {}}
                          onToggleDir={(dirPath) => toggleExpandedDir(p.root, dirPath)}
                          onOpenFile={(path) => {
                            // Opening a file must not toggle the current project's expand state.
                            // onSelectProject(currentRoot) intentionally collapses/expands; skip it
                            // when already on this project and only switch when needed.
                            const openFile = () => onOpenFile?.(path);
                            if (workspace?.root === p.root) {
                              openFile();
                              return;
                            }
                            void onSelectProject(p.root).then(openFile);
                          }}
                        />
                      </div>
                    ) : null}
                    {open && viewMode === "sessions" ? (
                      <div className="session-list">
                        {projectSessions.length === 0 ? (
                          <p className="nav-empty nested">{t("暂无任务")}</p>
                        ) : (
                          <>
                          {visibleSessions.map((s) => (
                            <div
                              key={s.id}
                              className={
                                isCurrent && s.id === activeSessionId
                                  ? "session-wrap active"
                                  : "session-wrap"
                              }
                            >
                              {(() => {
                                const st = getSessionStatus?.(s.id) ?? "idle";
                                if (st === "running") {
                                  return <span className="session-status-icon running" title={t("运行中")} />;
                                }
                                if (st === "completed" && s.id !== activeSessionId) {
                                  return (
                                    <button
                                      type="button"
                                      className="session-status-icon completed"
                                      title={t("任务完成（点击清除）")}
                                      onClick={(e) => { e.stopPropagation(); onClearSessionStatus?.(s.id); }}
                                    />
                                  );
                                }
                                if (st === "needs_confirmation") {
                                  const running = isSessionRunning?.(s.id) ?? false;
                                  return (
                                    <button
                                      type="button"
                                      className="session-status-icon needs-confirmation"
                                      title={running ? t("需要确认命令（点击查看）") : t("需要确认命令（点击清除）")}
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        // Cross-project session clicks must be one
                                        // navigation: project switch + focus session.
                                        // Sequential onSelectProject → onSwitchSession
                                        // bumps navigationVersion and can cancel the
                                        // first history hydrate, leaving only the
                                        // composer until a later revisit.
                                        if (!isCurrent) await onSelectProject(p.root, s.id);
                                        else await onSwitchSession(s.id, s.projectRoot);
                                        // If the session is no longer running,
                                        // the confirmation is stale — clear the
                                        // icon so it doesn't get stuck forever.
                                        if (!running) onClearSessionStatus?.(s.id);
                                      }}
                                    >
                                      <span className="session-status-badge">!</span>
                                    </button>
                                  );
                                }
                                return null;
                              })()}
                               <button
                                type="button"
                                className="session-row"
                                onClick={async () => {
                                  if (!isCurrent) await onSelectProject(p.root, s.id);
                                  else await onSwitchSession(s.id, s.projectRoot);
                                  // 切换到当前会话时去掉小绿点
                                  onClearSessionStatus?.(s.id);
                                }}
                                disabled={disabled}
                              >
                                <span className="session-title">{s.title === "新会话" ? t("新会话") : s.title}</span>
                                <span className="session-time">{relativeTime(s.updatedAt)}</span>
                              </button>

                              {confirmDeleteId === s.id ? (
                                <span className="session-delete-confirm">
                                  <button
                                    type="button"
                                    className="session-delete-yes"
                                    title={t("确认删除")}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfirmDeleteId(null);
                                      void onDeleteSession(s.id, p.root);
                                    }}
                                  >
                                    {t("确认")}
                                  </button>
                                  <button
                                    type="button"
                                    className="session-delete-no"
                                    title={t("取消")}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConfirmDeleteId(null);
                                    }}
                                  >
                                    {t("取消")}
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="session-delete"
                                  title={t("删除任务")}
                                  disabled={isSessionRunning?.(s.id) ?? false}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmDeleteId(s.id);
                                  }}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          ))}
                          {hasMoreSessions ? (
                            <button
                              type="button"
                              className="session-load-more"
                              onClick={() => {
                                setVisibleCountByProject((prev) => ({
                                  ...prev,
                                  [p.root]: visibleCount + SESSION_PAGE_SIZE,
                                }));
                              }}
                            >
                              {t("加载更多")}
                            </button>
                          ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <div className="nav-footer">
            <button type="button" className="nav-item settings" onClick={onOpenSettings}>
              <span className="nav-item-icon">⚙</span>
              <span className="nav-item-label">{t("设置")}</span>
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
