// The type errors of common mistakes name the fix. Runs tsc on deliberate
// mistakes (test/types/messages, excluded from the main tsconfig).
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const output = (() => {
  try {
    execFileSync("node_modules/.bin/tsc", ["-p", "test/types/messages/tsconfig.json"], { cwd: root, encoding: "utf8" })
    return ""
  } catch (error) {
    return String((error as { stdout?: string }).stdout)
  }
})()
const at = (line: number) => output.split("\n").filter((l) => l.startsWith(`test/types/messages/mistakes.tsx(${line},`)).length > 0

describe("type error messages", () => {
  it("a component with services used as a tag says to bring it in with View.use", () => {
    assert.isTrue(at(21))
    assert.include(output, "effect-lsc: bring it in with View.use")
  })
  it("a component requiring Scope says to acquire resources with View.once", () => {
    assert.isTrue(at(22))
    assert.include(output, "effect-lsc: this component requires Scope; acquire resources with View.once")
  })
  it("a recovery handler using View.State says to return a component instead", () => {
    assert.isTrue(at(23))
    assert.include(output, "effect-lsc: recovery runs outside the instance; return a component that uses View.State instead")
  })
  it("a root with a typed error left names the unhandled errors", () => {
    assert.isTrue(at(24))
    assert.include(output, `"effect-lsc: unhandled errors": NotFound`)
  })
  it("a Cloudflare layer that lacks a service names the missing services", () => {
    assert.isTrue(at(25))
    assert.include(output, `"effect-lsc: missing services": Db`)
  })
  it("a root requiring Scope says to acquire resources with View.once", () => {
    assert.isTrue(at(26))
    assert.include(output, "effect-lsc: this component requires Scope; acquire resources with View.once")
  })
  it("a View.provide layer using View.State says to use View.SharedState", () => {
    assert.isTrue(at(27))
    assert.include(output, "effect-lsc: a View.provide layer runs outside the instance; use View.SharedState instead of View.State")
  })
})
