import type { RuleFileDto } from "../../../preload/index";
import { useI18n } from "../i18n";

export function RulesTab({
  hasWorkspace,
  rules,
  selectedRule,
  ruleBody,
  newRuleName,
  busy,
  onOpenRule,
  onDeleteRule,
  onCreateRule,
  onRuleBodyChange,
  onNewRuleNameChange,
}: {
  hasWorkspace: boolean;
  rules: RuleFileDto[];
  selectedRule: string | null;
  ruleBody: string;
  newRuleName: string;
  busy: boolean;
  onOpenRule: (name: string) => void;
  onDeleteRule: () => void;
  onCreateRule: () => void;
  onRuleBodyChange: (value: string) => void;
  onNewRuleNameChange: (value: string) => void;
}) {
  const { t: tr } = useI18n();

  return (
    <div className="form rules-form">
      <p className="hint">
        {tr("项目级规则存于 ")}<code>.owncoder/rules/*.md</code>{tr("，按文件名排序合并后注入系统提示（有预算截断）。不属于用户工作流，一键还原不会删除。")}
      </p>
      {!hasWorkspace ? (
        <p className="hint">{tr("请先打开工作区文件夹。")}</p>
      ) : (
        <>
          <div className="rules-layout">
            <div className="rules-list">
              {rules.length === 0 ? (
                <p className="hint">{tr("暂无规则文件")}</p>
              ) : (
                rules.map((r) => (
                  <button
                    key={r.name}
                    type="button"
                    className={selectedRule === r.name ? "rule-item active" : "rule-item"}
                    onClick={() => onOpenRule(r.name)}
                  >
                    {r.name}
                  </button>
                ))
              )}
            </div>
            <div className="rules-editor">
              {selectedRule ? (
                <>
                  <div className="prompt-toolbar">
                    <strong>{selectedRule}</strong>
                    <button type="button" className="ghost" disabled={busy} onClick={onDeleteRule}>
                      {tr("删除")}
                    </button>
                  </div>
                  <textarea
                    rows={14}
                    value={ruleBody}
                    onChange={(e) => onRuleBodyChange(e.target.value)}
                  />
                </>
              ) : (
                <p className="hint">{tr("选择左侧文件，或新建规则。")}</p>
              )}
            </div>
          </div>
          <div className="todo-actions">
            <input
              value={newRuleName}
              placeholder={tr("新规则.md")}
              onChange={(e) => onNewRuleNameChange(e.target.value)}
              style={{ flex: 1, minWidth: 120 }}
            />
            <button type="button" className="ghost" disabled={busy} onClick={onCreateRule}>
              {tr("新建")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
