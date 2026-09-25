// Effect atoms in components: View.watch(atom), View.result, lifetimes and pitfalls.
import { assert, describe, it } from "@effect/vitest"
import { Context, Data, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import { View } from "effect-lsc/view"
import { render } from "../src/internal/render.ts"
import { dispatch, makeSession, type Session } from "../src/internal/session.ts"
import { jsx } from "../src/internal/vnode.ts"

// Components that need services cannot be JSX tags; tests build the root node
// with the untyped factory and provide the services around the render.
const root = (component: (props: {}) => unknown) => jsx(component, {})
const tick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
const sleep = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const isDirty = (session: Session) => Effect.map(Queue.size(session.dirty), (n) => n > 0)
const click = (session: Session, id: string) => dispatch(session, { t: "event", type: "click", id })

describe("View.watch(atom)", () => {
  it.live("renders, and a write from any session dirties every watching session; mounting schedules nothing", () =>
    Effect.gen(function*() {
      const count = Atom.make(0).pipe(Atom.keepAlive)
      const Counter = View.Component(function*() {
        const registry = yield* AtomRegistry.AtomRegistry
        const n = yield* View.watch(count)
        return <button onClick={() => registry.update(count, (x) => x + 1)}>{n}</button>
      })
      const a = yield* makeSession()
      const b = yield* makeSession()
      assert.strictEqual(yield* render(a, root(Counter)), `<button data-lsc-click="r.0">0</button>`)
      yield* render(b, root(Counter))
      assert.isFalse(yield* isDirty(a))
      assert.isFalse(yield* isDirty(b))
      yield* click(a, "r.0")
      assert.isTrue(yield* isDirty(a))
      assert.isTrue(yield* isDirty(b))
      assert.strictEqual(yield* render(b, root(Counter)), `<button data-lsc-click="r.0">1</button>`)
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("the slot follows a new atom at the same position (families keyed by props)", () =>
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      const byId = Atom.family((id: string) => Atom.make(`v-${id}`).pipe(Atom.keepAlive))
      const Item = View.Component(function*(props: { readonly id: string }) {
        return <i>{yield* View.watch(byId(props.id))}</i>
      })
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, jsx(Item, { id: "a" })), `<i>v-a</i>`)
      assert.strictEqual(yield* render(session, jsx(Item, { id: "b" })), `<i>v-b</i>`)
      yield* Queue.clear(session.dirty)
      registry.set(byId("a"), "changed")
      assert.isFalse(yield* isDirty(session))
      registry.set(byId("b"), "changed")
      assert.isTrue(yield* isDirty(session))
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("the subscription ends with the instance: autoDispose atoms are dropped, keepAlive ones kept", () =>
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      const plain = Atom.make(0)
      const kept = Atom.make(0).pipe(Atom.keepAlive)
      const Show = View.Component(function*() {
        return <b>{yield* View.watch(plain)} {yield* View.watch(kept)}</b>
      })
      const Page = View.Component(function*(props: { readonly show: boolean }) {
        const S = yield* View.use(Show)
        return props.show ? <S /> : <i />
      })
      const session = yield* makeSession()
      yield* render(session, jsx(Page, { show: true }))
      registry.set(plain, 5)
      registry.set(kept, 5)
      yield* render(session, jsx(Page, { show: false }))
      yield* tick
      assert.strictEqual(registry.get(plain), 0)
      assert.strictEqual(registry.get(kept), 5)
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("sync effect atoms resolve in the render; async ones render Initial, then wake the session", () =>
    Effect.gen(function*() {
      const now = Atom.make(Effect.succeed("now"))
      const later = Atom.make(Effect.as(Effect.sleep("10 millis"), "later"))
      const show = (r: AsyncResult.AsyncResult<string>) =>
        AsyncResult.builder(r).onInitial(() => "…").onSuccess((v) => v).onFailure(() => "!").exhaustive()
      const Show = View.Component(function*() {
        const a = yield* View.watch(now)
        const b = yield* View.watch(later)
        return <p>{show(a)} {show(b)}</p>
      })
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, root(Show)), `<p>now …</p>`)
      yield* Queue.take(session.dirty)
      assert.strictEqual(yield* render(session, root(Show)), `<p>now later</p>`)
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("typed errors of effectful atoms: data with watch, the component's error with View.result", () =>
    Effect.gen(function*() {
      class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
      class Catalog extends Context.Service<Catalog, { readonly find: (id: string) => Effect.Effect<string, NotFound> }>()("test/Catalog") {}
      const runtime = Atom.runtime(Layer.succeed(Catalog, {
        find: (id: string) => id === "x" ? Effect.fail(new NotFound({ id })) : Effect.succeed(id.toUpperCase())
      })).pipe(Atom.keepAlive)
      const item = Atom.family((id: string) =>
        runtime.atom(Effect.gen(function*() {
          const catalog = yield* Catalog
          return yield* catalog.find(id)
        }))
      )
      const Watched = View.Component(function*(props: { readonly id: string }) {
        const result = yield* View.watch(item(props.id))
        return AsyncResult.builder(result)
          .onInitial(() => <p>…</p>)
          .onErrorTag("NotFound", (error) => <p>no {error.id}</p>)
          .onDefect(() => <p>broken</p>)
          .onInterrupt(() => <p>stopped</p>)
          .onSuccess((value) => <p>{value}</p>)
          .exhaustive()
      })
      const Waited = View.Component(function*(props: { readonly id: string }) {
        return <p>{yield* View.result(item(props.id))}</p>
      }).pipe(View.catchTag("NotFound", (error) => <p>missing {error.id}</p>))
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, jsx(Watched, { id: "a" })), "<p>A</p>")
      assert.strictEqual(yield* render(session, jsx(Watched, { id: "x" })), "<p>no x</p>")
      const other = yield* makeSession()
      assert.strictEqual(yield* render(other, jsx(Waited, { id: "b" })), "<p>B</p>")
      assert.strictEqual(yield* render(other, jsx(Waited, { id: "x" })), "<p>missing x</p>")
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("a write that lands mid-render, after the watcher rendered, leaves it dirty for the next pass", () =>
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      const count = Atom.make(0).pipe(Atom.keepAlive)
      const gate = yield* Deferred.make<void>()
      const Watcher = View.Component(function*() {
        return <b>{yield* View.watch(count)}</b>
      })
      const Slow = View.Component(function*() {
        yield* Deferred.await(gate)
        return <i>slow</i>
      })
      const App = View.Component(function*() {
        const W = yield* View.use(Watcher)
        return <main><W /><Slow /></main>
      })
      const session = yield* makeSession()
      const first = yield* Effect.forkChild(render(session, root(App)))
      yield* Effect.yieldNow
      registry.set(count, 1)
      yield* Deferred.succeed(gate, undefined)
      assert.strictEqual(yield* Fiber.join(first), "<main><b>0</b><i>slow</i></main>")
      assert.isTrue(yield* isDirty(session))
      assert.strictEqual(yield* render(session, root(App)), "<main><b>1</b><i>slow</i></main>")
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("many sessions watching the same atoms leave no nodes behind once closed", () =>
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      const shared = Atom.make(0).pipe(Atom.keepAlive)
      const item = Atom.family((id: number) => Atom.make((get) => get(shared) + id))
      const Item = View.Component(function*(props: { readonly id: number }) {
        return <li>{yield* View.watch(item(props.id))}</li>
      })
      const App = View.Component(function*() {
        const I = yield* View.use(Item)
        return <ul>{[1, 2, 3].map((id) => <I key={id} id={id} />)}</ul>
      })
      const scopes: Array<Scope.Closeable> = []
      for (let i = 0; i < 200; i++) {
        const scope = yield* Scope.make()
        scopes.push(scope)
        yield* render(yield* Scope.provide(makeSession(), scope), root(App))
      }
      assert.isAbove(registry.getNodes().size, 3)
      registry.set(shared, 10)
      for (const scope of scopes) yield* Scope.close(scope, Exit.void)
      yield* tick
      assert.strictEqual(registry.getNodes().size, 1) // only the keepAlive `shared`
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("atom fibers belong to the registry: they do not see session services and outlive the session by a tick", () =>
    Effect.gen(function*() {
      const Where = Context.Reference<string>("test/Where", { defaultValue: () => "default" })
      let interrupted = false
      const where = Atom.make(Effect.service(Where))
      const forever = Atom.make(Effect.onInterrupt(Effect.never, () => Effect.sync(() => (interrupted = true))))
      const Show = View.Component(function*() {
        const w = yield* View.watch(where)
        yield* View.watch(forever)
        return <p>{AsyncResult.getOrElse(w, () => "?")}</p>
      })
      const scope = yield* Scope.make()
      const session = yield* Scope.provide(makeSession(), scope)
      assert.strictEqual(yield* render(session, root(Show)).pipe(Effect.provideService(Where, "session")), "<p>default</p>")
      yield* Scope.close(scope, Exit.void)
      assert.isFalse(interrupted)
      yield* tick
      yield* tick
      assert.isTrue(interrupted)
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("an Atom.fn in the app registry is one action for every tab: a second call interrupts the first", () =>
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      const log: Array<string> = []
      const save = Atom.fn((who: string) =>
        Effect.sleep("20 millis").pipe(
          Effect.as(`saved by ${who}`),
          Effect.onInterrupt(() => Effect.sync(() => log.push(`interrupted ${who}`)))
        )
      )
      const Saver = View.Component(function*(props: { readonly who: string }) {
        const result = yield* View.watch(save)
        return <button onClick={() => registry.set(save, props.who)}>{AsyncResult.getOrElse(result, () => "idle")}</button>
      })
      const a = yield* makeSession()
      const b = yield* makeSession()
      yield* render(a, jsx(Saver, { who: "tab A" }))
      yield* render(b, jsx(Saver, { who: "tab B" }))
      yield* click(a, "r.0")
      yield* click(b, "r.0")
      yield* sleep(40)
      assert.deepStrictEqual(log, ["interrupted tab A"])
      assert.strictEqual(yield* render(a, jsx(Saver, { who: "tab A" })), `<button data-lsc-click="r.0">saved by tab B</button>`)
    }).pipe(Effect.provide(AtomRegistry.layer)))

  it.live("with defaultIdleTTL the live session reuses what the HTTP render fetched", () =>
    Effect.gen(function*() {
      const scenario = (registry: Layer.Layer<AtomRegistry.AtomRegistry>) =>
        Effect.gen(function*() {
          let fetches = 0
          const data = Atom.make(Effect.sync(() => ++fetches).pipe(Effect.delay("10 millis")))
          const Show = View.Component(function*() {
            const r = yield* View.watch(data)
            return <p>{AsyncResult.isSuccess(r) ? r.value : "loading"}</p>
          })
          const dead = yield* Effect.scoped(Effect.flatMap(makeSession(false), (s) => render(s, root(Show))))
          yield* sleep(30)
          const live = yield* Effect.scoped(Effect.flatMap(makeSession(true), (s) => render(s, root(Show))))
          return { dead, live, fetches }
        }).pipe(Effect.provide(registry))
      assert.deepStrictEqual(yield* scenario(AtomRegistry.layer), { dead: "<p>loading</p>", live: "<p>loading</p>", fetches: 0 })
      assert.deepStrictEqual(yield* scenario(AtomRegistry.layerOptions({ defaultIdleTTL: 1000 })), {
        dead: "<p>loading</p>",
        live: "<p>1</p>",
        fetches: 1
      })
    }))

  it.live("View.provide(App, AtomRegistry.layer) gives each session its own registry", () =>
    Effect.gen(function*() {
      const count = Atom.make(0).pipe(Atom.keepAlive)
      const Counter = View.Component(function*() {
        const registry = yield* AtomRegistry.AtomRegistry
        const n = yield* View.watch(count)
        return <button onClick={() => registry.update(count, (x) => x + 1)}>{n}</button>
      })
      const PerTab = View.provide(Counter, AtomRegistry.layer)
      const a = yield* makeSession()
      const b = yield* makeSession()
      yield* render(a, root(PerTab))
      yield* render(b, root(PerTab))
      yield* click(a, "r.0")
      assert.strictEqual(yield* render(a, root(PerTab)), `<button data-lsc-click="r.0">1</button>`)
      assert.strictEqual(yield* render(b, root(PerTab)), `<button data-lsc-click="r.0">0</button>`)
    }))
})
