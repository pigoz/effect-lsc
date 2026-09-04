import { afterAll, assert, beforeAll, describe, it } from "vitest"
import { connected, type Harness, open, settle, takeMorphs, traceMorphs } from "./support.ts"

describe("counter example", () => {
  let h: Harness
  beforeAll(async () => {
    h = await open("examples/counter/index.tsx")
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

describe("todomvc example", () => {
  let h: Harness
  beforeAll(async () => {
    h = await open("examples/todomvc/index.tsx")
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
