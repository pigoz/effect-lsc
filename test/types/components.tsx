// Type tests: which components JSX accepts, and what View.use records.
// Checked by `bun run check`; every @ts-expect-error must hide a real error.
import { Effect, Layer } from "effect"
import { jsx } from "effect-lsc/jsx-runtime"
import { View } from "effect-lsc/view"
import { check, Db, Denied, type Equals, NotFound } from "./util.ts"

// --- closed components go straight into JSX ---------------------------------
const Plain = (props: { readonly name: string }) => <b>{props.name}</b>
const Local = View.Component(function*() {
  const n = yield* View.State(0)
  return <i>{n.value}</i>
})
const Generic = <T,>(props: { readonly item: T; readonly show: (t: T) => string }) => <u>{props.show(props.item)}</u>
export const accepted = (
  <>
    <Plain name="a" />
    <Local />
    <Generic item={1} show={(n) => n.toFixed()} />
    <View.ErrorBoundary fallback={() => null}><Local key="k" /></View.ErrorBoundary>
  </>
)
// @ts-expect-error a component without props rejects unknown attributes
export const excess = <Local foo="bar" />
// @ts-expect-error props are still checked
export const wrongProp = <Plain name={1} />
// @ts-expect-error generics still infer in JSX
export const genericMisuse = <Generic item={1} show={(n) => n.toUpperCase()} />

// --- View.Component keeps the body's parameters ------------------------------
check<Equals<typeof Local, () => Effect.Effect<View.VNode, never, View.Instance>>>()
const Named = View.Component(function*(props: { readonly name: string }) {
  const n = yield* View.State(props.name)
  return <b>{n.value}</b>
})
check<Equals<typeof Named, (props: { readonly name: string }) => Effect.Effect<View.VNode, never, View.Instance>>>()
// @ts-expect-error missing prop
export const missing = <Named />

// --- a generic body loses its type parameters -------------------------------
// A generic component is a plain function; it may return Effect.gen.
const GenericLocal = View.Component(function*<T>(props: { readonly item: T; readonly show: (t: T) => string }) {
  return <i>{props.show(props.item)}</i>
})
// @ts-expect-error T is lost, so `n` is unknown
export const genericLost = <GenericLocal item={1} show={(n) => n.toFixed()} />
const GenericGen = <T,>(props: { readonly item: T; readonly show: (t: T) => string }) =>
  Effect.gen(function*() {
    const n = yield* View.State(0)
    return <u>{props.show(props.item)}{n.value}</u>
  })
export const genericGen = <GenericGen item={1} show={(n) => n.toFixed()} />
// @ts-expect-error a plain generic function still infers T
export const genericGenMisuse = <GenericGen item={1} show={(n) => n.toUpperCase()} />

// --- components with services or errors are not closed ----------------------
const Find = View.Component(function*(props: { readonly id: string }) {
  const db = yield* Db
  return <li>{yield* db.load(props.id)}</li>
})
const Fails = View.Component(function*() {
  return yield* new Denied({ user: "x" })
})
// @ts-expect-error needs Db and fails with NotFound
export const open1 = <Find id="1" />
// @ts-expect-error fails with Denied
export const open2 = <Fails />
declare const AnyError: (props: {}) => Effect.Effect<View.Child, any, never>
// @ts-expect-error E = any is rejected: the error channel only admits never
export const anyError = <AnyError />
declare const AnyServices: (props: {}) => Effect.Effect<View.Child, never, any>
// @ts-expect-error R = any is rejected: it may be any service
export const anyServices = <AnyServices />
// @ts-expect-error calling the factory directly does not bypass the check
export const direct = jsx(Find, { id: "1" })

// --- use records the child's errors and services in Subtree -----------------
const List = View.Component(function*() {
  const Item = yield* View.use(Find)
  return <ul><Item id="1" /><Item id="2" /></ul>
})
check<Equals<typeof List, () => Effect.Effect<View.VNode, never, View.Subtree<NotFound, Db>>>>()
// transitive, and merged into one Subtree
const Page = View.Component(function*() {
  const L = yield* View.use(List)
  const F = yield* View.use(Fails)
  return <main><L /><F /></main>
})
check<Equals<typeof Page, () => Effect.Effect<View.VNode, never, View.Subtree<NotFound | Denied, Db>>>>()
// a used component is closed, with its props
export const usedProps = Effect.gen(function*() {
  const Item = yield* View.use(Find)
  // @ts-expect-error missing prop
  return <Item />
})
// Effect combinators around a component cannot remove what its subtree does
export const caught = () =>
  // @ts-expect-error nothing to catch: NotFound is in Subtree, not in E
  Effect.catchTag(List(), "NotFound", () => Effect.succeed(null))
export const provided = () => Effect.provideService(List(), Db, { load: () => Effect.succeed("") })
check<Equals<Effect.Services<ReturnType<typeof provided>>, View.Subtree<NotFound, Db>>>()
// ...and View.use cannot be run outside a component to launder a child
// @ts-expect-error Subtree<NotFound, Db> is not assignable to never
Effect.runSync(View.use(Find))
// components requiring Scope are rejected by use
const Leaky = View.Component(function*() {
  yield* Effect.addFinalizer(() => Effect.void)
  return <p />
})
// @ts-expect-error requires Scope: use View.once
export const leaky = View.use(Leaky)
// @ts-expect-error JSX rejects it too
export const leakyTag = <Leaky />

// --- recursion: annotate with the View.Component type -----------------------
interface TreeNode {
  readonly id: string
  readonly children: ReadonlyArray<TreeNode>
}
export const Tree: View.Component<[props: { readonly node: TreeNode }], NotFound, Db> = View.Component(
  function*(props: { readonly node: TreeNode }) {
    const db = yield* Db
    const Self = yield* View.use(Tree)
    return <li>{yield* db.load(props.node.id)}<ul>{props.node.children.map((c) => <Self key={c.id} node={c} />)}</ul></li>
  }
)
export const useTree = View.use(Tree)
check<Equals<Effect.Services<typeof useTree>, View.Subtree<NotFound, Db>>>()
// View.Component<Args> alone is the closed component type
export const closed: View.Component<[]> = Local

// --- generics: instantiate at the use site ----------------------------------
const Rows = <T,>(props: { readonly rows: ReadonlyArray<T>; readonly label: (t: T) => string }) =>
  Effect.gen(function*() {
    yield* Db
    return <ol>{props.rows.map((r) => <li>{props.label(r)}</li>)}</ol>
  })
export const generic = Effect.gen(function*() {
  const Numbers = yield* View.use(Rows<number>)
  return <Numbers rows={[1, 2]} label={(n) => n.toFixed(1)} />
})
// a generic tag is checked with its type parameters erased: one whose errors
// or services come from a type parameter is rejected, even when closed
const Await = <A, E, R>(props: { readonly effect: Effect.Effect<A, E, R>; readonly children: (a: A) => View.Child }) =>
  Effect.map(props.effect, props.children)
export const awaitError = View.Component(function*() {
  const db = yield* Db
  // @ts-expect-error fails with NotFound
  return <Await effect={db.load("1")}>{(name) => <b>{name}</b>}</Await>
})
const loadName = Effect.flatMap(Db, (db) => Effect.orDie(db.load("1")))
// @ts-expect-error needs Db
export const awaitServices = <Await effect={loadName}>{(name) => <b>{name}</b>}</Await>
// @ts-expect-error closed here, but the check cannot see it
export const awaitClosed = <Await effect={Effect.succeed("x")}>{(name) => <b>{name}</b>}</Await>
// @ts-expect-error calling the factory directly does not bypass the check
export const awaitDirect = jsx(Await, { effect: loadName, children: () => null })
// View.use with an instantiation records them
export const awaitUsed = View.use(Await<string, NotFound, Db>)
check<Equals<Effect.Services<typeof awaitUsed>, View.Subtree<NotFound, Db>>>()
export const awaitClosedUsed = Effect.gen(function*() {
  const AwaitName = yield* View.use(Await<string, never, never>)
  return <AwaitName effect={Effect.succeed("x")}>{(name) => <b>{name}</b>}</AwaitName>
})
// a tag typed by a type parameter is checked through its constraint
export const Slot = <C extends View.Closed<{}>>(props: { readonly comp: C }) => <props.comp />
export const slotFactory = <C extends View.Closed<{}>>(comp: C) => jsx(comp, {})
export const OpenSlot = <C extends typeof Await>(props: { readonly comp: C }) => (
  // @ts-expect-error the constraint's errors and services come from a type parameter
  <props.comp effect={loadName}>{() => null}</props.comp>
)

// --- View.render carries the whole tree's types -----------------------------
export const rendered = View.render(Page)
check<Equals<typeof rendered, Effect.Effect<string, NotFound | Denied, Db>>>()
export const renderedProps = View.render(Find, { id: "1" })
check<Equals<typeof renderedProps, Effect.Effect<string, NotFound, Db>>>()
export const renderedTree = View.render(<Local />)
check<Equals<typeof renderedTree, Effect.Effect<string>>>()
// @ts-expect-error requires Scope
export const renderedLeaky = View.render(Leaky)
// in tests, provide the services to the render
export const testRender = View.render(List).pipe(
  Effect.provide(Layer.succeed(Db, { load: (id) => Effect.succeed(id) })),
  Effect.catchTag("NotFound", () => Effect.succeed(""))
)
check<Equals<typeof testRender, Effect.Effect<string>>>()
