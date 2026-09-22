import { useCallback, useEffect, useState } from "react";
import type { WorkspaceDirEntryDto } from "../../../preload/index";

interface Props {
  root: string;
  onOpenFile: (path: string) => void;
  /** Persisted open dirs for this project (survives tree unmount). */
  expandedDirs: Record<string, boolean>;
  onToggleDir: (path: string) => void;
}

interface TreeNodeProps {
  root: string;
  entry: WorkspaceDirEntryDto;
  depth: number;
  onOpenFile: (path: string) => void;
  expandedDirs: Record<string, boolean>;
  onToggleDir: (path: string) => void;
}

function TreeNode({ root, entry, depth, onOpenFile, expandedDirs, onToggleDir }: TreeNodeProps) {
  const open = entry.kind === "dir" && expandedDirs[entry.path] === true;
  const [children, setChildren] = useState<WorkspaceDirEntryDto[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadChildren = useCallback(async () => {
    if (entry.kind !== "dir") return;
    setLoading(true);
    try {
      const list = await window.owncoder.listWorkspaceDir(root, entry.path);
      setChildren(list);
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [entry.kind, entry.path, root]);

  // Restore children when a previously-expanded dir remounts.
  useEffect(() => {
    if (!open || entry.kind !== "dir" || children !== null || loading) return;
    void loadChildren();
  }, [open, entry.kind, children, loading, loadChildren]);

  const toggleDir = () => {
    if (entry.kind !== "dir") return;
    onToggleDir(entry.path);
  };

  if (entry.kind === "dir") {
    return (
      <div className="file-tree-node">
        <button
          type="button"
          className="file-tree-row dir"
          style={{ paddingLeft: 8 + depth * 12 }}
          title={entry.path}
          onClick={toggleDir}
        >
          <svg
            className="file-tree-chev"
            width="10"
            height="10"
            viewBox="0 0 12 12"
            style={{ transform: open ? "rotate(90deg)" : "none" }}
          >
            <path
              d="M4 2 L8 6 L4 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="file-tree-icon">📁</span>
          <span className="file-tree-name">{entry.name}</span>
        </button>
        {open ? (
          <div className="file-tree-children">
            {loading ? <p className="nav-empty nested">加载中…</p> : null}
            {!loading && children && children.length === 0 ? (
              <p className="nav-empty nested">空目录</p>
            ) : null}
            {!loading &&
              children?.map((child) => (
                <TreeNode
                  key={child.path}
                  root={root}
                  entry={child}
                  depth={depth + 1}
                  onOpenFile={onOpenFile}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                />
              ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="file-tree-row file"
      style={{ paddingLeft: 8 + depth * 12 }}
      title={entry.path}
      onDoubleClick={() => onOpenFile(entry.path)}
    >
      <span className="file-tree-chev-spacer" />
      <span className="file-tree-icon">📄</span>
      <span className="file-tree-name">{entry.name}</span>
    </button>
  );
}

export function ProjectFileTree({ root, onOpenFile, expandedDirs, onToggleDir }: Props) {
  const [entries, setEntries] = useState<WorkspaceDirEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    void window.owncoder
      .listWorkspaceDir(root, "")
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "无法读取目录");
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  if (error) return <p className="nav-empty nested">{error}</p>;
  if (entries === null) return <p className="nav-empty nested">加载中…</p>;
  if (entries.length === 0) return <p className="nav-empty nested">空目录</p>;

  return (
    <div className="file-tree">
      {entries.map((entry) => (
        <TreeNode
          key={entry.path}
          root={root}
          entry={entry}
          depth={0}
          onOpenFile={onOpenFile}
          expandedDirs={expandedDirs}
          onToggleDir={onToggleDir}
        />
      ))}
    </div>
  );
}
