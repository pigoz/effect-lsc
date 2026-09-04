import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Browser tests: real Chromium against the fixture page and the examples.
// Run with `bun run test:browser`; needs `bunx playwright install chromium`.
export default defineConfig({
  resolve: {
    alias: {
      "effect-lsc": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    include: ["test/browser/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false
  }
})
