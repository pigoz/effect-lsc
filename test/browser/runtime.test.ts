import { afterAll, assert, beforeAll, describe, it } from "vitest"
import { connected, events, type Harness, open, settle, takeMorphs, traceMorphs } from "./support.ts"

let h: Harness
beforeAll(async () => {
  h = await open("test/browser/fixtures/app.tsx")
  await connected(h.page)
  await traceMorphs(h.page)
})
afterAll(async () => {
  await h?.stop()
})

const text = (selector: string) => h.page.locator(selector).textContent()
const count = (selector: string) => h.page.locator(selector).count()
const probe = (selector: string, value: string) =>
  h.page.evaluate(([s, v]) => { (document.querySelector(s!) as any).__probe = v }, [selector, value])
const probed = (selector: string) => h.page.evaluate((s) => (document.querySelector(s) as any)?.__probe ?? null, selector)

describe("runtime in a real browser", () => {
  it("server-side clicks update the page, and only the section they touch", async () => {
    await takeMorphs(h.page)
    await h.page.click("#inc")
    await h.page.click("#inc")
    await h.page.click("#inc")
    await settle(h.page)
    assert.strictEqual(await text("#count"), "3")
    const morphs = await takeMorphs(h.page)
    assert.isTrue(morphs.length > 0)
    assert.isTrue(morphs.every((m) => m === "SECTION#counter"), morphs.join(","))
  })

  it("a focused button updates its label (idiomorph ignoreActiveValue regression)", async () => {
    await h.page.click("#pause")
    await h.page.waitForFunction(() => document.querySelector("#pause")!.textContent === "Resume", null, { timeout: 2000 })
    assert.strictEqual(await h.page.evaluate(() => document.activeElement?.id), "pause")
    await h.page.click("#pause")
    await h.page.waitForFunction(() => document.querySelector("#pause")!.textContent === "Pause", null, { timeout: 2000 })
  })

  it("lists are reconciled in place: adds and removes morph nothing, elements keep identity", async () => {
    for (let i = 0; i < 3; i++) await h.page.click("#add")
    await settle(h.page)
    assert.strictEqual(await count("#items li"), 3)
    await probe("#items li:nth-child(1)", "first")
    await probe("#items li:nth-child(3)", "third")
    await takeMorphs(h.page)
    await h.page.click("#add")
    await settle(h.page)
    assert.strictEqual(await count("#items li"), 4)
    assert.deepStrictEqual(await takeMorphs(h.page), [])
    assert.strictEqual(await probed("#items li:nth-child(1)"), "first")

    await h.page.click("#remove-first")
    await settle(h.page)
    assert.strictEqual(await count("#items li"), 3)
    assert.deepStrictEqual(await takeMorphs(h.page), [])
    assert.strictEqual(await probed("#items li:nth-child(2)"), "third")
  })

  it("moves and full reorders keep element identity", async () => {
    const ids = () => h.page.evaluate(() => Array.from(document.querySelectorAll("#items li")).map((li) => li.getAttribute("data-id")))
    const before = await ids()
    await probe("#items li:nth-child(1)", "head")
    await h.page.click("#rotate")
    await settle(h.page)
    assert.deepStrictEqual(await ids(), [...before.slice(1), before[0]])
    assert.strictEqual(await probed("#items li:last-child"), "head")
    assert.deepStrictEqual(await takeMorphs(h.page), [])
    await h.page.click("#reverse")
    await settle(h.page)
    assert.deepStrictEqual(await ids(), [before[0], ...before.slice(1).reverse()])
    assert.strictEqual(await probed("#items li:first-child"), "head")
    assert.deepStrictEqual(await takeMorphs(h.page), [])
  })

  it("toggling a row morphs the row and the derived counter, not the section", async () => {
    await takeMorphs(h.page)
    await h.page.click("#items li:first-child .toggle")
    await settle(h.page)
    assert.strictEqual(await text("#done"), "1")
    assert.isTrue(await h.page.locator("#items li:first-child").evaluate((li) => li.classList.contains("done")))
    assert.isTrue(await h.page.locator("#items li:first-child .toggle").isChecked())
    const morphs = await takeMorphs(h.page)
    assert.deepStrictEqual([...new Set(morphs)].sort(), ["LI", "OUTPUT#done"])
  })

  it("an inserted autofocus input gets focus; blur removes it", async () => {
    await h.page.dblclick("#items li:first-child label")
    await h.page.waitForSelector("#items li:first-child .edit")
    assert.strictEqual(await h.page.evaluate(() => document.activeElement?.className), "edit")
    await h.page.locator("#items li:first-child .edit").blur()
    await h.page.waitForFunction(() => document.querySelector(".edit") === null)
  })

  it("a controlled input echoes every keystroke without losing what was typed", async () => {
    await h.page.locator("#draft").pressSequentially("hello", { delay: 30 })
    await h.page.waitForFunction(() => document.querySelector("#echo")!.textContent === "hello")
    assert.strictEqual(await h.page.inputValue("#draft"), "hello")
  })

  it("a focused text input keeps its value across a patch from another session", async () => {
    await h.page.fill("#text", "typed but not sent")
    assert.strictEqual(await h.page.evaluate(() => document.activeElement?.id), "text")
    const other = await h.context.newPage()
    await other.goto(h.url)
    await connected(other)
    await other.click("#shared-inc")
    await other.close()
    await h.page.waitForFunction(() => document.querySelector("#shared")!.textContent === "1")
    assert.strictEqual(await h.page.inputValue("#text"), "typed but not sent")
  })

  it("a live submit sends the form fields and resets the form", async () => {
    await h.page.fill("#text", "sent")
    await h.page.click("#submit")
    await h.page.waitForFunction(() => document.querySelector("#submitted")!.textContent === "sent")
    assert.strictEqual(await h.page.inputValue("#text"), "")
  })

  it("islands mount, receive prop updates, keep their own DOM, and unmount", async () => {
    await h.page.waitForSelector("#box")
    const initial = await events(h.page)
    assert.include(initial, "island:mount:1")
    assert.include(initial, "mounted:a")
    assert.strictEqual(await count("#placeholder"), 0)
    await h.page.click("#box")
    assert.strictEqual(await text("#local"), "1")
    await probe("#box", "box")
    await h.page.click("#island-bump")
    await h.page.waitForFunction(() => document.querySelector("#box")!.textContent === "2")
    assert.deepStrictEqual(await events(h.page), ["island:update:2"])
    assert.strictEqual(await text("#local"), "1")
    assert.strictEqual(await probed("#box"), "box")
    // the hook element in the same section reports `updated` on that morph; only island events matter here
    const islandEvents = async () => (await events(h.page)).filter((e) => e.startsWith("island:"))
    await h.page.click("#island-toggle")
    await h.page.waitForFunction(() => document.querySelector("#box") === null)
    assert.deepStrictEqual(await islandEvents(), ["island:unmount"])
    await h.page.click("#island-toggle")
    await h.page.waitForSelector("#box")
    assert.deepStrictEqual(await islandEvents(), ["island:mount:2"])
    assert.strictEqual(await text("#local"), "0")
  })

  it("element hooks see mounted, updated and destroyed", async () => {
    await events(h.page)
    await h.page.click("#hook-bump")
    await h.page.waitForFunction(() => document.querySelector("#hooked")!.getAttribute("data-value") === "aa")
    assert.deepStrictEqual(await events(h.page), ["updated:aa"])
    await h.page.click("#hook-toggle")
    await h.page.waitForFunction(() => document.querySelector("#hooked") === null)
    assert.deepStrictEqual(await events(h.page), ["destroyed:aa"])
    await h.page.click("#hook-toggle")
    await h.page.waitForSelector("#hooked", { state: "attached" })
    assert.deepStrictEqual(await events(h.page), ["mounted:aa"])
  })
})
