import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Queue, Scope, SubscriptionRef } from "effect"
import { View } from "effect-lsc/view"
import { render } from "../src/internal/render.ts"
import { dispatch, makeSession, type Session } from "../src/internal/session.ts"

const handlerId = (html: string, event: string): string => {
  const match = html.match(new RegExp(`data-lsc-${event}="([^"]+)"`))
  if (match === null) throw new Error(`no ${event} handler in ${html}`)
  return match[1]!
}

const click = (session: Session, html: string) =>
  dispatch(session, { t: "event", type: "click", id: handlerId(html, "click") })

describe("session", () => {
  it.effect("state persists across renders and events schedule exactly one re-render", () =>
    Effect.gen(function*() {
      const Counter = View.Component(function*() {
        const count = yield* View.State(0)
        return <button onClick={() => count.update((n) => n + 1)}>{count.value}</button>
      })
      const session = yield* makeSession()
      const first = yield* render(session, <Counter />)
      assert.strictEqual(first, `<button data-lsc-click="r.0">0</button>`)

      yield* click(session, first)
      yield* click(session, first)
      yield* click(session, first)
      // three updates collapse into a single dirty signal
      yield* Queue.take(session.dirty)
      assert.strictEqual(yield* Queue.size(session.dirty), 0)

      const second = yield* render(session, <Counter />)
      assert.strictEqual(second, `<button data-lsc-click="r.0">3</button>`)
    }))

  it.effect("stale handler ids resolve to the current handler at that position", () =>
    Effect.gen(function*() {
      const Toggle = View.Component(function*() {
        const on = yield* View.State(false)
        return on.value
          ? <button onClick={() => on.set(false)}>on</button>
          : <button onClick={() => on.set(true)}>off</button>
      })
      const session = yield* makeSession()
      const first = yield* render(session, <Toggle />)
      yield* click(session, first)
      assert.strictEqual(yield* render(session, <Toggle />), `<button data-lsc-click="r.0">on</button>`)
      // the browser still shows the old DOM; its id maps to the new handler
      yield* click(session, first)
      assert.strictEqual(yield* render(session, <Toggle />), `<button data-lsc-click="r.0">off</button>`)
    }))

  it.effect("keyed child components keep their own state when reordered", () =>
    Effect.gen(function*() {
      const Item = View.Component(function*(props: { readonly id: string }) {
        const n = yield* View.State(0)
        return <li onClick={() => n.update((x) => x + 1)}>{props.id}:{n.value}</li>
      })
      const List = (props: { readonly ids: ReadonlyArray<string> }) => (
        <ul>{props.ids.map((id) => <Item key={id} id={id} />)}</ul>
      )
      const session = yield* makeSession()
      const first = yield* render(session, <List ids={["a", "b"]} />)
      assert.strictEqual(first, `<ul><li data-lsc-click="r.0.ka.0">a:0</li><li data-lsc-click="r.0.kb.0">b:0</li></ul>`)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.kb.0" })
      const second = yield* render(session, <List ids={["b", "a"]} />)
      assert.strictEqual(second, `<ul><li data-lsc-click="r.0.kb.0">b:1</li><li data-lsc-click="r.0.ka.0">a:0</li></ul>`)
    }))

  it.effect("instances that leave the tree are closed", () =>
    Effect.gen(function*() {
      const closed = yield* Deferred.make<void>()
      const Child = View.Component(function*() {
        yield* Effect.flatMap(View.Instance, (instance) =>
          Scope.addFinalizer(instance.scope, Deferred.succeed(closed, undefined)))
        return <span>child</span>
      })
      const session = yield* makeSession()
      yield* render(session, <div><Child /></div>)
      assert.isFalse(yield* Deferred.isDone(closed))
      yield* render(session, <div />)
      assert.isTrue(yield* Deferred.isDone(closed))
      assert.strictEqual(session.instances.size, 0)
    }))

  it.effect("a child watching a parent's State handle re-renders; identical values do not", () =>
    Effect.gen(function*() {
      const runs = { child: 0 }
      const Child = View.Component(function*(p: { readonly n: View.State<number> }) {
        runs.child++
        const n = yield* View.watch(p.n)
        return <b>{n}</b>
      })
      const Parent = View.Component(function*() {
        const n = yield* View.State(1)
        return (
          <div>
            <button onClick={() => n.set(2)}>two</button>
            <button onClick={() => n.set(n.value)}>same</button>
            <Child n={n} />
          </div>
        )
      })
      const session = yield* makeSession()
      const first = yield* render(session, <Parent />)
      assert.include(first, "<b>1</b>")
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.1" })
      assert.strictEqual(yield* Queue.size(session.dirty), 0)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0" })
      yield* Queue.take(session.dirty)
      assert.include(yield* render(session, <Parent />), "<b>2</b>")
      assert.strictEqual(runs.child, 2)
    }))

  it.effect("View.watch re-renders when a SharedState changes", () =>
    Effect.gen(function*() {
      const shared = yield* View.SharedState(1)
      const Show = View.Component(function*() {
        const value = yield* View.watch(shared)
        return <p>{value}</p>
      })
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <Show />), "<p>1</p>")
      const doubled = yield* shared.modify((n) => [n * 2, n + 1] as const)
      assert.strictEqual(doubled, 2)
      yield* Queue.take(session.dirty)
      assert.strictEqual(yield* render(session, <Show />), "<p>2</p>")
    }))

  it.effect("View.watch accepts a raw SubscriptionRef as an escape hatch", () =>
    Effect.gen(function*() {
      const shared = yield* SubscriptionRef.make(1)
      const Show = View.Component(function*() {
        const value = yield* View.watch(shared)
        return <p>{value}</p>
      })
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <Show />), "<p>1</p>")
      assert.strictEqual(yield* Queue.size(session.dirty), 0)
      yield* SubscriptionRef.set(shared, 2)
      yield* Queue.take(session.dirty)
      assert.strictEqual(yield* render(session, <Show />), "<p>2</p>")
    }))

  it.effect("nested single children get distinct handler ids", () =>
    Effect.gen(function*() {
      const hits: Array<string> = []
      const Nested = () => (
        <div onClick={() => Effect.sync(() => hits.push("div"))}>
          <button onClick={() => Effect.sync(() => hits.push("button"))}>x</button>
        </div>
      )
      const session = yield* makeSession()
      const html = yield* render(session, <Nested />)
      assert.strictEqual(html, `<div data-lsc-click="r.0"><button data-lsc-click="r.0.0">x</button></div>`)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0" })
      yield* dispatch(session, { t: "event", type: "click", id: "r.0" })
      assert.deepStrictEqual(hits, ["button", "div"])
    }))

  it.effect("View.connected tells the HTTP render from the live session", () =>
    Effect.gen(function*() {
      const Probe = View.Component(function*() {
        const live = yield* View.connected
        return <p>{live ? "live" : "static"}</p>
      })
      assert.strictEqual(yield* View.render(<Probe />), "<p>static</p>")
      const session = yield* makeSession(true)
      assert.strictEqual(yield* render(session, <Probe />), "<p>live</p>")
    }))

  it.effect("handler failures are logged, not fatal", () =>
    Effect.gen(function*() {
      const Boom = () => <button onClick={() => Effect.fail("nope")}>x</button>
      const session = yield* makeSession()
      const html = yield* render(session, <Boom />)
      yield* click(session, html)
      yield* dispatch(session, { t: "event", type: "click", id: "does-not-exist" })
    }))
})
