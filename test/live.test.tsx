// The live session over a socket: Server.session driven by a fake WebSocket.
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Logger } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import * as Socket from "effect/unstable/socket/Socket"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"

// An open WebSocket that records what the server sends. It goes through
// Socket.fromWebSocket, as on Node and Cloudflare, so its writes wait for
// the session to connect, as they do there. A browser answers a close from
// the server with its own; `echo = false` makes one that never does.
// `sendThrows = true` makes send throw, as it can once the connection is
// gone.
class FakeWebSocket extends EventTarget {
  readyState = 1
  echo = true
  sendThrows = false
  closedWith: number | undefined = undefined
  readonly sent: Array<string> = []
  send(data: string) {
    if (this.sendThrows) throw new Error("the connection is gone")
    this.sent.push(data)
  }
  close(code = 1000) {
    this.closedWith ??= code
    if (this.echo) this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }))
  }
  receive(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }))
  }
}

const sleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const until = (done: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() => done() ? Effect.void : Effect.andThen(sleep(1), until(done)))

// What the session logs, as "Level: message", in place of the console.
// Every close fails the socket's pull with a SocketError, so a session that
// ends normally must still log nothing.
const captureLogs = () => {
  const logs: Array<string> = []
  const layer = Logger.layer([Logger.make(({ logLevel, message }) => { logs.push(`${logLevel}: ${String(message)}`) })])
  return { logs, layer }
}

describe("Server.session", () => {
  it.live("renders one at a time: a first render that waits is not overlapped by the next", () =>
    Effect.gen(function*() {
      const first = Atom.make(Effect.as(Effect.sleep("10 millis"), "ready")).pipe(Atom.keepAlive)
      const second = Atom.make(Effect.as(Effect.sleep("20 millis"), "set")).pipe(Atom.keepAlive)
      let rendering = 0
      let most = 0
      let onceRuns = 0
      const App = View.Component(function*() {
        most = Math.max(most, ++rendering)
        try {
          // the first value wakes the session while the render waits for the second
          const a = yield* View.result(first)
          const b = yield* View.result(second)
          yield* View.once(Effect.sync(() => onceRuns++))
          return <p>{a} {b}</p>
        } finally {
          rendering--
        }
      })
      const ws = new FakeWebSocket()
      const socket = yield* Socket.fromWebSocket(Effect.succeed(ws))
      const running = yield* Effect.forkChild(Server.session(App, socket))
      yield* until(() => ws.sent.some((message) => message.includes("set")))
      ws.close()
      yield* Fiber.join(running)
      assert.deepStrictEqual({ most, onceRuns }, { most: 1, onceRuns: 1 })
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("events that arrive during the first render wait for it", () =>
    Effect.gen(function*() {
      const waiting = yield* Deferred.make<void>()
      const loaded = yield* Deferred.make<void>()
      const results = Atom.make(
        Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(loaded)), Effect.as("results"))
      ).pipe(Atom.keepAlive)
      const clicks: Array<string> = []
      const Results = View.Component(function*() {
        return <ol>{yield* View.result(results)}</ol>
      })
      const App = View.Component(function*() {
        const R = yield* View.use(Results)
        return (
          <main>
            <button onClick={() => { clicks.push("save") }}>save</button>
            <R />
            <button onClick={() => { clicks.push("next") }}>next</button>
          </main>
        )
      })
      const ws = new FakeWebSocket()
      const socket = yield* Socket.fromWebSocket(Effect.succeed(ws))
      const running = yield* Effect.forkChild(Server.session(App, socket))
      yield* Deferred.await(waiting)
      // the browser shows the page of the HTTP render, with the same paths
      ws.receive({ t: "event", type: "click", id: "r.0.0" })
      ws.receive({ t: "event", type: "click", id: "r.0.2" })
      yield* sleep(10)
      yield* Deferred.succeed(loaded, undefined)
      yield* until(() => clicks.length === 2).pipe(Effect.timeoutOption("200 millis"))
      ws.close()
      yield* Fiber.join(running)
      assert.deepStrictEqual(clicks, ["save", "next"])
    }).pipe(Effect.provide(AtomRegistry.layer)))

  // Bun and Node interrupt the session when the connection drops.
  for (const end of ["the socket closes", "the session is interrupted"] as const) {
    it.live(`when ${end}, a running handler is interrupted, then the instances close, then the socket is released`, () => {
      const { logs, layer } = captureLogs()
      return Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const log: Array<string> = []
        const App = View.Component(function*() {
          const connection = yield* View.once(Effect.acquireRelease(
            Effect.sync(() => ({ open: true })),
            (connection) =>
              Effect.sync(() => {
                connection.open = false
                log.push("released")
              })
          ))
          const save = () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              // an interruption that takes time must still end first
              Effect.onInterrupt(() =>
                Effect.andThen(sleep(10), Effect.sync(() => log.push(`interrupted, open: ${connection.open}`)))
              )
            )
          return <button onClick={save}>save</button>
        })
        const ws = new FakeWebSocket()
        const socket = yield* Socket.fromWebSocket(
          Effect.acquireRelease(Effect.succeed(ws), () => Effect.sync(() => log.push("socket released")))
        )
        const running = yield* Effect.forkChild(Server.session(App, socket))
        yield* until(() => ws.sent.length > 0)
        ws.receive({ t: "event", type: "click", id: "r.0" })
        yield* Deferred.await(started)
        if (end === "the socket closes") {
          ws.close()
          yield* Fiber.join(running)
        } else {
          yield* Fiber.interrupt(running)
        }
        assert.deepStrictEqual(log, ["interrupted, open: true", "released", "socket released"])
        assert.deepStrictEqual(logs, [])
      }).pipe(Effect.provide(layer))
    })
  }

  it.live("a failed render closes the socket with 1011 and ends the session without waiting for the browser", () => {
    const { logs, layer } = captureLogs()
    return Effect.gen(function*() {
      const App = View.Component(function*() {
        const broken = yield* View.State(false)
        if (broken.value) return yield* Effect.die(new Error("render failed"))
        return <button onClick={() => broken.set(true)}>break</button>
      })
      const ws = new FakeWebSocket()
      ws.echo = false
      const socket = yield* Socket.fromWebSocket(Effect.succeed(ws))
      const running = yield* Effect.forkChild(Server.session(App, socket))
      yield* until(() => ws.sent.length > 0)
      ws.receive({ t: "event", type: "click", id: "r.0" })
      yield* Fiber.join(running).pipe(Effect.timeout("500 millis"))
      assert.strictEqual(ws.closedWith, 1011)
      assert.include(ws.sent.at(-1)!, `"scope":"render"`)
      // logged once, by the render, not again as the end of the session
      assert.deepStrictEqual(logs, ["Error: effect-lsc: render failed, ending the session"])
    }).pipe(Effect.provide(layer))
  })

  it.live("a failed send ends the session quietly, and the instances close", () => {
    const { logs, layer } = captureLogs()
    return Effect.gen(function*() {
      const log: Array<string> = []
      const App = View.Component(function*() {
        const count = yield* View.State(0)
        yield* View.once(Effect.acquireRelease(Effect.void, () => Effect.sync(() => log.push("released"))))
        return <button onClick={() => count.update((n) => n + 1)}>{count.value}</button>
      })
      const ws = new FakeWebSocket()
      const socket = yield* Socket.fromWebSocket(Effect.succeed(ws))
      const running = yield* Effect.forkChild(Server.session(App, socket))
      yield* until(() => ws.sent.length > 0)
      ws.sendThrows = true
      // the click renders again, and sending the patch fails
      ws.receive({ t: "event", type: "click", id: "r.0" })
      yield* Fiber.join(running).pipe(Effect.timeout("500 millis"))
      assert.deepStrictEqual({ log, logs }, { log: ["released"], logs: [] })
    }).pipe(Effect.provide(layer))
  })
})
