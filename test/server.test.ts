import { assert, describe, it } from "@effect/vitest"
import { originAllowed } from "../src/internal/server.ts"

describe("originAllowed", () => {
  it("allows the page's own origin by default and refuses others", () => {
    assert.isTrue(originAllowed("http://localhost:3000", "localhost:3000", undefined))
    assert.isTrue(originAllowed("https://app.example", "app.example", undefined))
    assert.isFalse(originAllowed("http://evil.example", "localhost:3000", undefined))
    assert.isFalse(originAllowed("http://localhost:3001", "localhost:3000", undefined))
    assert.isFalse(originAllowed("null", "localhost:3000", undefined))
    assert.isFalse(originAllowed("http://localhost:3000", undefined, undefined))
  })
  it("allows non-browser clients, which send no Origin", () => {
    assert.isTrue(originAllowed(undefined, "localhost:3000", undefined))
    assert.isTrue(originAllowed(undefined, "localhost:3000", ["https://app.example"]))
  })
  it("accepts an explicit list or a predicate", () => {
    assert.isTrue(originAllowed("https://app.example", "api.example", ["https://app.example"]))
    assert.isFalse(originAllowed("https://other.example", "api.example", ["https://app.example"]))
    assert.isTrue(originAllowed("https://x.example", "api.example", (o) => o.endsWith(".example")))
    assert.isFalse(originAllowed("https://x.evil", "api.example", (o) => o.endsWith(".example")))
  })
})
