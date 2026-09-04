import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Scope, SubscriptionRef } from "effect"
import { View } from "effect-lsc/view"
import { core } from "../src/internal/browser.ts"
import { render, renderTree } from "../src/internal/render.ts"
import { dispatch, makeSession, type Session } from "../src/internal/session.ts"
import type { Child } from "../src/internal/vnode.ts"
import { diffNode, toHtml } from "../src/internal/wire.ts"

const click = (session: Session, id: string) => dispatch(session, { t: "event", type: "click", id })
/** The browser adds DOM anchors to its HTML; the server HTML has none. */
const stripAnchors = (html: string) => html.replace(/ data-lsc-n="[^"]*"/g, "")

describe("memoization", () => {
  it.effect("a component with unchanged props and no dirty state is not re-run", () =>
    Effect.gen(function*() {
      const runs = { parent: 0, child: 0 }
      const Child = View.Component(function*(p: { readonly label: string }) {
        runs.child++
        const n = yield* View.State(0)
        return <button onClick={() => n.update((x) => x + 1)}>{p.label}:{n.value}</button>
      })
      const Parent = View.Component(function*() {
        runs.parent++
        const tick = yield* View.State(0)
        return (
          <div>
            <span onClick={() => tick.update((x) => x + 1)}>{tick.value}</span>
            <Child label="a" />
          </div>
        )
      })
      const session = yield* makeSession
      const first = yield* renderTree(session, <Parent />)
      assert.deepStrictEqual(runs, { parent: 1, child: 1 })
      // Parent's slots: span handler id, tick text, Child node
      const childNode = (first.d[0] as any).d[2]

      // parent state changes: parent re-runs, child is reused as the same object
      yield* click(session, "r.0.0")
      const second = yield* renderTree(session, <Parent />)
      assert.deepStrictEqual(runs, { parent: 2, child: 1 })
      assert.strictEqual((second.d[0] as any).d[2], childNode)
      assert.strictEqual(toHtml(second), `<div><span data-lsc-click="r.0.0">1</span><button data-lsc-click="r.0.1.0">a:0</button></div>`)

      // the reused child's handler still works, and its change re-runs the
      // ancestors but nothing else
      yield* click(session, "r.0.1.0")
      const third = yield* renderTree(session, <Parent />)
      assert.deepStrictEqual(runs, { parent: 3, child: 2 })
      assert.strictEqual(toHtml(third), `<div><span data-lsc-click="r.0.0">1</span><button data-lsc-click="r.0.1.0">a:1</button></div>`)

      // nothing changed: nothing re-runs, the diff is empty
      const fourth = yield* renderTree(session, <Parent />)
      assert.deepStrictEqual(runs, { parent: 3, child: 2 })
      assert.isUndefined(diffNode(third, fourth, session.sentStatics))
    }))

  it.effect("new props re-run the component; identical props do not", () =>
    Effect.gen(function*() {
      let runs = 0
      const Show = (p: { readonly todo: { title: string } }) => {
        runs++
        return <li>{p.todo.title}</li>
      }
      const todo = { title: "a" }
      const session = yield* makeSession
      yield* render(session, <ul>{[<Show key="1" todo={todo} />]}</ul>)
      yield* render(session, <ul>{[<Show key="1" todo={todo} />]}</ul>)
      assert.strictEqual(runs, 1)
      const html = yield* render(session, <ul>{[<Show key="1" todo={{ title: "b" }} />]}</ul>)
      assert.strictEqual(runs, 2)
      assert.strictEqual(html, "<ul><li>b</li></ul>")
    }))

  it.effect("a watched ref invalidates the ancestors but not the siblings", () =>
    Effect.gen(function*() {
      const shared = yield* SubscriptionRef.make(1)
      const runs = { app: 0, watcher: 0, sibling: 0 }
      const Watcher = View.Component(function*() {
        runs.watcher++
        const v = yield* View.watch(shared)
        return <b>{v}</b>
      })
      const Sibling = View.Component(function*() {
        runs.sibling++
        return <i>s</i>
      })
      const App = View.Component(function*() {
        runs.app++
        return (
          <p>
            <Watcher />
            <Sibling />
          </p>
        )
      })
      const session = yield* makeSession
      yield* render(session, <App />)
      yield* SubscriptionRef.set(shared, 2)
      const html = yield* render(session, <App />)
      assert.strictEqual(html, "<p><b>2</b><i>s</i></p>")
      assert.deepStrictEqual(runs, { app: 2, watcher: 2, sibling: 1 })
    }))

  it.effect("instances and handlers of a removed memoized subtree are disposed", () =>
    Effect.gen(function*() {
      const closed = yield* Deferred.make<void>()
      const Leaf = View.Component(function*() {
        yield* Effect.flatMap(View.Instance, (i) => Scope.addFinalizer(i.scope, Deferred.succeed(closed, undefined)))
        return <button onClick={() => {}}>leaf</button>
      })
      const Branch = () => <div><Leaf /></div>
      const App = (p: { readonly show: boolean }) => <main>{p.show && <Branch />}</main>
      const session = yield* makeSession
      yield* render(session, <App show={true} />)
      yield* render(session, <App show={true} />) // Branch and Leaf reused
      assert.strictEqual(session.instances.size, 3) // App, Branch, Leaf
      assert.isTrue(session.handlers.has("click:r.0.0.0.0.0"))
      yield* render(session, <App show={false} />)
      assert.strictEqual(session.instances.size, 1) // App only
      assert.strictEqual(session.handlers.size, 0)
      assert.isTrue(yield* Deferred.isDone(closed))
    }))

  it.effect("the browser still reproduces the server HTML when subtrees are reused", () =>
    Effect.gen(function*() {
      type Todo = { id: number; title: string; done: boolean }
      const shared = yield* SubscriptionRef.make<ReadonlyArray<Todo>>([])
      const Item = View.Component(function*(p: { readonly todo: Todo }) {
        const editing = yield* View.State(false)
        return (
          <li class={[p.todo.done && "completed", editing.value && "editing"]}>
            <label onDblClick={() => editing.set(true)}>{p.todo.title}</label>
            {editing.value && <input class="edit" value={p.todo.title} onBlur={() => editing.set(false)} />}
          </li>
        )
      })
      const App = View.Component(function*() {
        const todos = yield* View.watch(shared)
        return <ul>{todos.map((t) => <Item key={t.id} todo={t} />)}</ul>
      })
      const browser = (new Function(`${core}; return { merge: merge, html: html };`) as () => {
        merge: (c: unknown, p: unknown) => unknown
        html: (t: unknown, path: string) => string
      })()
      const session = yield* makeSession
      let tree: unknown = null
      const check = (child: Child) =>
        Effect.map(renderTree(session, child), (server) => {
          const patch = diffNode(session.tree, server, session.sentStatics)
          session.tree = server
          if (patch !== undefined) tree = browser.merge(tree, JSON.parse(JSON.stringify(patch)))
          assert.strictEqual(stripAnchors(browser.html(tree, "r")), toHtml(server))
        })
      const a = { id: 1, title: "a", done: false }
      const b = { id: 2, title: "b", done: false }
      yield* check(<App />)
      yield* SubscriptionRef.set(shared, [a, b])
      yield* check(<App />)
      // same objects, new order: both items reused
      yield* SubscriptionRef.set(shared, [b, a])
      yield* check(<App />)
      // local state in a reused item
      yield* dispatch(session, { t: "event", type: "dblclick", id: "r.0.k1.0.0" })
      yield* check(<App />)
      // replace one object, keep the other
      yield* SubscriptionRef.set(shared, [b, { ...a, done: true }])
      yield* check(<App />)
      yield* dispatch(session, { t: "event", type: "blur", id: "r.0.k1.0.1" })
      yield* check(<App />)
    }))
})
