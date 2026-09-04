import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { View } from "effect-lsc/view"
import { core } from "../src/internal/browser.ts"
import { renderTree } from "../src/internal/render.ts"
import { dispatch, makeSession, type Session } from "../src/internal/session.ts"
import type { Child } from "../src/internal/vnode.ts"
import { diffNode } from "../src/internal/wire.ts"

/** The browser core plus its change tracking, evaluated from the runtime source. */
const client = () => {
  const make = new Function(`${core};
    return {
      apply: function (tree, patch) {
        changed = new Set();
        tree = merge(tree, patch, undefined, null);
        var targets = [];
        collect(tree, "r", null, targets);
        return { tree: tree, targets: targets.map(function (t) { return t.list ? "list:" + t.path : t.up === null ? "<root>" : t.path; }) };
      },
      html: html,
      rooted: rooted
    };`) as () => {
    apply: (tree: unknown, patch: unknown) => { tree: unknown; targets: Array<string> }
    html: (tree: unknown, path: string) => string
    rooted: Record<string, boolean>
  }
  return make()
}

const step = (session: Session, child: Child) =>
  Effect.map(renderTree(session, child), (tree) => {
    const patch = diffNode(session.tree, tree, session.sentStatics)
    session.tree = tree
    return patch === undefined ? undefined : JSON.parse(JSON.stringify(patch))
  })

describe("subtree morphing", () => {
  it.effect("only the touched anchored subtrees are morphed", () =>
    Effect.gen(function*() {
      type Todo = { id: number; title: string; done: boolean }
      const shared = yield* View.SharedState<ReadonlyArray<Todo>>([])
      const Item = View.Component(function*(p: { readonly todo: Todo }) {
        const editing = yield* View.State(false)
        return (
          <li class={[p.todo.done && "completed"]}>
            <label onDblClick={() => editing.set(true)}>{p.todo.title}</label>
            {editing.value && <input class="edit" />}
          </li>
        )
      })
      const Footer = (p: { readonly remaining: number }) => <footer>{p.remaining} left</footer>
      const App = View.Component(function*() {
        const todos = yield* View.watch(shared)
        return (
          <section>
            <ul>{todos.map((t) => <Item key={t.id} todo={t} />)}</ul>
            <Footer remaining={todos.filter((t) => !t.done).length} />
          </section>
        )
      })
      const browser = client()
      const session = yield* makeSession()
      let tree: unknown = null
      const apply = (child: Child) =>
        Effect.map(step(session, child), (patch) => {
          if (patch === undefined) return []
          const result = browser.apply(tree, patch)
          tree = result.tree
          return result.targets
        })
      const a = { id: 1, title: "a", done: false }
      const b = { id: 2, title: "b", done: false }

      // first render: everything, from the root container
      assert.deepStrictEqual(yield* apply(<App />), ["<root>"])
      // App's node is anchored: sections, items, footers carry ids in the HTML
      assert.match(browser.html(tree, "r"), /^<section data-lsc-n="r\.0">/)
      // items appear: the list is reconciled in place, and the footer text changed
      yield* shared.set([a, b])
      assert.deepStrictEqual(yield* apply(<App />), ["list:r.0.0", "r.0.1"])
      assert.include(browser.html(tree, "r"), `<li data-lsc-n="r.0.0.k1">`)
      assert.include(browser.html(tree, "r"), `<footer data-lsc-n="r.0.1">`)
      // toggle b: the item's class slot and the footer's text, nothing else
      yield* shared.set([a, { ...b, done: true }])
      assert.deepStrictEqual(yield* apply(<App />), ["r.0.0.k2", "r.0.1"])
      // local state in a: only that item
      yield* dispatch(session, { t: "event", type: "dblclick", id: "r.0.0.k1.0.0" })
      assert.deepStrictEqual(yield* apply(<App />), ["r.0.0.k1"])
      // reorder (a move): the list alone; the new item of an append is not a morph target
      yield* shared.set([{ ...b, done: true }, a])
      assert.deepStrictEqual(yield* apply(<App />), ["list:r.0.0"])
      yield* shared.set([{ ...b, done: true }, a, { id: 3, title: "c", done: false }])
      assert.deepStrictEqual(yield* apply(<App />), ["list:r.0.0", "r.0.1"])
      assert.include(browser.html(tree, "r"), `<li data-lsc-n="r.0.0.k3">`)
      // nothing changed: nothing to morph
      assert.deepStrictEqual(yield* apply(<App />), [])
    }))

  it.effect("a component whose output is not a single element bubbles to its anchored ancestor", () =>
    Effect.gen(function*() {
      const Text = View.Component(function*() {
        const n = yield* View.State(0)
        return <>{n.value}<button onClick={() => n.update((x) => x + 1)}>+</button></>
      })
      const App = () => <div><Text /></div>
      const browser = client()
      const session = yield* makeSession()
      let tree: unknown = null
      const apply = (child: Child) =>
        Effect.map(step(session, child), (patch) => {
          const result = browser.apply(tree, patch)
          tree = result.tree
          return result.targets
        })
      yield* apply(<App />)
      assert.isFalse(browser.rooted[(tree as any).d[0].d[0].f])
      yield* dispatch(session, { t: "event", type: "click", id: "r.0.0.0.1" })
      // Text's node changed but has no anchor: its ancestor <div> (the App node) is the target
      assert.deepStrictEqual(yield* apply(<App />), ["r.0"])
    }))
})
