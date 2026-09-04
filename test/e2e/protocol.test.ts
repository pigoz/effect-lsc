// Protocol-level tests: a raw WebSocket client speaks to the fixtures and
// rebuilds the HTML from the patches with the runtime's own merge code.
import { afterAll, assert, beforeAll, describe, it } from "vitest"
import WebSocket from "ws"
import { core } from "../../src/internal/browser.ts"
import { startServer } from "../browser/support.ts"

const makeClient = () => {
  const { merge, html } = (new Function(`${core}; return { merge: merge, html: html };`) as () => {
    merge: (c: unknown, p: unknown) => unknown
    html: (t: unknown, path: string) => string
  })()
  let tree: unknown = null
  return { apply: (message: { p: unknown }) => { tree = merge(tree, message.p); return html(tree, "r").replace(/ data-lsc-n="[^"]*"/g, "") } }
}

interface Session {
  readonly send: (message: object) => void
  /** Reads renders until one satisfies `ok`, or fails after the deadline. */
  readonly until: (ok: (html: string) => boolean, what: string) => Promise<string>
  readonly close: () => void
}

const connect = (url: string, headers?: Record<string, string>): Promise<Session> =>
  new Promise((resolve, reject) => {
    // the `ws` client, because Node's global WebSocket cannot set headers such as Origin
    const ws = new WebSocket(url.replace(/^http/, "ws"), { headers: headers ?? {} })
    const client = makeClient()
    const queue: Array<string> = []
    const waiters: Array<() => void> = []
    ws.on("message", (data) => { queue.push(client.apply(JSON.parse(data.toString()))); waiters.splice(0).forEach((w) => w()) })
    ws.on("error", () => reject(new Error("socket error")))
    ws.on("open", () => resolve({
      send: (m) => ws.send(JSON.stringify(m)),
      until: async (ok, what) => {
        const deadline = Date.now() + 4000
        let last = ""
        while (Date.now() < deadline) {
          const next = queue.shift()
          if (next === undefined) { await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100) }); continue }
          last = next
          if (ok(next)) return next
        }
        throw new Error(`timeout waiting for ${what}; last html: ${last.slice(0, 300)}`)
      },
      close: () => ws.close()
    }))
  })

const id = (html: string, pattern: RegExp) => {
  const match = pattern.exec(html)
  if (match === null) throw new Error(`no match for ${pattern} in ${html.slice(0, 300)}`)
  return match[1]!
}

describe("counter over the wire", () => {
  let url = ""
  let stop = async () => {}
  beforeAll(async () => ({ url, stop } = await startServer("test/browser/fixtures/counter.tsx")))
  afterAll(() => stop())

  it("serves a page without the application code, and counts clicks per session", async () => {
    const page = await (await fetch(url)).text()
    assert.include(page, "<!doctype html>")
    assert.include(page, "<h1>0</h1>")
    assert.include(page, "data-lsc-root")
    assert.notInclude(page, "count.update")
    const clickId = id(page, /data-lsc-click="([^"]+)"/)

    const a = await connect(url)
    await a.until((h) => h.includes("<h1>0</h1>"), "initial render")
    a.send({ t: "event", type: "click", id: clickId })
    await a.until((h) => h.includes("<h1>1</h1>"), "1 after a click")
    for (let i = 0; i < 5; i++) a.send({ t: "event", type: "click", id: clickId })
    await a.until((h) => h.includes("<h1>6</h1>"), "6 after a burst")
    // garbage and stale ids are ignored, the session survives
    a.send({ t: "nonsense" })
    a.send({ t: "event", type: "click", id: "bogus" })
    a.send({ t: "event", type: "click", id: clickId })
    await a.until((h) => h.includes("<h1>7</h1>"), "7 after garbage")
    // state is per session
    const b = await connect(url)
    await b.until((h) => h.includes("<h1>0</h1>"), "fresh session at 0")
    a.close(); b.close()
  })

  it("refuses upgrades from another origin", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(url.replace(/^http/, "ws"), { headers: { Origin: "http://evil.example" } })
      ws.on("unexpected-response", (_, response) => resolve(`refused ${response.statusCode}`))
      ws.on("error", (e) => resolve(`error ${e.message}`))
      ws.on("message", () => resolve("render received"))
      ws.on("close", (code) => resolve(`closed ${code}`))
    })
    assert.notStrictEqual(outcome, "render received", outcome)
    const same = await connect(url, { Origin: new URL(url).origin })
    await same.until((h) => h.includes("<h1>0</h1>"), "same origin render")
    same.close()
  })
})

describe("shared counter over the wire", () => {
  let url = ""
  let stop = async () => {}
  beforeAll(async () => ({ url, stop } = await startServer("test/browser/fixtures/shared-counter.tsx")))
  afterAll(() => stop())

  it("pushes shared changes to every session, keeps local state per session", async () => {
    const a = await connect(url)
    const b = await connect(url)
    const first = await a.until((h) => h.includes("<h1>0</h1>"), "A initial")
    await b.until((h) => h.includes("<h1>0</h1>"), "B initial")
    const clickId = id(first, /data-lsc-click="([^"]+)"/)
    a.send({ t: "event", type: "click", id: clickId })
    a.send({ t: "event", type: "click", id: clickId })
    const ah = await a.until((h) => h.includes("<h1>2</h1>"), "A total 2")
    const bh = await b.until((h) => h.includes("<h1>2</h1>"), "B total 2")
    assert.include(ah, "Clicked 2 times")
    assert.include(bh, "Clicked 0 times")
    a.close(); b.close()
  })
})

describe("todomvc over the wire", () => {
  let url = ""
  let stop = async () => {}
  beforeAll(async () => ({ url, stop } = await startServer("test/browser/fixtures/todomvc.tsx")))
  afterAll(() => stop())

  it("adds, toggles, filters, edits and clears across two sessions", async () => {
    const a = await connect(url)
    let html = await a.until((h) => h.includes("todoapp"), "initial")
    assert.notInclude(html, "todo-list")
    const submit = id(html, /<form data-lsc-submit="([^"]+)"/)
    a.send({ t: "event", type: "submit", id: submit, form: { title: "  buy milk  " } })
    html = await a.until((h) => h.includes("buy milk"), "first todo")
    assert.include(html, "<strong>1</strong> item left")
    a.send({ t: "event", type: "submit", id: submit, form: { title: "   " } })
    a.send({ t: "event", type: "submit", id: submit, form: { title: "walk dog" } })
    html = await a.until((h) => h.includes("walk dog"), "second todo")
    assert.include(html, "<strong>2</strong> items left")

    const b = await connect(url)
    await b.until((h) => h.includes("buy milk") && h.includes("walk dog"), "B sees shared todos")

    const toggle = id(html, /<input class="toggle" type="checkbox" data-lsc-change="([^"]+)"/)
    a.send({ t: "event", type: "change", id: toggle, checked: true })
    html = await a.until((h) => h.includes('class="completed"'), "A toggled")
    await b.until((h) => h.includes('class="completed"'), "B got the toggle")

    const active = id(html, /<a href="#\/active" data-lsc-click="([^"]+)"/)
    a.send({ t: "event", type: "click", id: active })
    html = await a.until((h) => !h.includes("buy milk") && h.includes("walk dog"), "active filter")

    const dbl = id(html, /<label data-lsc-dblclick="([^"]+)">walk dog/)
    a.send({ t: "event", type: "dblclick", id: dbl })
    html = await a.until((h) => h.includes('class="editing"'), "editing")
    const edit = id(html, /<input class="edit"[^>]*data-lsc-keydown="([^"]+)"/)
    a.send({ t: "event", type: "keydown", id: edit, key: "Enter", value: "walk the dog" })
    html = await a.until((h) => h.includes("walk the dog") && !h.includes("editing"), "edited")

    const bHtml = await b.until((h) => h.includes("walk the dog"), "B got the edit")
    const clear = id(bHtml, /<button class="clear-completed" data-lsc-click="([^"]+)"/)
    b.send({ t: "event", type: "click", id: clear })
    await b.until((h) => !h.includes("buy milk"), "B cleared")
    await a.until((h) => !h.includes("buy milk"), "A got the clear")
    a.close(); b.close()
  })
})
