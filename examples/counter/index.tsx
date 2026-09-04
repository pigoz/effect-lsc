import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"

// The component runs on the server. `count` lives on the server. The
// onClick callback never leaves the server: the browser only sees an id.
const Counter = View.Component(function*() {
  const count = yield* View.State(0)

  return (
    <main>
      <h1>{count.value}</h1>

      <button onClick={() => count.update((n) => n + 1)}>
        Increment
      </button>
    </main>
  )
})

// GET / serves the page; a WebSocket upgrade on the same path runs the
// live session. Open http://localhost:3000.
const App = Server.mount("/", Counter, { title: "Counter" })

HttpRouter.serve(App).pipe(
  // disablePreemptiveShutdown: interrupt live sessions first, then stop,
  // so Ctrl+C exits at once (Bun 1.4.1+).
  Layer.provide(BunHttpServer.layer({ port: 3000, disablePreemptiveShutdown: true })),
  Layer.launch,
  BunRuntime.runMain
)
