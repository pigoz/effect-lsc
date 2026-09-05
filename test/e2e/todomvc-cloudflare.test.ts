import { afterAll, assert, beforeAll, describe, it } from "vitest"
import { connected, launch, startWrangler } from "../browser/support.ts"

describe("TodoMVC on Cloudflare", () => {
  let url = ""
  let stop = async () => {}
  beforeAll(async () => ({ url, stop } = await startWrangler("todomvc-cloudflare")))
  afterAll(() => stop())

  it("shares todo changes while keeping filters local to each tab", async () => {
    const html = await (await fetch(url)).text()
    assert.include(html, "<h1>todos</h1>")
    assert.include(html, "TodoMVC · effect-lsc")

    const browser = await launch()
    try {
      const context = await browser.newContext()
      // Interactions must also work without the externally hosted styles.
      await context.route("https://cdn.jsdelivr.net/**", (route) => route.abort())
      const a = await context.newPage()
      const b = await context.newPage()
      await a.goto(url)
      await b.goto(url)
      await connected(a)
      await connected(b)

      await a.fill(".new-todo", "Learn Effect")
      await a.press(".new-todo", "Enter")
      await b.waitForSelector(".todo-list li")
      assert.strictEqual(await b.textContent(".todo-list label"), "Learn Effect")

      await b.dblclick(".todo-list label")
      await b.fill(".edit", "Build a todo app")
      await b.press(".edit", "Enter")
      await a.waitForFunction(() => document.querySelector(".todo-list label")?.textContent === "Build a todo app")

      await b.click('a[href="#/active"]')
      await b.waitForSelector('a.selected[href="#/active"]')
      await a.check(".toggle")
      await a.waitForSelector(".todo-list li.completed")
      await b.waitForFunction(() => document.querySelectorAll(".todo-list li").length === 0)
      assert.strictEqual(await a.getAttribute(".filters .selected", "href"), "#/all")
      assert.include(await b.textContent(".todo-count"), "0 items left")

      await b.click(".clear-completed")
      await a.waitForFunction(() => document.querySelectorAll(".todo-list li").length === 0)
      await b.waitForSelector(".footer", { state: "detached" })
    } finally {
      await browser.close()
    }
  })
})
