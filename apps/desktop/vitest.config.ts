import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/renderer/src/**/*.test.ts", "src/renderer/src/**/*.bench.ts"],
    // Keep renderer typecheck exclude in sync: tests are not part of tsconfig.web.
  },
  resolve: {
    alias: {
      "@renderer": path.resolve(__dirname, "src/renderer/src"),
    },
  },
});
