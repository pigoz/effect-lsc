import { afterAll, assert, beforeAll, describe, it } from "vitest"
import { connected, type Harness, open, settle, takeMorphs, traceMorphs } from "./support.ts"

describe("counter fixture", () => {
  let h: Harness
  beforeAll(async () => {
    h = await open("test/browser/fixtures/counter.tsx")
    await connected(h.page)
  })
  afterAll(async () => {
    await h?.stop()
  })

  it("counts server-side clicks", async () => {
    for (let i = 0; i < 3; i++) await h.page.click("button")
    await h.page.waitForFunction(() => document.querySelector("h1")!.textContent === "3")
  })
})

describe("todomvc fixture (the example components)", () => {
  let h: Harness
  beforeAll(async () => {
    h = await open("test/browser/fixtures/todomvc.tsx")
    await connected(h.page)
    await traceMorphs(h.page)
  })
  afterAll(async () => {
    await h?.stop()
  })

  const labels = () => h.page.evaluate(() => Array.from(document.querySelectorAll("li label")).map((l) => l.textContent))

  it("adds, toggles, filters, and keeps the footer in sync (memoized footer regression)", async () => {
    await h.page.fill(".new-todo", "one")
    await h.page.keyboard.press("Enter")
    await h.page.fill(".new-todo", "two")
    await h.page.keyboard.press("Enter")
    await h.page.waitForFunction(() => document.querySelectorAll("li label").length === 2)
    assert.strictEqual(await h.page.inputValue(".new-todo"), "")
    await takeMorphs(h.page)
    await h.page.click("li:nth-child(1) .toggle")
    await h.page.waitForFunction(() => document.querySelectorAll("li.completed").length === 1)
    assert.deepStrictEqual([...new Set(await takeMorphs(h.page))].sort(), ["FOOTER", "LI"])
    await h.page.click("a[href='#/active']")
    await h.page.waitForFunction(() => document.querySelector("a.selected")?.getAttribute("href") === "#/active")
    assert.deepStrictEqual(await labels(), ["two"])
    await h.page.click("a[href='#/all']")
    await h.page.waitForFunction(() => document.querySelectorAll("li label").length === 2)
    await settle(h.page)
  })

  it("shares the list with another tab", async () => {
    const other = await h.context.newPage()
    await other.goto(h.url)
    await connected(other)
    await other.fill(".new-todo", "from other tab")
    await other.keyboard.press("Enter")
    await other.close()
    await h.page.waitForFunction(() => Array.from(document.querySelectorAll("li label")).some((l) => l.textContent === "from other tab"))
    assert.deepStrictEqual(await labels(), ["one", "two", "from other tab"])
  })
})

describe("atom-search fixture (the example components)", () => {
  let h: Harness
  beforeAll(async () => {
    h = await open("test/browser/fixtures/atom-search.tsx")
    await connected(h.page)
  })
  afterAll(async () => {
    await h?.stop()
  })

  const items = (page = h.page) => page.evaluate(() => Array.from(document.querySelectorAll("li")).map((li) => li.textContent))

  it("asks for two letters, then shows results", async () => {
    await h.page.fill("input", "a")
    await h.page.waitForFunction(() => document.querySelector("main p")?.textContent === "Type at least two letters.")
    await h.page.fill("input", "an")
    await h.page.waitForFunction(() => document.querySelectorAll("li").length === 3)
    assert.deepStrictEqual(await items(), ["banana", "mango", "orange"])
    assert.strictEqual(await h.page.textContent("#calls"), "Backend calls: 1")
  })

  it("shares results and saved searches with another tab: one backend call per query", async () => {
    const other = await h.context.newPage()
    await other.goto(h.url)
    await connected(other)
    await other.fill("input", "an")
    await other.waitForFunction(() => document.querySelectorAll("li").length === 3)
    assert.strictEqual(await other.textContent("#calls"), "Backend calls: 1")
    await other.click("#save")
    await h.page.waitForFunction(() => document.querySelector("#saved button")?.textContent === "an")
    // the query itself stays local to each tab
    await other.fill("input", "pe")
    await other.waitForFunction(() => document.querySelectorAll("li").length === 2)
    assert.deepStrictEqual(await items(), ["banana", "mango", "orange"])
    await h.page.waitForFunction(() => document.querySelector("#calls")?.textContent === "Backend calls: 2")
    await other.close()
  })

  it("saves only queries of two or more letters", async () => {
    await h.page.fill("input", "x")
    await h.page.click("#save")
    await h.page.fill("input", "ap")
    await h.page.click("#save")
    const saved = () => h.page.evaluate(() => Array.from(document.querySelectorAll("#saved button")).map((b) => b.textContent))
    await h.page.waitForFunction(() => Array.from(document.querySelectorAll("#saved button")).some((b) => b.textContent === "ap"))
    assert.notInclude(await saved(), "x")
    // let the search for "ap" finish, so that no render of it reaches the next test
    await h.page.waitForFunction(() => document.querySelectorAll("li").length === 4)
  })

  it("renders a new query twice: counting the backend call writes no atom during a render", async () => {
    const other = await h.context.newPage()
    const renders: Array<string> = []
    other.on("websocket", (ws) =>
      ws.on("framereceived", ({ payload }) => {
        if (String(payload).startsWith(`{"t":"render"`)) renders.push(String(payload))
      }))
    await other.goto(h.url)
    await connected(other)
    renders.length = 0
    await other.fill("input", "ch")
    await other.waitForFunction(() => document.querySelectorAll("li").length === 1)
    // "Searching…", then the results with the new count
    assert.strictEqual(renders.length, 2)
    await other.close()
  })
})
