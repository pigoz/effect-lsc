import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Layer } from "effect"
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

const App = Server.mount("/", Counter, { title: "Counter" })

HttpRouter.serve(App).pipe(
  Layer.provide(BunHttpServer.layerConfig({
    port: Config.port("PORT").pipe(Config.withDefault(3000)),
    // Interrupt live sessions first, then stop: Ctrl+C exits at once.
    // Needs Bun 1.4.1+.
    disablePreemptiveShutdown: Config.succeed(true)
  })),
  Layer.launch,
  BunRuntime.runMain
)
