import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"
import { serve } from "../runtime.ts"

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

await serve(HttpRouter.serve(Server.mount("/", Counter, { title: "Counter" })))
