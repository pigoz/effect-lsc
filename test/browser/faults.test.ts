import { afterAll, assert, beforeAll, describe, it } from "vitest"
import { connected, type Harness, open } from "./support.ts"

let h: Harness
beforeAll(async () => {
  h = await open("test/browser/fixtures/faults.tsx")
  await connected(h.page)
  await h.page.evaluate(() => {
    const w = window as any
    w.__errors = []
    window.addEventListener("lsc:error", (e) => w.__errors.push((e as CustomEvent).detail))
  })
})
afterAll(async () => {
  await h?.stop()
})

const errors = () => h.page.evaluate(() => (window as any).__errors.splice(0))
const rootAttr = (name: string) => h.page.evaluate((n) => document.querySelector("[data-lsc-root]")!.getAttribute(n), name)

describe("failures in the browser", () => {
  it("a handler failure raises lsc:error and marks the root until the next render", async () => {
    await h.page.click("#handler-fail")
    await h.page.waitForFunction(() => (window as any).__errors.length > 0)
    const [error] = await errors()
    assert.strictEqual(error.scope, "handler")
    assert.include(error.message, "handler failed on purpose")
    // the failing handler had incremented first: that render arrives and clears the mark
    await h.page.waitForFunction(() => document.querySelector("#count")!.textContent === "1")
    assert.isNull(await rootAttr("data-lsc-error"))
  })

  it("a contained render failure shows the fallback and leaves the page interactive", async () => {
    await h.page.click("#risky")
    await h.page.click("#risky")
    await h.page.waitForSelector("#fallback")
    await h.page.click("#inc")
    await h.page.waitForFunction(() => document.querySelector("#count")!.textContent === "2")
  })

  it("an uncontained render failure ends the session and the runtime remounts a fresh one", async () => {
    await h.page.click("#render-fail")
    await h.page.waitForFunction(() => (window as any).__errors.some((e: any) => e.scope === "render"))
    // the server closed the socket: disconnected, then reconnected into a fresh session
    await h.page.waitForFunction(() => document.querySelector("#count")!.textContent === "0", null, { timeout: 10000 })
    await connected(h.page)
    assert.isNull(await rootAttr("data-lsc-error"))
    await h.page.click("#inc")
    await h.page.waitForFunction(() => document.querySelector("#count")!.textContent === "1")
  })
})
