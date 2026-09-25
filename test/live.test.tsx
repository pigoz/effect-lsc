// The live session over a socket: Server.session driven by a fake WebSocket.
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import * as Socket from "effect/unstable/socket/Socket"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"

// An open WebSocket that records what the server sends. It goes through
// Socket.fromWebSocket, as on Node and Cloudflare, so onOpen runs where it
// runs there.
class FakeWebSocket extends EventTarget {
  readyState = 1
  readonly sent: Array<string> = []
  send(data: string) {
    this.sent.push(data)
  }
  close(code = 1000) {
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }))
  }
  receive(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }))
  }
}

const sleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const until = (done: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() => done() ? Effect.void : Effect.andThen(sleep(1), until(done)))

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
      const socket = yield* Socket.fromWebSocket(Effect.succeed(ws as unknown as globalThis.WebSocket))
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
      const socket = yield* Socket.fromWebSocket(Effect.succeed(ws as unknown as globalThis.WebSocket))
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

  it.live("a closed socket interrupts a running handler before releasing what it uses", () =>
    Effect.gen(function*() {
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
            Effect.onInterrupt(() => Effect.sync(() => log.push(`interrupted, open: ${connection.open}`)))
          )
        return <button onClick={save}>save</button>
      })
      const ws = new FakeWebSocket()
      const socket = yield* Socket.fromWebSocket(Effect.succeed(ws as unknown as globalThis.WebSocket))
      const running = yield* Effect.forkChild(Server.session(App, socket))
      yield* until(() => ws.sent.length > 0)
      ws.receive({ t: "event", type: "click", id: "r.0" })
      yield* Deferred.await(started)
      ws.close()
      yield* Fiber.join(running)
      assert.deepStrictEqual(log, ["interrupted, open: true", "released"])
    }))
})
