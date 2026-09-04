// The counter of examples/counter, as a fixture the suites can run on Bun or Node.
import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"
import { serve } from "./serve.ts"

const Counter = View.Component(function*() {
  const count = yield* View.State(0)
  return (
    <main>
      <h1>{count.value}</h1>
      <button onClick={() => count.update((n) => n + 1)}>Increment</button>
    </main>
  )
})

await serve(HttpRouter.serve(Server.mount("/", Counter, { title: "Counter" })))
