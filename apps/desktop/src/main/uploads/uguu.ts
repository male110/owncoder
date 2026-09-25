import { UploadError, type UploadProvider, type UploadResult } from "./types";

const UGUU_ENDPOINT = "https://uguu.se/upload.php";
export const UGUU_MAX_FILE_SIZE = 128 * 1024 * 1024;

interface UguuResponse {
  success?: boolean;
  files?: Array<{ url?: unknown; name?: unknown }>;
  error?: unknown;
}

export function parseUguuResponse(value: unknown, fallbackName: string): UploadResult {
  if (!value || typeof value !== "object") throw new UploadError("Uguu 返回了无效响应", "service");
  const body = value as UguuResponse;
  const first = body.files?.[0];
  if (body.success !== true || !first || typeof first.url !== "string" || !/^https?:\/\//i.test(first.url)) {
    const detail = typeof body.error === "string" ? body.error : "上传服务未返回文件链接";
    throw new UploadError(detail, "service");
  }
  return { url: first.url, name: typeof first.name === "string" ? first.name : fallbackName, size: 0, provider: "uguu" };
}

export const uguuProvider: UploadProvider = {
  id: "uguu",
  async upload(file, signal) {
    if (!file.name.trim() || file.data.byteLength === 0) throw new UploadError("请选择有效文件", "invalid_file");
    if (file.data.byteLength > UGUU_MAX_FILE_SIZE) throw new UploadError("文件超过 Uguu 的 128 MB 限制", "too_large");
    const form = new FormData();
    const bytes = new Uint8Array(file.data);
    form.append("files[]", new Blob([bytes.buffer as ArrayBuffer], { type: file.type || "application/octet-stream" }), file.name);
    let response: Response;
    try {
      response = await fetch(UGUU_ENDPOINT, { method: "POST", body: form, signal });
    } catch (error) {
      if (signal?.aborted) throw new UploadError("上传已取消", "cancelled");
      throw new UploadError(error instanceof Error ? error.message : "无法连接上传服务", "network");
    }
    if (!response.ok) throw new UploadError(`Uguu 上传失败（HTTP ${response.status}）`, "service");
    let json: unknown;
    try { json = await response.json(); } catch { throw new UploadError("Uguu 返回了无法解析的响应", "service"); }
    const result = parseUguuResponse(json, file.name);
    return { ...result, size: file.data.byteLength };
  },
};
