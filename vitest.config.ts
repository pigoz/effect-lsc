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
    // browser, protocol and Cloudflare suites need servers, Chromium and
    // wrangler; they run with `bun run test:browser` / `bun run test:node`
    exclude: ["test/browser/**", "test/e2e/**", "node_modules/**"]
  }
})
