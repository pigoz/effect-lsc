// View.provide: a layer for a component and its whole subtree, with the instance's lifetime.
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect"
import { View } from "effect-lsc/view"
import { render } from "../src/internal/render.ts"
import { dispatch, makeSession } from "../src/internal/session.ts"
import { jsx } from "../src/internal/vnode.ts"

class Cache extends Context.Service<Cache, { readonly id: number }>()("test/Cache") {}

const Leaf = View.Component(function*() {
  const cache = yield* Cache
  return <b>{cache.id}</b>
})

/** A Cache layer whose builds and releases are logged, with a new id per build. */
const logged = (log: Array<string>) => {
  let next = 0
  return Layer.effect(
    Cache,
    Effect.acquireRelease(
      Effect.sync(() => {
        log.push("build")
        return { id: ++next }
      }),
      () => Effect.sync(() => { log.push("release") })
    )
  )
}

describe("View.provide", () => {
  it.effect("builds the layer once per instance, for the whole subtree, and releases it on unmount", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const Middle = View.Component(function*(props: { readonly n: number }) {
        const clicks = yield* View.State(0)
        const L = yield* View.use(Leaf)
        return <p onClick={() => clicks.update((x) => x + 1)}>{props.n}/{clicks.value} <L /></p>
      })
      const WithCache = View.provide(Middle, logged(log))
      const Page = (p: { readonly show: boolean; readonly n: number }) => p.show ? <WithCache n={p.n} /> : <i>none</i>
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <Page show n={1} />), `<p data-lsc-click="r.0.0">1/0 <b>1</b></p>`)
      // no extra level, and the component's own state is kept beside the layer
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0" })
      assert.strictEqual(yield* render(session, <Page show n={2} />), `<p data-lsc-click="r.0.0">2/1 <b>1</b></p>`)
      assert.deepStrictEqual(log, ["build"])
      yield* render(session, <Page show={false} n={2} />)
      assert.deepStrictEqual(log, ["build", "release"])
      // remounted: a new instance, a new build
      assert.strictEqual(yield* render(session, <Page show n={3} />), `<p data-lsc-click="r.0.0">3/0 <b>2</b></p>`)
      assert.deepStrictEqual(log, ["build", "release", "build"])
    }))

  it.effect("closes the subtree before releasing the layer", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const Child = View.Component(function*() {
        const cache = yield* Cache
        yield* View.once(Effect.addFinalizer(() => Effect.sync(() => { log.push(`child uses ${cache.id}`) })))
        return <b>{cache.id}</b>
      })
      const Middle = View.Component(function*() {
        const C = yield* View.use(Child)
        return <p><C /></p>
      })
      const WithCache = View.provide(Middle, logged(log))
      const Other = () => <i>other</i>
      const Page = (p: { readonly show: "cache" | "other" | "none" }) =>
        p.show === "cache" ? <WithCache /> : p.show === "other" ? <Other /> : null
      const session = yield* makeSession()
      yield* render(session, <Page show="cache" />)
      // replaced by another component at its path
      yield* render(session, <Page show="other" />)
      assert.deepStrictEqual(log, ["build", "child uses 1", "release"])
      yield* render(session, <Page show="cache" />)
      // removed from the page
      yield* render(session, <Page show="none" />)
      assert.deepStrictEqual(log, ["build", "child uses 1", "release", "build", "child uses 2", "release"])
    }))

  it.effect("a component moved out of or into it remounts with the services above it", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const Child = View.Component(function*() {
        const cache = yield* Cache
        yield* View.once(Effect.addFinalizer(() => Effect.sync(() => { log.push(`child uses ${cache.id}`) })))
        return <b onClick={() => { log.push(`click uses ${cache.id}`) }}>{cache.id}</b>
      })
      const Middle = View.Component(function*() {
        const C = yield* View.use(Child)
        return <C />
      })
      const WithCache = View.provide(Middle, logged(log))
      // Child sits at r.0.0 in both branches, under another parent
      const Page = View.Component(function*(p: { readonly cached: boolean }) {
        const C = yield* View.use(Child)
        return p.cached ? <WithCache /> : <div><C /></div>
      })
      const app = Layer.succeed(Cache, { id: 100 })
      const session = yield* makeSession()
      const renderPage = (cached: boolean) => render(session, jsx(Page, { cached })).pipe(Effect.provide(app))
      assert.strictEqual(yield* renderPage(true), `<b data-lsc-click="r.0.0.0">1</b>`)
      // out of it: the child closes before the layer is released
      assert.strictEqual(yield* renderPage(false), `<div><b data-lsc-click="r.0.0.0">100</b></div>`)
      assert.deepStrictEqual(log, ["build", "child uses 1", "release"])
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0.0" })
      assert.deepStrictEqual(log.slice(3), ["click uses 100"])
      // into it
      assert.strictEqual(yield* renderPage(true), `<b data-lsc-click="r.0.0.0">2</b>`)
      assert.deepStrictEqual(log.slice(4), ["build", "child uses 100"])
    }))

  it.effect("a failing finalizer is logged and does not fail the render", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const logger = Logger.make(({ message }) => { logs.push(String(message)) })
      const Bad = View.Component(function*() {
        yield* View.once(Effect.addFinalizer(() => Effect.die("finalizer bug")))
        return <b>bad</b>
      })
      const Other = () => <i>other</i>
      const Page = (p: { readonly show: "bad" | "other" | "none" }) => (
        <View.ErrorBoundary fallback={() => <u>fallback</u>}>
          {p.show === "bad" ? <Bad /> : p.show === "other" ? <Other /> : null}
        </View.ErrorBoundary>
      )
      const session = yield* makeSession()
      const renderPage = (show: "bad" | "other" | "none") =>
        render(session, <Page show={show} />).pipe(Effect.provide(Logger.layer([logger])))
      yield* renderPage("bad")
      // replaced by another component inside a boundary: the new one renders
      assert.strictEqual(yield* renderPage("other"), "<i>other</i>")
      yield* renderPage("bad")
      // removed from the page
      assert.strictEqual(yield* renderPage("none"), "")
      const failed = logs.filter((line) => line.includes("effect-lsc: a finalizer of the component at r.0.0 failed"))
      assert.strictEqual(failed.length, 2)
    }))

  it.effect("builds its own copy of a layer already built above it", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const layer = logged(log)
      const Inner = View.provide(Leaf, layer)
      const Outer = View.provide(
        View.Component(function*() {
          const cache = yield* Cache
          const I = yield* View.use(Inner)
          return <p>{cache.id} <I /></p>
        }),
        layer
      )
      // by an enclosing View.provide
      assert.strictEqual(yield* render(yield* makeSession(), jsx(Outer, {})), "<p>1 <b>2</b></p>")
      // by the environment, as the application's layers are
      const html = yield* render(yield* makeSession(), jsx(Inner, {})).pipe(Effect.provide(layer))
      assert.strictEqual(html, "<b>4</b>")
      assert.strictEqual(log.filter((line) => line === "build").length, 4)
    }))

  it.effect("at the root, builds the layer once per session", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const Root = View.provide(Leaf, logged(log))
      const a = yield* Scope.make()
      const b = yield* Scope.make()
      const first = yield* Scope.provide(makeSession(), a)
      const second = yield* Scope.provide(makeSession(), b)
      assert.strictEqual(yield* render(first, jsx(Root, {})), "<b>1</b>")
      assert.strictEqual(yield* render(second, jsx(Root, {})), "<b>2</b>")
      assert.strictEqual(yield* render(first, jsx(Root, {})), "<b>1</b>")
      assert.deepStrictEqual(log, ["build", "build"])
      yield* Scope.close(a, Exit.void)
      assert.deepStrictEqual(log, ["build", "build", "release"])
      yield* Scope.close(b, Exit.void)
    }))

  it.effect("a failing build fails the render, up to the next boundary, until the component remounts", () =>
    Effect.gen(function*() {
      let builds = 0
      const Broken = View.provide(Leaf, Layer.effect(Cache, Effect.suspend(() => {
        builds++
        return Effect.die("no cache")
      })))
      const Page = (p: { readonly show: boolean; readonly n: number }) => (
        <View.ErrorBoundary fallback={() => <u>fallback {p.n}</u>}>
          {p.show ? <Broken /> : null}
        </View.ErrorBoundary>
      )
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <Page show n={1} />), "<u>fallback 1</u>")
      // the boundary retries: the failed build is kept, not run again
      assert.strictEqual(yield* render(session, <Page show n={2} />), "<u>fallback 2</u>")
      assert.strictEqual(builds, 1)
      yield* render(session, <Page show={false} n={3} />)
      assert.strictEqual(yield* render(session, <Page show n={4} />), "<u>fallback 4</u>")
      assert.strictEqual(builds, 2)
    }))
})
