import { useState } from "react";
import type { RedactionPreviewDto } from "../../../preload/index";
import { useI18n } from "../i18n";

export function SecurityRedactionTest() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RedactionPreviewDto | null>(null);
  const { t } = useI18n();

  const testFile = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await window.owncoder.pickAndPreviewRedaction());
    } catch (error) {
      setResult({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const hasResult = result?.status === "success";
  const scopeLabel = hasResult && result.redactionScope === "whole-file"
    ? t("整文件保护")
    : t("仅敏感字段");

  return (
    <section className="security-redaction-test" aria-labelledby="redaction-test-heading">
      <div className="security-test-heading">
        <div>
          <h3 id="redaction-test-heading">{t("脱敏测试")}</h3>
          <p className="hint">
            {t("选择任意本地文本文件，使用当前已保存的规则生成安全预览。原文件不会被修改，也不会发送给模型。")}
          </p>
        </div>
        <button type="button" className="ghost" disabled={busy} onClick={() => void testFile()}>
          {busy ? t("正在检测…") : result ? t("重新选择文件") : t("选择文件测试")}
        </button>
      </div>

      {result?.status === "cancelled" && (
        <p className="security-test-neutral" role="status">{t("已取消本次测试。")}</p>
      )}

      {result?.status === "error" && (
        <div className="security-test-error" role="alert">{result.message}</div>
      )}

      {hasResult && (
        <div className="security-test-result">
          <div className="security-test-result-header">
            <div>
              <span className="security-test-eyebrow">{t("检查完成")}</span>
              <strong>{result.fileName}</strong>
              <span className="security-test-path">{result.filePath}</span>
            </div>
            <span className={`security-test-scope ${result.redactionScope}`}>{scopeLabel}</span>
          </div>

          <div className="security-test-summary" role="status">
            {result.fileRuleMatched
              ? result.redactionScope === "whole-file"
                ? t("文件命中整文件保护规则，非空内容已全部遮罩。")
                : t("文件受保护；已仅检测和遮罩账号、密码、令牌、密钥及连接凭据。")
              : t("未命中文件规则，已执行敏感字段检测，可用于验证自定义正则。")}
            {!result.redacted && t(" 未发现需要遮罩的值。")}
          </div>

          {result.reasons.length > 0 && (
            <div className="security-test-rule-list" aria-label={t("命中的脱敏规则")}>
              {result.reasons.map((reason) => <span key={reason}>{reason}</span>)}
            </div>
          )}

          <div className="security-test-preview-label">
            <strong>{t("安全预览")}</strong>
            <span>{t("仅展示处理后的内容")}</span>
          </div>
          <pre className="security-test-output">{result.content || t("（文件内容为空）")}</pre>
          {result.truncated && (
            <p className="security-test-truncated">{t("预览仅显示前 80 KB；完整文件已按相同规则完成检测。")}</p>
          )}
        </div>
      )}
    </section>
  );
}
