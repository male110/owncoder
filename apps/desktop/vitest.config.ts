import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/renderer/src/**/*.test.ts", "src/renderer/src/**/*.test.tsx", "src/renderer/src/**/*.bench.ts", "src/main/terminal/**/*.test.ts", "src/main/__tests__/semantic-eval.test.ts"],
    // 注意：semantic-eval 默认由 ONWCODER_SEMANTIC_EVAL env 门控跳过，不入常规 CI。
    // Keep renderer typecheck exclude in sync: tests are not part of tsconfig.web.
  },
  resolve: {
    alias: {
      // Monaco 只提供浏览器 ESM 入口，测试解析不能使用 Node 的默认包入口。
      "monaco-editor": path.resolve(__dirname, "node_modules/monaco-editor/esm/vs/editor/editor.api.js"),
      "@renderer": path.resolve(__dirname, "src/renderer/src"),
    },
  },
  esbuild: { jsx: "automatic" },
});
