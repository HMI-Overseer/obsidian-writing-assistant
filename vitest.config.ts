import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The suite tests the shipped plugin, so it compiles the same branch a release does: the
  // driver's guarded call sites are dead here, and `src/dev/` is only ever imported directly
  // by the tests that cover it.
  define: { DEV_DRIVER: "false" },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/__mocks__/obsidian.ts"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      all: true,
    },
  },
});
