// View.watch follows a new source passed at the same position.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Queue, SubscriptionRef } from "effect"
import { View } from "effect-lsc/view"
import { render } from "../src/internal/render.ts"
import { dispatch, makeSession, type Session } from "../src/internal/session.ts"

/** Lets forked subscriptions deliver, then tells whether a render was requested. */
const isDirty = (session: Session) =>
  Effect.gen(function*() {
    for (let i = 0; i < 5; i++) yield* Effect.yieldNow
    const dirty = (yield* Queue.size(session.dirty)) > 0
    yield* Queue.clear(session.dirty)
    return dirty
  })

const Show = View.Component(function*(props: { readonly source: View.Watchable<number> }) {
  const value = yield* View.watch(props.source)
  return <b>{value}</b>
})

describe("View.watch", () => {
  it.effect("follows a different SharedState at the same position", () =>
    Effect.gen(function*() {
      const a = yield* View.SharedState(1)
      const b = yield* View.SharedState(10)
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <Show source={a} />), "<b>1</b>")
      assert.strictEqual(yield* render(session, <Show source={b} />), "<b>10</b>")
      yield* a.set(2)
      assert.isFalse(yield* isDirty(session), "the old source is released")
      yield* b.set(11)
      assert.isTrue(yield* isDirty(session), "the new source is watched")
      assert.strictEqual(yield* render(session, <Show source={b} />), "<b>11</b>")
      // and back again
      assert.strictEqual(yield* render(session, <Show source={a} />), "<b>2</b>")
      yield* b.set(12)
      assert.isFalse(yield* isDirty(session))
      yield* a.set(3)
      assert.isTrue(yield* isDirty(session))
    }))

  it.effect("follows a different State handle at the same position", () =>
    Effect.gen(function*() {
      const runs = { show: 0 }
      const Counted = View.Component(function*(props: { readonly source: View.State<number> }) {
        runs.show++
        const value = yield* View.watch(props.source)
        return <b>{value}</b>
      })
      const Owner = View.Component(function*(props: { readonly second: boolean }) {
        const a = yield* View.State(1)
        const b = yield* View.State(10)
        return (
          <div>
            <button onClick={() => a.update((n) => n + 1)}>a</button>
            <button onClick={() => b.update((n) => n + 1)}>b</button>
            <Counted source={props.second ? b : a} />
          </div>
        )
      })
      const session = yield* makeSession()
      assert.include(yield* render(session, <Owner second={false} />), "<b>1</b>")
      assert.include(yield* render(session, <Owner second />), "<b>10</b>")
      assert.strictEqual(runs.show, 2)
      // the owner re-renders; Counted no longer watches `a`, so it is reused
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0" })
      assert.include(yield* render(session, <Owner second />), "<b>10</b>")
      assert.strictEqual(runs.show, 2)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.1" })
      assert.include(yield* render(session, <Owner second />), "<b>11</b>")
      assert.strictEqual(runs.show, 3)
    }))

  it.effect("releasing a watch of its own state keeps the component subscribed to it", () =>
    Effect.gen(function*() {
      const Pick = View.Component(function*(props: { readonly other?: View.SharedState<number> | undefined }) {
        const own = yield* View.State(0)
        const value = yield* View.watch(props.other ?? own)
        return <button onClick={() => own.update((n) => n + 1)}>{value}/{own.value}</button>
      })
      const other = yield* View.SharedState(10)
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <Pick />), `<button data-lsc-click="r.0">0/0</button>`)
      assert.strictEqual(yield* render(session, <Pick other={other} />), `<button data-lsc-click="r.0">10/0</button>`)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0" })
      assert.isTrue(yield* isDirty(session), "a change of its own state still re-renders it")
      assert.strictEqual(yield* render(session, <Pick other={other} />), `<button data-lsc-click="r.0">10/1</button>`)
    }))

  it.effect("follows a different SubscriptionRef, and releases the last one on unmount", () =>
    Effect.gen(function*() {
      const a = yield* SubscriptionRef.make(1)
      const b = yield* SubscriptionRef.make(10)
      const Page = (props: { readonly source: View.Watchable<number> | undefined }) =>
        props.source === undefined ? <i>none</i> : <Show source={props.source} />
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <Page source={a} />), "<b>1</b>")
      assert.strictEqual(yield* render(session, <Page source={b} />), "<b>10</b>")
      yield* SubscriptionRef.set(a, 2)
      assert.isFalse(yield* isDirty(session), "the old source is released")
      yield* SubscriptionRef.set(b, 11)
      assert.isTrue(yield* isDirty(session), "the new source is watched")
      assert.strictEqual(yield* render(session, <Page source={b} />), "<b>11</b>")
      yield* render(session, <Page source={undefined} />)
      yield* SubscriptionRef.set(b, 12)
      assert.isFalse(yield* isDirty(session), "the last source is released with the instance")
    }))
})
