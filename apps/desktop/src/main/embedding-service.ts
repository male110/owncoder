/**
 * 共享嵌入服务（bge-small-zh-v1.5，INT8 量化，512 维）。
 *
 * 从 history-vector.ts 抽取：会话历史向量与代码语义索引（chunk 嵌入 +
 * ragSearch 查询嵌入）共用同一个 ONNX 会话——每进程单例，模型只加载一次。
 *
 * 本模块刻意不 import electron（index-worker 是 UtilityProcess，无 electron
 * app 模块）：模型目录由调用方 configure（main 进程计算后传入，worker 经
 * open 消息携带）。任何环节失败都抛出，调用方负责捕获并降级。
 */

import * as ort from "onnxruntime-node";
import { Tokenizer } from "@huggingface/tokenizers";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "node:path";

/** bge-small-zh-v1.5 输出维度；vec0 表与历史向量共用此契约值。 */
export const EMBEDDING_DIM = 512;
const DIM = EMBEDDING_DIM;
/** bge-small-zh-v1.5 / BERT 位置编码上限；超长序列必须截断，否则 ONNX Add 广播失败（如 512 by 577）。 */
const MAX_SEQ_LEN = 512;

let cacheDir = "";

/**
 * 配置本地模型目录。目录中必须包含：
 *   - tokenizer.json
 *   - onnx/model_quantized.onnx（INT8 量化版 bge-small-zh-v1.5）
 */
export function configureEmbeddingCacheDir(dir: string): void {
  cacheDir = dir;
}

/** 模型目录是否就绪（tokenizer + ONNX 都在）。构建侧端口创建前的预检。 */
export function embeddingModelAvailable(): boolean {
  if (!cacheDir) return false;
  return (
    fsSync.existsSync(path.join(cacheDir, "tokenizer.json")) &&
    (fsSync.existsSync(path.join(cacheDir, "onnx", "model_quantized.onnx")) ||
      fsSync.existsSync(path.join(cacheDir, "onnx", "model_int8.onnx")))
  );
}

function resolveLocalModelFiles(): { modelPath: string; tokenizerPath: string } {
  if (!cacheDir) {
    throw new Error(
      "[embedding] 未配置模型目录，请先调用 configureEmbeddingCacheDir()",
    );
  }

  const tokenizerPath = path.join(cacheDir, "tokenizer.json");
  const onnxDir = path.join(cacheDir, "onnx");
  const modelQuantized = path.join(onnxDir, "model_quantized.onnx");
  const modelInt8 = path.join(onnxDir, "model_int8.onnx");
  const modelPath = fsSync.existsSync(modelQuantized)
    ? modelQuantized
    : fsSync.existsSync(modelInt8)
      ? modelInt8
      : modelQuantized; // 都不存在时指向标准名称，下面报错

  const missing: string[] = [];
  if (!fsSync.existsSync(tokenizerPath)) missing.push("tokenizer.json");
  if (!fsSync.existsSync(modelPath)) missing.push("onnx/model_quantized.onnx 或 onnx/model_int8.onnx");

  if (missing.length > 0) {
    throw new Error(
      `[embedding] 本地模型文件缺失: ${missing.join(", ")}\n` +
        `请将以下文件放入 ${cacheDir}:\n` +
        `  - tokenizer.json\n` +
        `  - onnx/model_quantized.onnx 或 onnx/model_int8.onnx\n` +
        `下载地址: https://huggingface.co/Xenova/bge-small-zh-v1.5/tree/main`,
    );
  }

  return { modelPath, tokenizerPath };
}

/**
 * bge-small INT8 嵌入服务。
 *
 * 内存优势（同历史向量服务）：
 * - INT8 量化模型仅 ~25MB（FP32 约 ~90MB）
 * - onnxruntime-node 原生 C++ 内存管理，不占 V8 堆
 * - 无 JS 张量对象开销，推理完成后直接返回 Float32Array
 */
export class BgeEmbeddingService {
  private session: ort.InferenceSession | null = null;
  private tokenizer: Tokenizer | null = null;
  private initPromise: Promise<void> | null = null;

  private async ensureInit(): Promise<void> {
    if (this.session && this.tokenizer) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const { modelPath, tokenizerPath } = resolveLocalModelFiles();

        console.log("[embedding] 加载 INT8 ONNX 模型...");
        this.session = await ort.InferenceSession.create(modelPath, {
          // 限制推理线程数，避免嵌入占满所有 CPU 核心
          intraOpNumThreads: 2,
          interOpNumThreads: 2,
          // 关闭 CPU 内存池，降低常驻内存占用
          graphOptimizationLevel: "basic",
          enableCpuMemArena: false,
        });
        console.log("[embedding] ONNX 模型已加载（INT8 量化，2 线程）");

        console.log("[embedding] 加载 tokenizer...");
        const tokenizerJson = JSON.parse(await fs.readFile(tokenizerPath, "utf-8"));
        this.tokenizer = new Tokenizer(tokenizerJson, {});
        console.log("[embedding] Tokenizer 已加载");
      } catch (error) {
        // 重置，允许重试
        this.initPromise = null;
        throw error;
      }
    })();

    await this.initPromise;
  }

  async embed(text: string): Promise<Float32Array> {
    return (await this.embedBatch([text]))[0]!;
  }

  /**
   * 批量嵌入（代码 chunk 构建侧的主路径）：一次 tokenize + 一次 ONNX run。
   * 批次内序列对齐到本批最大长度（上限 MAX_SEQ_LEN），attention_mask 掩码填充位。
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.ensureInit();

    // tokenizers 0.2.0 仅有同步逐条 encode()；ONNX 推理仍统一为 [N, seqLen]
    // 张量批次（tokenize 逐条、模型批量——批收益在推理层）。
    const encodings = texts.map((t) => this.tokenizer!.encode(t, { add_special_tokens: true }));
    const seqLen = Math.min(
      MAX_SEQ_LEN,
      Math.max(1, ...encodings.map((e) => e.ids.length)),
    );
    const n = texts.length;
    const inputIds = new BigInt64Array(n * seqLen);
    const attentionMask = new BigInt64Array(n * seqLen);
    const tokenTypeIds = new BigInt64Array(n * seqLen);

    encodings.forEach((encoding, i) => {
      // BERT 位置编码表长度为 MAX_SEQ_LEN；保留 [CLS] + 正文 + [SEP]，截断中间正文。
      let ids = encoding.ids;
      let mask = encoding.attention_mask;
      if (ids.length > MAX_SEQ_LEN) {
        ids = ids.slice(0, MAX_SEQ_LEN - 1).concat(ids[ids.length - 1]!);
        mask = mask.slice(0, MAX_SEQ_LEN - 1).concat(mask[mask.length - 1]!);
      }
      for (let t = 0; t < seqLen; t++) {
        const ok = t < ids.length;
        inputIds[i * seqLen + t] = BigInt(ok ? ids[t]! : 0);
        attentionMask[i * seqLen + t] = BigInt(ok ? mask[t]! : 0);
        // token_type_ids 全 0（单句输入）
      }
    });

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", inputIds, [n, seqLen]),
      attention_mask: new ort.Tensor("int64", attentionMask, [n, seqLen]),
      token_type_ids: new ort.Tensor("int64", tokenTypeIds, [n, seqLen]),
    };

    const results = await this.session!.run(feeds);
    const outputTensor = results.last_hidden_state ?? results[Object.keys(results)[0]!];
    const hidden = outputTensor.data as Float32Array; // [n, seqLen, DIM]

    // Mean Pooling（按 attention_mask 加权）+ L2 归一化，逐条返回。
    const out: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      const pooled = new Float32Array(DIM);
      let validTokens = 0;
      for (let t = 0; t < seqLen; t++) {
        if (!attentionMask[i * seqLen + t]) continue;
        validTokens++;
        for (let d = 0; d < DIM; d++) {
          pooled[d] += hidden[(i * seqLen + t) * DIM + d]!;
        }
      }
      if (validTokens > 0) {
        for (let d = 0; d < DIM; d++) pooled[d] /= validTokens;
      }
      let norm = 0;
      for (let d = 0; d < DIM; d++) norm += pooled[d]! * pooled[d]!;
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let d = 0; d < DIM; d++) pooled[d]! /= norm;
      }
      out.push(pooled);
    }
    return out;
  }
}

/** 每进程共享的 bge 会话（历史向量与代码语义索引共用，模型只加载一次）。 */
let sharedService: BgeEmbeddingService | null = null;
export function getSharedEmbeddingService(): BgeEmbeddingService {
  if (!sharedService) sharedService = new BgeEmbeddingService();
  return sharedService;
}
