import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "effect-lsc": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // the browser suite needs Chromium and runs with `bun run test:browser`
    exclude: ["test/browser/**", "node_modules/**"]
  }
})
