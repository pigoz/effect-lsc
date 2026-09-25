// The live session over a socket: Server.session driven by a fake WebSocket.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
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
})
