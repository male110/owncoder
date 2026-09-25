import { ipcMain } from "electron";
import { uguuProvider } from "./uguu";
import type { UploadFileInput } from "./types";

const providers = new Map([[uguuProvider.id, uguuProvider]]);

export function registerUploadHandlers(): void {
  ipcMain.handle("upload:file", async (_event, input: { provider?: string; name?: string; type?: string; data?: Uint8Array }) => {
    const raw = input?.data;
    const data = raw instanceof Uint8Array ? raw : null;
    if (!input || typeof input.name !== "string" || !data) {
      throw new Error("上传文件数据无效");
    }
    const provider = providers.get(input.provider ?? "uguu");
    if (!provider) throw new Error(`未知上传服务: ${input.provider}`);
    const file: UploadFileInput = { name: input.name, type: input.type ?? "", data };
    return provider.upload(file);
  });
}
