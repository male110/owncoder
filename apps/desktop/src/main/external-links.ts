import { shell, type WebContents } from "electron";

export function registerExternalLinks(webContents: Pick<WebContents, "setWindowOpenHandler">): void {
  webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === "http:" || target.protocol === "https:") {
        void shell.openExternal(target.href).catch(() => {
          console.error("无法使用默认浏览器打开链接");
        });
      }
    } catch {
      // 无效链接不交给系统处理。
    }
    return { action: "deny" };
  });
}
