import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const workspaceAliases = {
  "@owncoder/shared": resolve("../../packages/shared/src/index.ts"),
  "@owncoder/settings": resolve("../../packages/settings/src/index.ts"),
  "@owncoder/index": resolve("../../packages/index/src/index.ts"),
  "@owncoder/core": resolve("../../packages/core/src/index.ts"),
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
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
        },
      },
    },
    plugins: [react()],
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