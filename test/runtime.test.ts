import { assert, describe, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { script as readable } from "../src/internal/browser.ts"
import { script as minified, source } from "../src/internal/runtime.ts"

describe("runtime", () => {
  it("the minified runtime is built from the current browser.ts", () => {
    const current = createHash("sha256").update(readable).digest("hex")
    assert.strictEqual(source, current, "src/internal/runtime.ts is stale: run `bun run runtime`")
    assert.isBelow(minified.length, readable.length)
    assert.include(minified, "data-lsc-root")
    assert.include(minified, "window.lsc")
  })
})
