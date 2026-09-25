// Deliberate mistakes: test/types/messages.test.ts checks that each error names the fix.
import { Context, Data, Effect, Layer } from "effect"
import { Cloudflare } from "effect-lsc/cloudflare"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
class Db extends Context.Service<Db, { readonly name: string }>()("m/Db") {}
const Name = View.Component(function*() {
  const db = yield* Db
  return <b>{db.name}</b>
})
const Leaky = View.Component(function*() {
  yield* Effect.addFinalizer(() => Effect.void)
  return <p />
})
const Missing = View.Component(function*(props: { readonly id: string }) {
  return yield* new NotFound({ id: props.id })
})

export const notUsed = <Name />
export const scope = View.use(Leaky)
export const stateful = View.catchTag(Missing, "NotFound", () => Effect.map(View.State(0), (n) => <p>{n.value}</p>))
export const unhandled = Server.mount("/", () => Missing({ id: "1" }))
export const missing = Cloudflare.app(Name, { layer: Layer.empty })
export const rootScope = Server.mount("/", Leaky)
export const statefulLayer = View.provide(Name, Layer.effect(Db, Effect.map(View.State("tab"), (name) => ({ name: name.value }))))
