// The Cloudflare example under wrangler dev (local workerd): a Durable
// Object serves the page and hosts the live sessions, and every session
// routed to the same object shares its state.
import { afterAll, assert, beforeAll, describe, it } from "vitest"
import WebSocket from "ws"
import { connected, launch, startWrangler } from "../browser/support.ts"

describe("cloudflare durable object", () => {
  let url = ""
  let stop = async () => {}
  beforeAll(async () => ({ url, stop } = await startWrangler()))
  afterAll(() => stop())

  it("serves the page and shares the count between two tabs", async () => {
    const page = await (await fetch(url)).text()
    assert.include(page, "<h1>0</h1>")
    assert.include(page, "Durable Object")

    const browser = await launch()
    try {
      const context = await browser.newContext()
      const a = await context.newPage()
      const b = await context.newPage()
      await a.goto(url)
      await b.goto(url)
      await connected(a)
      await connected(b)
      await a.click("button")
      await a.click("button")
      await a.waitForFunction(() => document.querySelector("h1")!.textContent === "2")
      await b.waitForFunction(() => document.querySelector("h1")!.textContent === "2")
      assert.include(await a.textContent("p"), "Clicked 2 times")
      assert.include(await b.textContent("p"), "Clicked 0 times")
      await b.click("button")
      await a.waitForFunction(() => document.querySelector("h1")!.textContent === "3")
    } finally {
      await browser.close()
    }
  })

  it("refuses upgrades from another origin", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url.replace(/^http/, "ws"), { headers: { Origin: "http://evil.example" } })
      ws.on("unexpected-response", (_, response) => resolve(response.statusCode ?? 0))
      ws.on("open", () => reject(new Error("upgrade was accepted")))
      ws.on("error", (error) => reject(error))
    })
    assert.strictEqual(status, 403)
  })
})
