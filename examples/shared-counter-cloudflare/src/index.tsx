// A shared counter on Cloudflare: one Durable Object is the room, and
// every tab routed to it shares the same SharedState, because the services
// are built once per object. Run locally with `bun run shared-counter-cloudflare`.
import { DurableObject } from "cloudflare:workers"
import { Context, Effect, Layer } from "effect"
import { Cloudflare } from "effect-lsc/cloudflare"
import { View } from "effect-lsc/view"

class Count extends Context.Service<Count, View.SharedState<number>>()("cloudflare/Count") {
  static readonly layer = Layer.effect(Count, View.SharedState(0))
}

const Counter = View.Component(function*() {
  const shared = yield* Count
  const total = yield* View.watch(shared)
  const mine = yield* View.State(0)
  const increment = Effect.all([shared.update((n) => n + 1), mine.update((n) => n + 1)])
  return (
    <main>
      <h1>{total}</h1>
      <p>Clicked {mine.value} times from this tab. The total lives in a Durable Object.</p>
      <button onClick={() => increment}>Increment</button>
    </main>
  )
})

export class Room extends DurableObject {
  readonly app = Cloudflare.app(Counter, { layer: Count.layer, title: "Counter on Cloudflare" })
  override fetch(request: Request): Promise<Response> {
    return this.app.fetch(request)
  }
}

interface Env {
  readonly ROOM: DurableObjectNamespace<Room>
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // One room for everyone. Derive the name from the path or a cookie for more.
    return env.ROOM.get(env.ROOM.idFromName("global")).fetch(request)
  }
} satisfies ExportedHandler<Env>
