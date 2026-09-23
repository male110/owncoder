/**
 * 替代原生 window.confirm() 的自定义确认弹窗。
 * 原生 confirm 会阻塞主线程并导致输入框失焦，此实现基于 div 异步弹窗。
 */
import { t } from "../../../shared/i18n/core";
export function customConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    // 创建遮罩层
    const overlay = document.createElement("div");
    overlay.className = "custom-confirm-overlay";

    // 创建弹窗容器
    const dialog = document.createElement("div");
    dialog.className = "custom-confirm-dialog";

    // 消息文本
    const msg = document.createElement("div");
    msg.className = "custom-confirm-message";
    msg.textContent = message;

    // 按钮容器
    const btns = document.createElement("div");
    btns.className = "custom-confirm-buttons";

    const btnOk = document.createElement("button");
    btnOk.className = "custom-confirm-btn custom-confirm-btn-ok";
    btnOk.textContent = t("确定");

    const btnCancel = document.createElement("button");
    btnCancel.className = "custom-confirm-btn custom-confirm-btn-cancel";
    btnCancel.textContent = t("取消");

    btns.appendChild(btnCancel);
    btns.appendChild(btnOk);

    dialog.appendChild(msg);
    dialog.appendChild(btns);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // 聚焦取消按钮（与原生 confirm 行为一致：默认焦点在"取消"上）
    btnCancel.focus();

    const cleanup = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };

    btnOk.addEventListener("click", () => cleanup(true));
    btnCancel.addEventListener("click", () => cleanup(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false); // 点击遮罩关闭
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Enter") cleanup(true);
    });
  });
}
