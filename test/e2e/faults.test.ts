// Fault injection over the wire: failing handlers, failing renders, and a
// disconnect in the middle of a handler.
import { afterAll, assert, beforeAll, describe, it } from "vitest"
import WebSocket from "ws"
import { startServer } from "../browser/support.ts"

type Message = { t: "render"; p: unknown } | { t: "error"; scope: string; message: string }

const connect = (url: string) =>
  new Promise<{
    send: (m: object) => void
    next: (what: string) => Promise<Message>
    closed: Promise<number>
    close: () => void
  }>((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws"))
    const queue: Array<Message> = []
    const waiters: Array<() => void> = []
    let closeCode = -1
    const closed = new Promise<number>((r) => ws.on("close", (code) => { closeCode = code; r(code) }))
    ws.on("message", (data) => { queue.push(JSON.parse(data.toString())); waiters.splice(0).forEach((w) => w()) })
    ws.on("error", () => reject(new Error("socket error")))
    ws.on("open", () => resolve({
      send: (m) => ws.send(JSON.stringify(m)),
      next: async (what) => {
        const deadline = Date.now() + 4000
        while (Date.now() < deadline) {
          const m = queue.shift()
          if (m !== undefined) return m
          if (closeCode !== -1) throw new Error(`socket closed (${closeCode}) while waiting for ${what}`)
          await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100) })
        }
        throw new Error(`timeout waiting for ${what}`)
      },
      closed,
      close: () => ws.close()
    }))
  })

const waitFor = async (predicate: () => boolean, what: string, ms = 4000) => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  if (!predicate()) throw new Error(`timeout waiting for ${what}`)
}

describe("faults over the wire", () => {
  let url = ""
  let stop = async () => {}
  let log = () => ""
  beforeAll(async () => ({ url, stop, log } = await startServer("test/browser/fixtures/faults.tsx")))
  afterAll(() => stop())

  it("a failing handler is reported and the session survives, with the state it changed", async () => {
    const s = await connect(url)
    assert.strictEqual((await s.next("first render")).t, "render")
    s.send({ t: "event", type: "click", id: "r.0.2" }) // handler-fail: count + 1, then fail
    const error = await s.next("error") as Extract<Message, { t: "error" }>
    assert.strictEqual(error.t, "error")
    assert.strictEqual(error.scope, "handler")
    assert.include(error.message, "handler failed on purpose") // debug: true exposes the cause
    // the state change before the failure produced a render
    const render = await s.next("render after failure")
    assert.strictEqual(render.t, "render")
    s.send({ t: "event", type: "click", id: "r.0.3" }) // handler-throw
    const thrown = await s.next("error for a defect") as Extract<Message, { t: "error" }>
    assert.strictEqual(thrown.scope, "handler")
    assert.include(thrown.message, "handler threw on purpose")
    // still alive: a normal click renders
    s.send({ t: "event", type: "click", id: "r.0.1" })
    assert.strictEqual((await s.next("render after ok click")).t, "render")
    s.close()
  })

  it("a failing render inside a boundary shows the fallback and keeps the session", async () => {
    const s = await connect(url)
    await s.next("first render")
    s.send({ t: "event", type: "click", id: "r.0.6.0.0" }) // risky -> 1
    await s.next("risky 1")
    s.send({ t: "event", type: "click", id: "r.0.6.0.0" }) // risky -> 2: over the limit
    const patch = JSON.stringify(await s.next("fallback render"))
    assert.include(patch, "contained")
    s.send({ t: "event", type: "click", id: "r.0.1" })
    assert.strictEqual((await s.next("render after fallback")).t, "render")
    s.close()
  })

  it("a failing render outside a boundary is reported and ends the session; the next session is fresh", async () => {
    const s = await connect(url)
    await s.next("first render")
    s.send({ t: "event", type: "click", id: "r.0.1" })
    await s.next("count 1")
    s.send({ t: "event", type: "click", id: "r.0.5" }) // render-fail
    const error = await s.next("render error") as Extract<Message, { t: "error" }>
    assert.strictEqual(error.scope, "render")
    assert.include(error.message, "render exploded")
    assert.strictEqual(await s.closed, 1011)
    await waitFor(() => log().includes("page instance closed"), "instance cleanup in the log")
    const fresh = await connect(url)
    const first = JSON.stringify(await fresh.next("fresh first render"))
    assert.include(first, '"0"') // count is 0 again: state does not survive the session
    fresh.close()
  })

  it("a disconnect in the middle of a handler interrupts it and cleans the session up", async () => {
    const before = log()
    const s = await connect(url)
    await s.next("first render")
    s.send({ t: "event", type: "click", id: "r.0.4" }) // slow: sleeps 2 seconds
    await new Promise((r) => setTimeout(r, 300))
    s.close()
    await waitFor(() => log().slice(before.length).includes("slow handler interrupted"), "handler interruption")
    await waitFor(() => log().slice(before.length).includes("ticker interrupted"), "ticker interruption")
    await waitFor(() => log().slice(before.length).includes("page instance closed"), "instance cleanup")
    assert.notInclude(log().slice(before.length), "slow handler finished")
  })
})
