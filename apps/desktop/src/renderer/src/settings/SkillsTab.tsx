import { useCallback, useEffect, useState } from "react";
import type { SkillSummaryDto, SkillWriteDto } from "../../../preload/index";
import { customConfirm } from "../utils/customConfirm";
import { useI18n } from "../i18n";

type SkillScope = "project" | "user";

const SAMPLE_SKILL_MD = [
  "---",
  "name: my-skill",
  "description: 一句话说明何时使用这个技能",
  "when_to_use: 可选，进一步限定触发场景",
  "---",
  "",
  "这里写给模型看的指令正文。",
  "引用同目录资源用 ${OWNCODER_SKILL_DIR}，例如 ${OWNCODER_SKILL_DIR}/scripts/run.sh",
].join("\n");

export function SkillsTab() {
  const { t: tr } = useI18n();
  const [skills, setSkills] = useState<SkillSummaryDto[]>([]);
  const [hasWorkspace, setHasWorkspace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState<SkillScope | null>(null);
  const [editing, setEditing] = useState<SkillSummaryDto | null>(null);
  const [editRaw, setEditRaw] = useState("");
  const [form, setForm] = useState({ name: "", description: "", whenToUse: "", body: "" });

  const reload = useCallback(async () => {
    const ws = await window.owncoder.getWorkspace();
    setHasWorkspace(Boolean(ws));
    setSkills(await window.owncoder.listSkills());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Run an IPC mutation; on success the refreshed list is applied. */
  const run = async (fn: () => Promise<SkillSummaryDto[]>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      setSkills(await fn());
      return true;
    } catch (e) {
      setError(`${tr("操作失败：")}${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (s: SkillSummaryDto) =>
    run(() => window.owncoder.setSkillEnabled(s.id, !s.enabled));

  const remove = async (s: SkillSummaryDto) => {
    if (!(await customConfirm(tr("删除此技能？")))) return;
    await run(() => window.owncoder.deleteSkill(s.name));
  };

  const startAdd = (scope: SkillScope) => {
    setEditing(null);
    setAdding(scope);
    setForm({ name: "", description: "", whenToUse: "", body: "" });
  };

  const startEdit = async (s: SkillSummaryDto) => {
    setAdding(null);
    setError("");
    try {
      const d = await window.owncoder.readSkill(s.name);
      setEditing(d.meta);
      setEditRaw(d.raw);
    } catch (e) {
      setError(`${tr("操作失败：")}${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const cancelForm = () => {
    setAdding(null);
    setEditing(null);
    setEditRaw("");
  };

  const saveNew = async () => {
    if (!adding || !form.name.trim() || !form.description.trim()) return;
    const input: SkillWriteDto = {
      scope: adding,
      name: form.name.trim(),
      description: form.description.trim(),
      whenToUse: form.whenToUse.trim() || undefined,
      body: form.body,
    };
    if (await run(() => window.owncoder.writeSkill(input))) {
      setAdding(null);
      setForm({ name: "", description: "", whenToUse: "", body: "" });
    }
  };

  const saveEdit = async () => {
    if (!editing || editing.scope === "system") return;
    const input: SkillWriteDto = {
      scope: editing.scope,
      name: editing.name,
      description: "",
      body: "",
      raw: editRaw,
    };
    if (await run(() => window.owncoder.writeSkill(input))) {
      setEditing(null);
      setEditRaw("");
    }
  };

  const scopeLabel = (s: SkillSummaryDto): string =>
    s.scope === "project" ? tr("项目") : s.scope === "user" ? tr("用户") : tr("内置");

  const project = skills.filter((s) => s.scope === "project");
  const user = skills.filter((s) => s.scope === "user");
  const system = skills.filter((s) => s.scope === "system");

  const renderRow = (s: SkillSummaryDto) => (
    <div key={s.id} className={s.enabled ? "skill-item" : "skill-item skill-off"}>
      <div className="skill-item-head">
        <strong>{s.name}</strong>
        <span className="skill-scope">{scopeLabel(s)}</span>
        <span className="skill-item-actions">
          <label className="skill-check">
            <input
              type="checkbox"
              checked={s.enabled}
              disabled={s.scope === "system"}
              onChange={() => void toggle(s)}
            />
            {tr("启用")}
          </label>
          <button
            type="button"
            className="ghost tiny"
            disabled={busy || s.scope === "system"}
            onClick={() => void startEdit(s)}
          >
            {tr("编辑")}
          </button>
          <button
            type="button"
            className="ghost tiny danger"
            disabled={busy || s.scope === "system"}
            onClick={() => void remove(s)}
          >
            {tr("删除")}
          </button>
        </span>
      </div>
      <p className="skill-item-desc">{s.description || tr("无描述")}</p>
    </div>
  );

  const renderGroup = (title: string, items: SkillSummaryDto[], emptyHint: string) => (
    <>
      <h3>{title}</h3>
      <div className="skills-rows">
        {items.length === 0 ? <p className="hint">{emptyHint}</p> : items.map(renderRow)}
      </div>
    </>
  );

  return (
    <div className="form">
      <p className="hint">
        {tr("技能是包含 SKILL.md 的目录：frontmatter 声明名称与描述，正文是给模型的一次性指令。任务匹配时模型会自动调用 use_skill 工具加载正文；系统提示中只注入名称与描述目录。")}
      </p>
      <pre className="skill-format">{SAMPLE_SKILL_MD}</pre>

      {error ? <p className="hint" style={{ color: "var(--danger, #c0392b)" }}>{error}</p> : null}

      {adding && (
        <div className="skill-editor">
          <div className="prompt-toolbar"><strong>{tr("新建技能")}</strong></div>
          <label>
            {tr("作用域")}
            <select value={adding} onChange={(e) => setAdding(e.target.value as SkillScope)}>
              <option value="project">{tr("项目")}</option>
              <option value="user">{tr("用户")}</option>
            </select>
          </label>
          <label>
            {tr("名称")}
            <input
              value={form.name}
              placeholder="my-skill"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <label>
            {tr("描述")}
            <input
              value={form.description}
              placeholder={tr("一句话说明何时使用")}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </label>
          <label>
            {tr("使用时机（when_to_use，可选）")}
            <input
              value={form.whenToUse}
              onChange={(e) => setForm((f) => ({ ...f, whenToUse: e.target.value }))}
            />
          </label>
          <label>
            {tr("正文（Markdown 指令）")}
            <textarea
              rows={10}
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            />
          </label>
          <p className="hint">{tr("正文支持 ${OWNCODER_SKILL_DIR} 变量引用技能目录下的资源文件")}</p>
          <div className="todo-actions">
            <button
              type="button"
              className="ghost"
              disabled={busy || !form.name.trim() || !form.description.trim()}
              onClick={() => void saveNew()}
            >
              {tr("保存")}
            </button>
            <button type="button" className="ghost" onClick={cancelForm}>
              {tr("取消")}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="skill-editor">
          <div className="prompt-toolbar">
            <strong>{tr("编辑技能")}：{editing.name}</strong>
          </div>
          <p className="hint">{editing.path || editing.id}</p>
          <textarea rows={14} value={editRaw} onChange={(e) => setEditRaw(e.target.value)} />
          <p className="hint">{tr("直接编辑完整 SKILL.md（含 frontmatter）；name 必须与技能名一致")}</p>
          <div className="todo-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => void saveEdit()}>
              {tr("保存")}
            </button>
            <button type="button" className="ghost" onClick={cancelForm}>
              {tr("取消")}
            </button>
          </div>
        </div>
      )}

      {renderGroup(tr("项目技能"), project, tr("暂无项目技能"))}
      {!adding && !editing && hasWorkspace ? (
        <button type="button" className="ghost" onClick={() => startAdd("project")}>
          {tr("+ 新建项目技能")}
        </button>
      ) : null}

      {renderGroup(tr("用户技能"), user, tr("暂无用户技能"))}
      {!adding && !editing ? (
        <button type="button" className="ghost" onClick={() => startAdd("user")}>
          {tr("+ 新建用户技能")}
        </button>
      ) : null}

      {renderGroup(tr("内置技能"), system, tr("暂无内置技能"))}
      <p className="hint">{tr("内置技能不可编辑或删除")}</p>
    </div>
  );
}
