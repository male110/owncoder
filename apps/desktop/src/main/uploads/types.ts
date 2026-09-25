export interface UploadFileInput {
  name: string;
  type: string;
  data: Uint8Array;
}

export interface UploadResult {
  url: string;
  name: string;
  size: number;
  provider: string;
  mimeType?: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_file" | "too_large" | "network" | "service" | "cancelled",
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export interface UploadProvider {
  readonly id: string;
  upload(file: UploadFileInput, signal?: AbortSignal): Promise<UploadResult>;
}
