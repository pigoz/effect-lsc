// View.use: bringing components with services and typed errors into a parent.
import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Data, Effect, Exit, Layer } from "effect"
import { View } from "effect-lsc/view"
import { render } from "../src/internal/render.ts"
import { dispatch, makeSession } from "../src/internal/session.ts"
import { jsx } from "../src/internal/vnode.ts"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
class Db extends Context.Service<Db, { readonly load: (id: string) => Effect.Effect<string, NotFound> }>()("test/Db") {}
const DbLive = Layer.succeed(Db, {
  load: (id: string) => id === "missing" ? Effect.fail(new NotFound({ id })) : Effect.succeed(id.toUpperCase())
})

const Item = View.Component(function*(props: { readonly id: string }) {
  const db = yield* Db
  const clicks = yield* View.State(0)
  const name = yield* db.load(props.id)
  return <li onClick={() => clicks.update((n) => n + 1)}>{name} {clicks.value}</li>
})

describe("View.use", () => {
  it.effect("returns the same component: the child keeps its instance and state across parent renders", () =>
    Effect.gen(function*() {
      const List = View.Component(function*(props: { readonly ids: ReadonlyArray<string> }) {
        const Row = yield* View.use(Item)
        assert.strictEqual(Row, Item as unknown)
        return <ul>{props.ids.map((id) => <Row key={id} id={id} />)}</ul>
      })
      const session = yield* makeSession()
      yield* render(session, jsx(List, { ids: ["a", "b"] }))
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.ka.0" })
      assert.strictEqual(
        yield* render(session, jsx(List, { ids: ["b", "a"] })),
        `<ul><li data-lsc-click="r.0.kb.0">B 0</li><li data-lsc-click="r.0.ka.0">A 1</li></ul>`
      )
    }).pipe(Effect.provide(DbLive)))

  it.effect("takes no slot, so it may be called conditionally", () =>
    Effect.gen(function*() {
      // If `use` took a slot, `count` would read another slot once `use` is skipped.
      const Page = View.Component(function*(props: { readonly show: boolean }) {
        const Row = props.show ? yield* View.use(Item) : undefined
        const count = yield* View.State(7)
        return <ul onClick={() => count.update((n) => n + 1)}>{count.value}{Row && <Row id="x" />}</ul>
      })
      const session = yield* makeSession()
      assert.strictEqual(
        yield* render(session, jsx(Page, { show: true })),
        `<ul data-lsc-click="r.0">7<li data-lsc-click="r.0.1.0">X 0</li></ul>`
      )
      yield* dispatch(session, { t: "event", type: "click", id: "r.0" })
      assert.strictEqual(yield* render(session, jsx(Page, { show: false })), `<ul data-lsc-click="r.0">8</ul>`)
    }).pipe(Effect.provide(DbLive)))

  it.effect("View.render of a component fails with the subtree's typed error, and needs its services", () =>
    Effect.gen(function*() {
      const Page = View.Component(function*() {
        const Row = yield* View.use(Item)
        return <ul><Row id="missing" /></ul>
      })
      const exit = yield* Effect.exit(View.render(Page))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause)
        assert.isTrue(error._tag === "Some" && error.value instanceof NotFound && error.value.id === "missing")
      }
      assert.strictEqual(yield* View.render(Item, { id: "ok" }), `<li data-lsc-click="r.0">OK 0</li>`)
    }).pipe(Effect.provide(DbLive)))
})
