import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const workspaceAliases = {
  "@owncoder/shared": resolve("../../packages/shared/src/index.ts"),
  "@owncoder/settings": resolve("../../packages/settings/src/index.ts"),
  "@owncoder/index": resolve("../../packages/index/src/index.ts"),
  "@owncoder/core": resolve("../../packages/core/src/index.ts"),
  // core 深层导入需显式映射，否则会被拼接到 index.ts 后面变成 index.ts/harness/...
  "@owncoder/core/harness/lsp-client.ts": resolve("../../packages/core/src/harness/lsp-client.ts"),
  // browser 子路径必须排在主入口之前，避免被 "@owncoder/llm" 前缀误匹配
  "@owncoder/llm/browser": resolve("../../packages/llm/src/browser.ts"),
  "@owncoder/llm": resolve("../../packages/llm/src/index.ts"),
};

const excludeWorkspace = [
  "@owncoder/shared",
  "@owncoder/settings",
  "@owncoder/index",
  "@owncoder/core",
  "@owncoder/llm",
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ 
      exclude: excludeWorkspace,
      // better-sqlite3必须被externalize，因为它是native模块
      include: ['better-sqlite3']
    })],
    resolve: { alias: workspaceAliases },
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "index-worker": resolve("src/main/index-worker.ts"),
        },
        // 显式标记better-sqlite3为external
        external: ['better-sqlite3']
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ 
      exclude: excludeWorkspace,
      // better-sqlite3在preload中也需要externalize
      include: ['better-sqlite3']
    })],
    resolve: { alias: workspaceAliases },
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
        },
        // 显式标记better-sqlite3为external
        external: ['better-sqlite3']
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    worker: {
      format: "es",
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
        },
      },
    },
    plugins: [react()],
    // 预优化 monaco-editor 依赖，避免首次加载时触发页面重载
    optimizeDeps: {
      include: [
        "monaco-editor",
        "monaco-editor/esm/vs/editor/editor.worker",
        "monaco-editor/esm/vs/language/typescript/ts.worker",
        "monaco-editor/esm/vs/language/json/json.worker",
        "monaco-editor/esm/vs/language/css/css.worker",
        "monaco-editor/esm/vs/language/html/html.worker",
      ],
    },
    server: {
      watch: {
        ignored: ["**/node_modules/**", "**/out/**", "**/release/**"],
      },
    },
    resolve: {
      alias: {
        ...workspaceAliases,
        "@renderer": resolve("src/renderer/src"),
      },
    },
  },
});