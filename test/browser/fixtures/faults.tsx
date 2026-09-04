// A page for fault injection: buttons that make handlers and renders fail,
// a slow handler, and a ticker, so the suites can observe what the session
// does and what it cleans up. Server-side observations go to stdout.
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"
import { serve } from "./serve.ts"

const say = (line: string) => Effect.sync(() => console.log(`fixture: ${line}`))

const Risky = View.Component(function*(p: { readonly limit: number }) {
  const n = yield* View.State(0)
  if (n.value > p.limit) return yield* Effect.fail(new Error(`over the limit: ${n.value}`))
  return <button id="risky" onClick={() => n.update((x) => x + 1)}>risky {n.value}</button>
})

const Page = View.Component(function*() {
  const count = yield* View.State(0)
  const explode = yield* View.State(false)
  const live = yield* View.connected
  yield* View.once(
    live
      ? Effect.forkScoped(
        Effect.forever(Effect.andThen(Effect.sleep("50 millis"), say("tick"))).pipe(
          Effect.onInterrupt(() => say("ticker interrupted"))
        )
      )
      : Effect.void
  )
  yield* Effect.flatMap(View.Instance, (i) => i.slot(Effect.addFinalizer(() => say("page instance closed"))))
  if (explode.value) return yield* Effect.fail(new Error("render exploded"))
  return (
    <main>
      <output id="count">{count.value}</output>
      <button id="inc" onClick={() => count.update((n) => n + 1)}>+</button>
      <button id="handler-fail" onClick={() => Effect.andThen(count.update((n) => n + 1), Effect.fail(new Error("handler failed on purpose")))}>fail</button>
      <button id="handler-throw" onClick={() => { throw new Error("handler threw on purpose") }}>throw</button>
      <button id="slow" onClick={() => Effect.sleep("2 seconds").pipe(Effect.andThen(say("slow handler finished")), Effect.onInterrupt(() => say("slow handler interrupted")))}>slow</button>
      <button id="render-fail" onClick={() => explode.set(true)}>explode</button>
      <View.ErrorBoundary fallback={() => <p id="fallback">contained</p>}>
        <Risky limit={1} />
      </View.ErrorBoundary>
    </main>
  )
})

await serve(HttpRouter.serve(Server.mount("/", Page, { debug: true })).pipe(Layer.provide(Layer.empty)))
