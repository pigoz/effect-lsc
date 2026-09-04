import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"
import { serve } from "../runtime.ts"

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

await serve(HttpRouter.serve(Server.mount("/", Counter, { title: "Shared counter" })).pipe(Layer.provide(Count.layer)))
