// Type tests: Effect atoms in components.
import { Effect, Layer } from "effect"
import type { HttpRouter } from "effect/unstable/http"
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"
import { check, Db, type Equals, type Fn, NotFound } from "./util.ts"

const count = Atom.make(0).pipe(Atom.keepAlive)
const doubled = Atom.map(count, (n) => n * 2)
const runtime = Atom.runtime(Layer.succeed(Db, { load: (id) => id === "x" ? Effect.fail(new NotFound({ id })) : Effect.succeed(id) }))
  .pipe(Atom.keepAlive)
const title = Atom.family((id: string) =>
  runtime.atom(Effect.gen(function*() {
    const db = yield* Db
    return yield* db.load(id)
  }))
)
const rename = runtime.fn((name: string) => Effect.succeed(name.toUpperCase()))

// watch infers the value; an atom adds AtomRegistry to R
export const readCount = View.watch(count)
check<Equals<typeof readCount, Effect.Effect<number, never, View.Instance | AtomRegistry.AtomRegistry>>>()
export const readDoubled = View.watch(doubled)
check<Equals<Effect.Success<typeof readDoubled>, number>>()
export const readTitle = View.watch(title("a"))
check<Equals<Effect.Success<typeof readTitle>, AsyncResult.AsyncResult<string, NotFound>>>()
export const readRename = View.watch(rename)
check<Equals<Effect.Success<typeof readRename>, AsyncResult.AsyncResult<string, never>>>()
// View.State still resolves to the other overload
export const readState = Effect.flatMap(View.State(1), (state) => View.watch(state))
check<Equals<typeof readState, Effect.Effect<number, never, View.Instance>>>()

// a component watching atoms is used, and the root must provide the registry
const Counter = View.Component(function*() {
  const registry = yield* AtomRegistry.AtomRegistry
  const n = yield* View.watch(count)
  // handlers write through the registry taken in the body
  return <button onClick={() => registry.update(count, (x) => x + 1)}>{n}</button>
})
// @ts-expect-error needs AtomRegistry
export const counterTag = <Counter />
const App = View.Component(function*() {
  const C = yield* View.use(Counter)
  return <C />
})
export const app = Server.mount("/", App)
check<Equals<typeof app, Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request<"Requires", AtomRegistry.AtomRegistry>>>>()

// Atom.set needs AtomRegistry, which handlers cannot require
export const BadHandler = View.Component(function*() {
  const n = yield* View.watch(count)
  // @ts-expect-error Handler has R = never
  return <button onClick={() => Atom.set(count, 0)}>{n}</button>
})

// rendering an AsyncResult: exhaustive() only exists when every error is handled
export const Title = View.Component(function*(props: { readonly id: string }) {
  const result = yield* View.watch(title(props.id))
  return AsyncResult.builder(result)
    .onInitial(() => <p>loading</p>)
    .onErrorTag("NotFound", (error) => <p>no {error.id}</p>)
    .onDefect(() => <p>broken</p>)
    .onInterrupt(() => <p>stopped</p>)
    .onSuccess((value) => <h1>{value}</h1>)
    .exhaustive()
})
// View.result moves the atom's error into the component's
export const Waiting = View.Component(function*(props: { readonly id: string }) {
  const value = yield* View.result(title(props.id))
  return <h1>{value}</h1>
})
check<Equals<Fn<typeof Waiting>, (props: { readonly id: string }) => Effect.Effect<View.VNode, NotFound, View.Instance | AtomRegistry.AtomRegistry>>>()
export const SafeWaiting = View.catchTag(Waiting, "NotFound", (error) => <p>no {error.id}</p>)
export const partial = (result: AsyncResult.AsyncResult<string, NotFound>) =>
  AsyncResult.builder(result)
    .onInitial(() => null)
    .onDefect(() => null)
    .onInterrupt(() => null)
    .onSuccess((value) => value)
    // @ts-expect-error NotFound is not handled, so exhaustive() does not exist
    .exhaustive()
