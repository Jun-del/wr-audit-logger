import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    globalSetup: ["tests/setup/global-setup.ts"],
    setupFiles: ["tests/setup/env.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
      exclude: ["tests/**", "dist/**", "**/*.config.ts"],
    },
  },
});
