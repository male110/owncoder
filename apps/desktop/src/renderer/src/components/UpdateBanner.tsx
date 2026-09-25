import { useCallback, useEffect, useState } from "react";
import type { UpdateDownloadStatusDto, UpdateInfoDto } from "../../../preload/index";
import { useI18n } from "../i18n";

/**
 * 新版本提示条。
 *
 * 主进程在启动后（仅打包版）和每 4 小时自动检测更新并通过
 * `updates:available` 推送；这里同时兜底主动查询一次，覆盖
 * 开发模式与启动期网络抖动。
 *
 * 打包版 Windows 支持应用内自动下载：
 *   发现新版本 → 「立即更新」→ 后台下载（显示进度）→ 「安装并重启」
 *   下载失败或非打包环境 → 回退为「在浏览器中下载」打开安装包直链。
 */
const RE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const NOTES_PREVIEW_LEN = 120;

/** 把 markdown 发布说明压成单行纯文本摘要，太长则截断。 */
function toNotesPreview(notes?: string): string | null {
  if (!notes) return null;
  const plain = notes
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  return plain.length > NOTES_PREVIEW_LEN
    ? `${plain.slice(0, NOTES_PREVIEW_LEN)}…`
    : plain;
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfoDto | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<UpdateDownloadStatusDto | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    let disposed = false;
    const api = window.owncoder;
    if (!api?.checkForUpdate) return;
    const applyIfAvailable = (outcome: { status: string; info?: UpdateInfoDto }): void => {
      if (!disposed && outcome.status === "update-available" && outcome.info) {
        setInfo(outcome.info);
        setDismissed(false);
      }
    };
    // 渲染层兜底：主进程推送可能因启动期网络抖动而缺失（开发模式也不推送）。
    void api.checkForUpdate().then(applyIfAvailable).catch(() => {
      /* 网络失败静默，交给下一轮定时检查 */
    });
    const offAvailable = api.onUpdateAvailable((update) => {
      if (!disposed) {
        setInfo(update);
        setDismissed(false);
      }
    });
    const offStatus = api.onUpdateDownloadStatus((s) => {
      if (disposed) return;
      setStatus(s);
      // 下载完成后即使之前点过"稍后"也重新亮出安装按钮
      if (s.state === "downloaded") setDismissed(false);
    });
    const timer = setInterval(() => {
      void api.checkForUpdate().then(applyIfAvailable).catch(() => {
        /* 静默重试 */
      });
    }, RE_CHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      offAvailable();
      offStatus();
    };
  }, []);

  const handleDownload = useCallback(() => {
    if (!info) return;
    if (!info.canAutoUpdate) {
      // dev 或非 Windows：直接去浏览器下载安装包
      window.owncoder.openUpdateDownload(info.downloadUrl);
      setDismissed(true);
      return;
    }
    setStatus({ state: "downloading", percent: 0 });
    void window.owncoder.startUpdateDownload().catch(() => {
      /* 失败会通过 downloadStatus 推送 failed */
    });
  }, [info]);

  if (!info || dismissed) return null;

  const notesPreview = toNotesPreview(info.notes);
  const downloading = status?.state === "downloading";
  const downloaded = status?.state === "downloaded";
  const failed = status?.state === "failed";

  return (
    <div className="update-banner" role="note" aria-label={t("发现新版本")}>
      <div className="update-banner-body">
        <strong>{t("发现新版本 v{{version}}", { version: info.version })}</strong>
        {notesPreview ? <p className="update-banner-notes">{notesPreview}</p> : null}
        {downloading ? (
          <div className="update-banner-progress" aria-hidden>
            <div
              className="update-banner-progress-bar"
              style={{ width: `${status.percent < 0 ? 2 : Math.max(2, Math.min(100, status.percent))}%` }}
            />
          </div>
        ) : null}
        {downloaded ? <p className="update-banner-hint">{t("已下载完成，安装后自动重启")}</p> : null}
        {failed ? (
          <p className="update-banner-hint warn">{t("自动下载失败，可手动下载安装包")}</p>
        ) : null}
      </div>
      <div className="update-banner-actions">
        {downloading ? (
          <button type="button" className="ghost" disabled>
            {status.percent < 0 ? t("下载中…") : t("下载中 {{percent}}%", { percent: status.percent })}
          </button>
        ) : downloaded ? (
          <button
            type="button"
            className="ghost accent"
            onClick={() => window.owncoder.installUpdate()}
          >
            {t("安装并重启")}
          </button>
        ) : failed ? (
          <button
            type="button"
            className="ghost accent"
            onClick={() => {
              window.owncoder.openUpdateDownload(info.downloadUrl);
              setDismissed(true);
            }}
          >
            {t("下载安装包")}
          </button>
        ) : (
          <button type="button" className="ghost accent" onClick={handleDownload}>
            {info.canAutoUpdate ? t("立即更新") : t("打开下载页")}
          </button>
        )}
        {!downloading ? (
          <button type="button" className="ghost" onClick={() => setDismissed(true)}>
            {t("稍后")}
          </button>
        ) : null}
      </div>
    </div>
  );
}