import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"

// Shared state is a service: one SharedState for the whole process,
// provided with a Layer. Every session that watches it is re-rendered
// when it changes, so all open tabs stay in sync.
class Count extends Context.Service<Count, View.SharedState<number>>()("shared-counter/Count") {
  static readonly layer = Layer.effect(Count, View.SharedState(0))
}

const Counter = View.Component(function*() {
  const shared = yield* Count
  const total = yield* View.watch(shared) // shared across tabs
  const mine = yield* View.State(0) // local to this tab

  const increment = Effect.all([
    shared.update((n) => n + 1),
    mine.update((n) => n + 1)
  ])

  return (
    <main>
      <h1>{total}</h1>
      <p>Clicked {mine.value} times from this tab. Open another tab: the total is shared.</p>
      <button onClick={() => increment}>Increment</button>
    </main>
  )
})

const App = Server.mount("/", Counter, { title: "Shared counter" })

HttpRouter.serve(App).pipe(
  Layer.provide(Count.layer),
  Layer.provide(BunHttpServer.layerConfig({
    port: Config.port("PORT").pipe(Config.withDefault(3000)),
    // Interrupt live sessions first, then stop: Ctrl+C exits at once.
    // Needs Bun 1.4.1+.
    disablePreemptiveShutdown: Config.succeed(true)
  })),
  Layer.launch,
  BunRuntime.runMain
)
