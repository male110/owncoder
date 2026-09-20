/**
 * 下载 bge-small-zh-v1.5 INT8 量化模型到本地缓存目录。
 * 运行方式: node apps/desktop/scripts/download-model.mjs
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { get } from "https";

const CACHE_DIR = join(
  process.env.APPDATA || join(process.env.HOME, ".config"),
  "OwnCoder",
  "embedding-cache"
);

const FILES = [
  {
    url: "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json",
    dest: join(CACHE_DIR, "tokenizer.json"),
    name: "tokenizer.json",
  },
  {
    url: "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
    dest: join(CACHE_DIR, "onnx", "model_quantized.onnx"),
    name: "onnx/model_quantized.onnx",
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    function follow(targetUrl) {
      get(targetUrl, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers["content-length"], 10);
        let received = 0;
        const ws = createWriteStream(dest);
        res.pipe(ws);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = Math.round((received / total) * 100);
            process.stdout.write(
              `\r  ${pct}% (${(received / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB)`
            );
          }
        });
        ws.on("finish", () => {
          console.log("");
          resolve();
        });
        ws.on("error", reject);
      }).on("error", reject);
    }
    follow(url);
  });
}

async function main() {
  // 确保目录存在
  mkdirSync(join(CACHE_DIR, "onnx"), { recursive: true });

  for (const file of FILES) {
    if (existsSync(file.dest) && statSync(file.dest).size > 1000) {
      console.log(`✅ ${file.name} 已存在 (${(statSync(file.dest).size / 1024 / 1024).toFixed(2)} MB)`);
      continue;
    }
    console.log(`⬇️  下载 ${file.name} ...`);
    await download(file.url, file.dest);
    const size = statSync(file.dest).size;
    console.log(`✅ ${file.name} 下载完成 (${(size / 1024 / 1024).toFixed(2)} MB)`);
  }

  console.log("\n=== 全部完成 ===");
  console.log(`目录: ${CACHE_DIR}`);
}

main().catch((e) => {
  console.error("❌ 下载失败:", e.message);
  process.exit(1);
});
