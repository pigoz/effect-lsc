// Fault injection at the unit level: what the session does when handlers
// and renders fail, and what it leaves behind.
import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Ref, Scope } from "effect"
import { View } from "effect-lsc/view"
import { render } from "../src/internal/render.ts"
import { dispatch, makeSession } from "../src/internal/session.ts"
import { type Boundary, BoundaryTypeId } from "../src/internal/vnode.ts"

describe("failure semantics", () => {
  it.effect("a failed render leaves the instance dirty and without a node, so it is never memoized", () =>
    Effect.gen(function*() {
      const Child = View.Component(function*(p: { readonly explode: boolean }) {
        const n = yield* View.State(0)
        if (p.explode) return yield* Effect.die("boom")
        return <button onClick={() => n.update((x) => x + 1)}>{n.value}</button>
      })
      const App = (p: { readonly explode: boolean }) => <main><Child explode={p.explode} /></main>
      const session = yield* makeSession()
      yield* render(session, <App explode={false} />)
      const exit = yield* Effect.exit(render(session, <App explode={true} />))
      assert.isTrue(Exit.isFailure(exit))
      const child = session.instances.get("r.0.0")!
      assert.isTrue(child.dirty)
      assert.isUndefined(child.node)
      assert.strictEqual(session.handlers.size, 0)
      // the retry runs the body again and registers the handler again
      assert.strictEqual(yield* render(session, <App explode={false} />), `<main><button data-lsc-click="r.0.0.0">0</button></main>`)
      assert.isTrue(session.handlers.has("click:r.0.0.0"))
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0.0" })
      assert.include(yield* render(session, <App explode={false} />), ">1</button>")
    }))

  it.effect("a defect in a component body is a render failure too", () =>
    Effect.gen(function*() {
      const Bad = () => {
        throw new Error("thrown in render")
      }
      const session = yield* makeSession()
      const exit = yield* Effect.exit(render(session, <main><Bad /></main>))
      assert.isTrue(Exit.isFailure(exit))
    }))

  it.effect("an error boundary renders its fallback, keeps its siblings, and retries on change", () =>
    Effect.gen(function*() {
      const Risky = View.Component(function*(p: { readonly threshold: number }) {
        const n = yield* View.State(0)
        if (n.value >= p.threshold) return yield* Effect.die(`too high: ${n.value}`)
        return <button onClick={() => n.update((x) => x + 1)}>{n.value}</button>
      })
      const Sibling = View.Component(function*() {
        const clicks = yield* View.State(0)
        return <i onClick={() => clicks.update((c) => c + 1)}>{clicks.value}</i>
      })
      const App = (p: { readonly threshold: number }) => (
        <main>
          <View.ErrorBoundary fallback={(cause) => <p class="fallback">{Cause.squash(cause) as string}</p>}>
            <Risky threshold={p.threshold} />
          </View.ErrorBoundary>
          <Sibling />
        </main>
      )
      const session = yield* makeSession()
      const first = yield* render(session, <App threshold={1} />)
      assert.strictEqual(first, `<main><button data-lsc-click="r.0.0.0.0">0</button><i data-lsc-click="r.0.1.0">0</i></main>`)
      // the click pushes the state past the threshold: the subtree fails, the fallback shows
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0.0.0" })
      const failed = yield* render(session, <App threshold={1} />)
      assert.strictEqual(failed, `<main><p class="fallback">too high: 1</p><i data-lsc-click="r.0.1.0">0</i></main>`)
      // the sibling still works
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.1.0" })
      assert.include(yield* render(session, <App threshold={1} />), `<i data-lsc-click="r.0.1.0">1</i>`)
      // a change that makes the subtree valid again (props) retries it, state intact
      const recovered = yield* render(session, <App threshold={5} />)
      assert.strictEqual(recovered, `<main><button data-lsc-click="r.0.0.0.0">1</button><i data-lsc-click="r.0.1.0">1</i></main>`)
    }))

  it.effect("a failed boundary attempt forgets the handlers it registered, and a retry registers them again", () =>
    Effect.gen(function*() {
      const fired: Array<string> = []
      const Ok = View.Component(function*() {
        return <i onClick={() => Effect.sync(() => { fired.push("ok") })}>ok</i>
      })
      const Bad = View.Component(function*(p: { readonly explode: boolean }) {
        const n = yield* View.State(0)
        if (p.explode) return yield* Effect.die("boom")
        return <b onClick={() => n.update((x) => x + 1)}>{n.value}</b>
      })
      const App = (p: { readonly explode: boolean }) => (
        <View.ErrorBoundary fallback={() => <p>fallback</p>}>
          <button onClick={() => Effect.sync(() => { fired.push("button") })}>x</button>
          <Ok />
          <Bad explode={p.explode} />
        </View.ErrorBoundary>
      )
      const session = yield* makeSession()
      yield* render(session, <App explode={false} />)
      assert.deepStrictEqual([...session.handlers.keys()].sort(), ["click:r.0.0", "click:r.0.1.0", "click:r.0.2.0"])
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.2.0" })
      assert.include(yield* render(session, <App explode={false} />), ">1</b>")
      // Ok is memoized in the failed attempt; the button and Ok are no longer on the page
      assert.strictEqual(yield* render(session, <App explode={true} />), "<p>fallback</p>")
      assert.strictEqual(session.handlers.size, 0)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0" })
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.1.0" })
      assert.deepStrictEqual(fired, [])
      // the retry renders all three again, Bad's state intact, and their handlers work
      assert.strictEqual(
        yield* render(session, <App explode={false} />),
        `<button data-lsc-click="r.0.0">x</button><i data-lsc-click="r.0.1.0">ok</i><b data-lsc-click="r.0.2.0">1</b>`
      )
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0" })
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.1.0" })
      assert.deepStrictEqual(fired, ["button", "ok"])
    }))

  it.effect("a boundary retries when the component that failed changes its own state", () =>
    Effect.gen(function*() {
      let bump: Effect.Effect<void> = Effect.void
      const Bad = View.Component(function*() {
        const n = yield* View.State(0)
        bump = n.update((x) => x + 1)
        if (n.value === 1) return yield* Effect.die("boom")
        return <b>{n.value}</b>
      })
      const App = () => (
        <View.ErrorBoundary fallback={() => <p>fallback</p>}>
          <Bad />
        </View.ErrorBoundary>
      )
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <App />), "<b>0</b>")
      // the state changes outside any handler, as with a ticker started by View.once
      yield* bump
      assert.strictEqual(yield* render(session, <App />), "<p>fallback</p>")
      yield* bump
      assert.strictEqual(yield* render(session, <App />), "<b>2</b>")
    }))

  it.effect("a component in the fallback does not replace the component that failed", () =>
    Effect.gen(function*() {
      const Retry = View.Component(function*() {
        const clicks = yield* View.State(0)
        return <button onClick={() => clicks.update((n) => n + 1)}>retry {clicks.value}</button>
      })
      const Bad = View.Component(function*(p: { readonly explode: boolean }) {
        const n = yield* View.State(0)
        if (p.explode) return yield* Effect.die("boom")
        return <b onClick={() => n.update((x) => x + 1)}>{n.value}</b>
      })
      const App = (p: { readonly explode: boolean }) => (
        <View.ErrorBoundary fallback={() => <Retry />}>
          <Bad explode={p.explode} />
        </View.ErrorBoundary>
      )
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <App explode={false} />), `<b data-lsc-click="r.0.0.0">0</b>`)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0.0" })
      // the fallback renders under the boundary's `f` path, beside Bad
      assert.strictEqual(yield* render(session, <App explode={true} />), `<button data-lsc-click="r.0.f.0.0">retry 0</button>`)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.f.0.0" })
      assert.strictEqual(yield* render(session, <App explode={true} />), `<button data-lsc-click="r.0.f.0.0">retry 1</button>`)
      // the retry finds Bad's instance and state; the fallback's instance is closed
      assert.strictEqual(yield* render(session, <App explode={false} />), `<b data-lsc-click="r.0.0.0">1</b>`)
      assert.isFalse(session.instances.has("r.0.f.0"))
    }))

  it.effect("a boundary can recover with an Effect, and a failing recovery reaches the boundary above", () =>
    Effect.gen(function*() {
      const Bad = View.Component(function*(p: { readonly explode: boolean }) {
        if (p.explode) return yield* Effect.die("boom")
        return <b>ok</b>
      })
      // recovers with an Effect, or passes the failure on when `pass` is set
      const boundary: Boundary = {
        render: (props: { readonly children?: View.Child }) => props.children,
        recover: (cause, props: { readonly pass: boolean }) =>
          props.pass ? Effect.failCause(cause) : Effect.succeed(<p>inner: {String(Cause.squash(cause))}</p>)
      }
      const Recover = Object.assign(
        (props: { readonly pass: boolean; readonly children?: View.Child }) => props.children,
        { [BoundaryTypeId]: boundary }
      )
      const App = (p: { readonly explode: boolean; readonly pass: boolean }) => (
        <View.ErrorBoundary fallback={(cause) => <p>outer: {String(Cause.squash(cause))}</p>}>
          <Recover pass={p.pass}>
            <Bad explode={p.explode} />
          </Recover>
        </View.ErrorBoundary>
      )
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <App explode={false} pass={false} />), "<b>ok</b>")
      assert.strictEqual(yield* render(session, <App explode={true} pass={false} />), "<p>inner: boom</p>")
      assert.strictEqual(yield* render(session, <App explode={true} pass={true} />), "<p>outer: boom</p>")
      // both boundaries retry when the subtree changes
      assert.strictEqual(yield* render(session, <App explode={false} pass={true} />), "<b>ok</b>")
    }))

  it.effect("handler failures and defects are reported and the session goes on", () =>
    Effect.gen(function*() {
      const reported: Array<string> = []
      const report = (cause: Cause.Cause<unknown>) => Effect.sync(() => { reported.push(String(Cause.squash(cause))) })
      const Page = View.Component(function*() {
        const n = yield* View.State(0)
        return (
          <main>
            <button id="fail" onClick={() => Effect.andThen(n.update((x) => x + 1), Effect.fail(new Error("typed failure")))}>fail</button>
            <button id="throw" onClick={() => { throw new Error("thrown") }}>throw</button>
            <button id="ok" onClick={() => n.update((x) => x + 10)}>ok</button>
            <output>{n.value}</output>
          </main>
        )
      })
      const session = yield* makeSession()
      yield* render(session, <Page />)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0" }, report)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.1" }, report)
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.2" }, report)
      assert.deepStrictEqual(reported, ["Error: typed failure", "Error: thrown"])
      // the state change made before the typed failure stuck, and the ok handler ran after
      assert.include(yield* render(session, <Page />), "<output>11</output>")
    }))

  it.live("closing the session closes every instance and interrupts what they started", () =>
    Effect.gen(function*() {
      const ticks = yield* Ref.make(0)
      const closed = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const Ticker = View.Component(function*() {
        yield* View.once(Effect.forkScoped(
          Effect.forever(Effect.andThen(Effect.sleep("5 millis"), Ref.update(ticks, (n) => n + 1))).pipe(
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
          )
        ))
        yield* Effect.flatMap(View.Instance, (i) => Scope.addFinalizer(i.scope, Deferred.succeed(closed, undefined)))
        return <p>tick</p>
      })
      const scope = yield* Scope.make()
      const session = yield* Scope.provide(makeSession(), scope)
      yield* render(session, <Ticker />)
      yield* Effect.sleep("30 millis")
      assert.isTrue((yield* Ref.get(ticks)) > 0)
      yield* Scope.close(scope, Exit.void)
      assert.isTrue(yield* Deferred.isDone(closed))
      assert.isTrue(yield* Deferred.isDone(interrupted))
      const after = yield* Ref.get(ticks)
      yield* Effect.sleep("30 millis")
      assert.strictEqual(yield* Ref.get(ticks), after)
    }))
})
