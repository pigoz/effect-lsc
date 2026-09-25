// Deliberate mistakes: test/types/messages.test.ts checks that each error names the fix.
import { Context, Effect } from "effect"
import { View } from "effect-lsc/view"

class Db extends Context.Service<Db, { readonly name: string }>()("m/Db") {}
const Name = View.Component(function*() {
  const db = yield* Db
  return <b>{db.name}</b>
})
const Leaky = View.Component(function*() {
  yield* Effect.addFinalizer(() => Effect.void)
  return <p />
})

export const notUsed = <Name />
export const scope = View.use(Leaky)
