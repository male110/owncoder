import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { AvailableModel, Provider } from "@owncoder/settings";
import type { ChatAttachmentDto } from "../../../../preload/index";
import type { AttachmentItem } from "./types";

export interface AttachmentsApi {
  attachments: AttachmentItem[];
  /** "uploading" | "error" | "success" | "idle" —— 发送/上传按钮据此禁用。 */
  uploadStatus: "idle" | "uploading" | "error" | "success";
  previewUrl: string | null;
  setPreviewUrl: (url: string | null) => void;
  attachmentImageSrc: (item: AttachmentItem) => string | null;
  uploadFile: (file: File) => Promise<void>;
  onFileSelected: (e: ChangeEvent<HTMLInputElement>) => void;
  removeAttachment: (item: AttachmentItem) => void;
  clearAttachments: () => void;
}

/**
 * 附件上传：为图片附件生成本地预览地址；上传成功后优先使用服务器返回的 url。
 * Anthropic 协议模型不接受外链图片，转 base64 data URL 内联。
 */
export function useAttachments(availableModels: AvailableModel[], providers: Provider[]): AttachmentsApi {
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const objectUrls = useMemo(() => {
    const map = new Map<File, string>();
    for (const item of attachments) {
      if (item.file.type.startsWith("image/")) map.set(item.file, URL.createObjectURL(item.file));
    }
    return map;
  }, [attachments]);

  useEffect(() => {
    return () => {
      for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    };
  }, [objectUrls]);

  const attachmentImageSrc = useCallback(
    (item: AttachmentItem) =>
      item.status === "success" && item.result?.url ? item.result.url : objectUrls.get(item.file) ?? null,
    [objectUrls],
  );

  const uploadStatus: AttachmentsApi["uploadStatus"] = attachments.some((item) => item.status === "uploading")
    ? "uploading"
    : attachments.some((item) => item.status === "error")
      ? "error"
      : attachments.length > 0
        ? "success"
        : "idle";

  const uploadFile = useCallback(
    async (file: File) => {
      setAttachments((items) => [...items, { file, status: "uploading" }]);
      try {
        // 获取当前选中模型的协议类型
        const currentModel = availableModels[0];
        const currentProvider = providers.find((p) => p.id === currentModel?.providerId);
        const isAnthropicProtocol = currentProvider?.apiFormat === "anthropic-messages";

        let attachment: ChatAttachmentDto;

        if (isAnthropicProtocol) {
          // Anthropic 协议：转 base64
          const arrayBuffer = await file.arrayBuffer();
          const base64 = btoa(new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ""));
          const dataUrl = `data:${file.type || "application/octet-stream"};base64,${base64}`;
          attachment = {
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            url: dataUrl,
            size: file.size,
          };
        } else {
          // 非 Anthropic 协议：上传图片
          const data = new Uint8Array(await file.arrayBuffer());
          const result = await window.owncoder.uploadFile({ name: file.name, type: file.type, data, provider: "ugcu" });
          attachment = {
            name: result.name || file.name,
            mimeType: file.type || "application/octet-stream",
            url: result.url,
            size: result.size,
          };
        }

        setAttachments((items) =>
          items.map((item) => (item.file === file ? { ...item, status: "success", result: attachment } : item)),
        );
      } catch (error) {
        setAttachments((items) =>
          items.map((item) =>
            item.file === file
              ? { ...item, status: "error", error: error instanceof Error ? error.message : "上传失败，请重试" }
              : item,
          ),
        );
      }
    },
    [availableModels, providers],
  );

  const onFileSelected = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = [...(e.target.files ?? [])];
      e.target.value = "";
      for (const file of files) void uploadFile(file);
    },
    [uploadFile],
  );

  const removeAttachment = useCallback((item: AttachmentItem) => {
    setAttachments((xs) => xs.filter((x) => x !== item));
  }, []);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  return {
    attachments,
    uploadStatus,
    previewUrl,
    setPreviewUrl,
    attachmentImageSrc,
    uploadFile,
    onFileSelected,
    removeAttachment,
    clearAttachments,
  };
}
