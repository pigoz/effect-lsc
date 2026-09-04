import { assert, describe, it } from "@effect/vitest"
import { Effect, SubscriptionRef } from "effect"
import { View } from "effect-lsc/view"
import { core } from "../src/internal/browser.ts"
import { renderTree } from "../src/internal/render.ts"
import { dispatch, makeSession, type Session } from "../src/internal/session.ts"
import type { Child } from "../src/internal/vnode.ts"
import { diffNode, type NodePatch, toHtml } from "../src/internal/wire.ts"

/** The browser's merge/html functions, evaluated from the runtime source. */
const client = () => {
  const make = new Function(`${core}; return { merge: merge, html: html, statics: statics };`) as () => {
    merge: (current: unknown, patch: unknown) => unknown
    html: (tree: unknown) => string
  }
  return make()
}

/** Renders, diffs against the session's tree, returns the patch (or undefined). */
const step = (session: Session, child: Child) =>
  Effect.map(renderTree(session, child), (tree) => {
    const patch = diffNode(session.tree, tree, session.sentStatics)
    session.tree = tree
    return { tree, patch }
  })

/** Round trip: runs each action, renders, and the browser must reproduce the server HTML. */
const roundTrip = (session: Session, child: Child, actions: ReadonlyArray<Effect.Effect<unknown>>) =>
  Effect.gen(function*() {
    const browser = client()
    let tree: unknown = null
    for (const action of actions) {
      yield* action
      const { patch, tree: server } = yield* step(session, child)
      if (patch !== undefined) tree = browser.merge(tree, JSON.parse(JSON.stringify(patch)))
      assert.strictEqual(browser.html(tree), toHtml(server))
    }
  })

const slotsOf = (patch: NodePatch) => Object.keys(patch).filter((k) => k !== "f" && k !== "s")

describe("wire", () => {
  it.effect("the first render is complete and later renders carry only changed slots", () =>
    Effect.gen(function*() {
      const Counter = View.Component(function*() {
        const count = yield* View.State(0)
        return <button onClick={() => count.update((n) => n + 1)}>{count.value}</button>
      })
      const session = yield* makeSession
      const first = yield* step(session, <Counter />)
      assert.isDefined(first.patch!.s)
      const button = first.patch![0] as NodePatch
      assert.deepStrictEqual(button.s, ["<button", ">", "</button>"])
      assert.strictEqual(button[0], ` data-lsc-click="r.0"`)
      assert.strictEqual(button[1], "0")

      const unchanged = yield* step(session, <Counter />)
      assert.isUndefined(unchanged.patch)

      yield* dispatch(session, { t: "event", type: "click", id: "r.0" })
      const second = yield* step(session, <Counter />)
      assert.isUndefined(second.patch!.s)
      assert.deepStrictEqual(slotsOf(second.patch!), ["0"])
      const patched = second.patch![0] as NodePatch
      assert.isUndefined(patched.s)
      assert.deepStrictEqual(slotsOf(patched), ["1"])
      assert.strictEqual(patched[1], "1")
    }))

  it.effect("lists are diffed by key and repeated items share their statics", () =>
    Effect.gen(function*() {
      const Item = (p: { readonly name: string; readonly done: boolean }) => (
        <li class={[p.done && "done"]} onClick={() => {}}>{p.name}</li>
      )
      const List = (p: { readonly items: ReadonlyArray<[string, boolean]> }) => (
        <ul>{p.items.map(([name, done]) => <Item key={name} name={name} done={done} />)}</ul>
      )
      const session = yield* makeSession
      const first = yield* step(session, <List items={[["a", false], ["b", false], ["c", false]]} />)
      const listPatch = (patch: NodePatch) => (patch[0] as NodePatch)[0] as { k?: ReadonlyArray<string>; i?: Record<string, NodePatch> }
      const l0 = listPatch(first.patch!)
      assert.deepStrictEqual(l0.k, ["a", "b", "c"])
      // each list item is a wrapper node holding the <Item> component node;
      // three items, one set of <li> statics: only the first carries `s`
      const li = (key: string) => l0.i![key]![0] as NodePatch
      assert.isDefined(li("a").s)
      assert.isUndefined(li("b").s)
      assert.isUndefined(li("c").s)

      // reorder: key order only, no item patches
      const reordered = yield* step(session, <List items={[["c", false], ["a", false], ["b", false]]} />)
      const l1 = listPatch(reordered.patch!)
      assert.deepStrictEqual(l1.k, ["c", "a", "b"])
      assert.isUndefined(l1.i)

      // toggle one: that item's changed slot only, no key order
      const toggled = yield* step(session, <List items={[["c", false], ["a", true], ["b", false]]} />)
      const l2 = listPatch(toggled.patch!)
      assert.isUndefined(l2.k)
      assert.deepStrictEqual(Object.keys(l2.i!), ["a"])
      const toggledLi = l2.i!["a"]![0] as NodePatch
      assert.deepStrictEqual(slotsOf(toggledLi), ["0"])
      assert.strictEqual(toggledLi[0], ` class="done"`)

      // append: new key order plus the new item, without statics
      const appended = yield* step(session, <List items={[["c", false], ["a", true], ["b", false], ["d", false]]} />)
      const l3 = listPatch(appended.patch!)
      assert.deepStrictEqual(l3.k, ["c", "a", "b", "d"])
      assert.deepStrictEqual(Object.keys(l3.i!), ["d"])
      assert.isUndefined(l3.i!["d"]!.s)
      assert.isUndefined((l3.i!["d"]![0] as NodePatch).s)

      // remove the head: key order only
      const removed = yield* step(session, <List items={[["a", true], ["b", false], ["d", false]]} />)
      const l4 = listPatch(removed.patch!)
      assert.deepStrictEqual(l4.k, ["a", "b", "d"])
      assert.isUndefined(l4.i)
    }))

  it.effect("a shape change re-sends the nested node in full, and only that", () =>
    Effect.gen(function*() {
      const Editor = () => <input class="edit" autofocus />
      const Row = (p: { readonly editing: boolean }) => (
        <li>
          <span>title</span>
          {p.editing && <Editor />}
        </li>
      )
      const session = yield* makeSession
      yield* step(session, <Row editing={false} />)
      const opened = yield* step(session, <Row editing={true} />)
      // Row's children are a list; only item "1" (the conditional) changes,
      // and it carries the Editor node in full since its shape is new
      const row = opened.patch![0] as NodePatch
      assert.deepStrictEqual(slotsOf(row), ["0"])
      const children = row[0] as { k?: ReadonlyArray<string>; i?: Record<string, NodePatch> }
      assert.isUndefined(children.k)
      assert.deepStrictEqual(Object.keys(children.i!), ["1"])
      const editor = children.i!["1"]![0] as NodePatch
      assert.deepStrictEqual(editor.s, ["<input", "", ">"])
      assert.strictEqual(editor[0], ` class="edit"`)
      assert.strictEqual(editor[1], " autofocus")

      const closed = yield* step(session, <Row editing={false} />)
      const closedChildren = (closed.patch![0] as NodePatch)[0] as { i?: Record<string, NodePatch> }
      assert.strictEqual(closedChildren.i!["1"]![0], "")
    }))

  it.effect("the browser reproduces the server HTML after every patch", () =>
    Effect.gen(function*() {
      const shared = yield* SubscriptionRef.make<ReadonlyArray<{ id: number; title: string; done: boolean }>>([])
      const Item = View.Component(function*(p: { readonly todo: { id: number; title: string; done: boolean } }) {
        const editing = yield* View.State(false)
        return (
          <li class={[p.todo.done && "completed", editing.value && "editing"]}>
            <input type="checkbox" checked={p.todo.done} onChange={() => {}} />
            <label onDblClick={() => editing.set(true)}>{p.todo.title}</label>
            {editing.value && <input class="edit" value={p.todo.title} onBlur={() => editing.set(false)} />}
          </li>
        )
      })
      const App = View.Component(function*() {
        const todos = yield* View.watch(shared)
        const remaining = todos.filter((t) => !t.done).length
        return (
          <section>
            <h1>todos</h1>
            {todos.length > 0 && <ul>{todos.map((t) => <Item key={t.id} todo={t} />)}</ul>}
            {todos.length > 0 && <footer><strong>{remaining}</strong> left</footer>}
            {View.raw("<!-- raw -->")}
          </section>
        )
      })
      const session = yield* makeSession
      const set = (todos: ReadonlyArray<{ id: number; title: string; done: boolean }>) => SubscriptionRef.set(shared, todos)
      const click = (type: string, id: string) => dispatch(session, { t: "event", type, id })
      yield* roundTrip(session, <App />, [
        Effect.void,
        set([{ id: 1, title: "a", done: false }]),
        set([{ id: 1, title: "a", done: false }, { id: 2, title: "b & c", done: false }]),
        set([{ id: 1, title: "a", done: true }, { id: 2, title: "b & c", done: false }]),
        set([{ id: 2, title: "b & c", done: false }, { id: 1, title: "a", done: true }]),
        set([{ id: 2, title: "<b>", done: false }]),
        set([]),
        set([{ id: 3, title: "z", done: false }]),
        // component-local state: open and close the editor of item 3
        click("dblclick", "r.0.1.k3.0.1"),
        Effect.void,
        click("blur", "r.0.1.k3.0.2"),
        set([{ id: 3, title: "z", done: true }, { id: 4, title: "w", done: false }])
      ])
    }))
})
