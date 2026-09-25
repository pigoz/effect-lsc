// View.catchTag, View.catchTags, View.orDie: typed render errors handled where a component is defined.
import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Data, Effect, Exit, Logger, Ref } from "effect"
import { View } from "effect-lsc/view"
import { render } from "../src/internal/render.ts"
import { dispatch, makeSession } from "../src/internal/session.ts"
import { jsx } from "../src/internal/vnode.ts"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
class Denied extends Data.TaggedError("Denied")<{}> {}

const Leaf = View.Component(function*(props: { readonly id: string }) {
  if (props.id === "missing") return yield* new NotFound({ id: props.id })
  if (props.id === "secret") return yield* new Denied()
  return <b>{props.id}</b>
})
const Parent = View.Component(function*(props: { readonly id: string }) {
  const n = yield* View.State(0)
  const L = yield* View.use(Leaf)
  return <p onClick={() => n.update((x) => x + 1)}>{n.value} <L id={props.id} /></p>
})

describe("typed error boundaries", () => {
  it.effect("catchTag catches errors of the used subtree, with the props, at the same path", () =>
    Effect.gen(function*() {
      const Safe = View.catchTag(Parent, "NotFound", (error, props) => <i>no {error.id} ({props.id})</i>)
      const session = yield* makeSession()
      // no extra level: Parent's own element is at r.0, as without the boundary
      assert.strictEqual(yield* render(session, jsx(Safe, { id: "a" })), `<p data-lsc-click="r.0">0 <b>a</b></p>`)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0" })
      assert.strictEqual(yield* render(session, jsx(Safe, { id: "missing" })), `<i>no missing (missing)</i>`)
      // retried on change, with the state of the failed attempt kept
      assert.strictEqual(yield* render(session, jsx(Safe, { id: "b" })), `<p data-lsc-click="r.0">1 <b>b</b></p>`)
    }))

  it.effect("unmatched errors pass through to the next boundary; catchTags handles several", () =>
    Effect.gen(function*() {
      const OnlyNotFound = View.catchTag(Parent, "NotFound", () => <i>nf</i>)
      const Page = (p: { readonly id: string }) => (
        <View.ErrorBoundary fallback={(cause) => <u>{Cause.squash(cause) instanceof Denied ? "denied" : "other"}</u>}>
          {jsx(OnlyNotFound, p)}
        </View.ErrorBoundary>
      )
      assert.strictEqual(yield* View.render(<Page id="secret" />), "<u>denied</u>")
      const Both = Parent.pipe(View.catchTags({ NotFound: () => <i>nf</i>, Denied: () => <i>denied</i> }))
      assert.strictEqual(yield* View.render(<Both id="secret" />), "<i>denied</i>")
      assert.strictEqual(yield* View.render(<Both id="missing" />), "<i>nf</i>")
    }))

  it.effect("catchTags lets the tag of an undefined handler through", () =>
    Effect.gen(function*() {
      // `Denied: cond ? f : undefined` compiles without exactOptionalPropertyTypes
      const cases: Record<string, unknown> = { NotFound: () => <i>nf</i>, Denied: undefined }
      const Some = View.catchTags(Parent, cases as { readonly NotFound: () => View.Child })
      const Page = (p: { readonly id: string }) => (
        <View.ErrorBoundary fallback={(cause) => <u>{Cause.squash(cause) instanceof Denied ? "denied" : "other"}</u>}>
          {jsx(Some, p)}
        </View.ErrorBoundary>
      )
      assert.strictEqual(yield* View.render(<Page id="secret" />), "<u>denied</u>")
      assert.strictEqual(yield* View.render(<Page id="missing" />), "<i>nf</i>")
    }))

  it.effect("an effectful handler runs in the render; a failing one passes the failure on", () =>
    Effect.gen(function*() {
      class Greeting extends Context.Service<Greeting, string>()("test/Greeting") {}
      const Greet = View.catchTag(Leaf, "NotFound", (error) =>
        Effect.gen(function*() {
          const greeting = yield* Greeting
          return <i>{greeting} {error.id}</i>
        }))
      assert.strictEqual(
        yield* View.render(Greet, { id: "missing" }).pipe(Effect.provideService(Greeting, "hello")),
        "<i>hello missing</i>"
      )
      const Rethrow = View.catchTag(Leaf, "NotFound", () => Effect.fail(new Denied()))
      const exit = yield* Effect.exit(View.render(Rethrow, { id: "missing" }))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause)
        assert.isTrue(error._tag === "Some" && error.value instanceof Denied)
      }
    }))

  it.effect("called as a function, a boundary returns a node of itself: it is never skipped", () =>
    Effect.gen(function*() {
      const Safe = View.catchTag(Leaf, "NotFound", () => <i>caught</i>)
      const Outer = View.Component(function*() {
        return yield* Safe({ id: "missing" })
      })
      assert.strictEqual(yield* View.render(Outer), "<i>caught</i>")
      const Throws = (): View.Child => {
        throw new Error("boom")
      }
      const Guarded = () => View.ErrorBoundary({ fallback: () => <i>fallback</i>, children: <Throws /> })
      assert.strictEqual(yield* View.render(Guarded), "<i>fallback</i>")
    }))

  it.effect("orDie turns typed errors into defects for ErrorBoundary, keeping the rest of the cause", () =>
    Effect.gen(function*() {
      const Dies = View.orDie(Leaf)
      const seen = yield* Ref.make<Cause.Cause<unknown> | undefined>(undefined)
      const html = yield* View.render(
        <View.ErrorBoundary fallback={(cause) => { Effect.runSync(Ref.set(seen, cause)); return <u>defect</u> }}>
          <Dies id="missing" />
        </View.ErrorBoundary>
      )
      assert.strictEqual(html, "<u>defect</u>")
      const cause = (yield* Ref.get(seen))!
      assert.isFalse(Cause.hasFails(cause))
      assert.isTrue(Cause.hasDies(cause))
      assert.deepStrictEqual(Cause.squash(cause), new NotFound({ id: "missing" }))
    }))

  it.effect("a boundary created during a render remounts every time, and says so", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const logger = Logger.make(({ message }) => { logs.push(String(message)) })
      const Counter = View.Component(function*() {
        const n = yield* View.State(0)
        return <b onClick={() => n.update((x) => x + 1)}>{n.value}</b>
      })
      const Page = View.Component(function*() {
        const C = yield* View.use(View.orDie(Counter)) // wrong: a new component every render
        return <C />
      })
      const session = yield* makeSession()
      yield* render(session, jsx(Page, {}))
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0" })
      const html = yield* render(session, jsx(Page, {})).pipe(Effect.provide(Logger.layer([logger])))
      assert.strictEqual(html, `<b data-lsc-click="r.0.0">0</b>`)
      assert.isTrue(logs.some((line) => line.includes("replaced by another wrapper of the same component")))
    }))
})
