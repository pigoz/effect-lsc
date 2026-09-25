// Type tests: View.provide discharges services for a component and its subtree.
// Checked by `bun run check`; every @ts-expect-error must hide a real error.
import { Context, Effect, Layer } from "effect"
import type { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"
import { Auth, check, Clock, Db, Denied, type Equals, type Fn, NotFound } from "./util.ts"

const Find = View.Component(function*(props: { readonly id: string }) {
  const db = yield* Db
  const auth = yield* Auth
  yield* auth.check
  return <li>{yield* db.load(props.id)}</li>
})
const DbFromClock = Layer.effect(
  Db,
  Effect.gen(function*() {
    yield* Clock
    return { load: (id: string) => Effect.succeed(id) }
  })
)
const DbLive = Layer.succeed(Db, { load: (id: string) => Effect.succeed(id) })
const AuthLive = Layer.succeed(Auth, { check: Effect.succeed("ok") })
class Boom extends Error {}

// what the layer provides leaves, what it requires arrives; all of it surfaces at render time
export const WithDb = View.provide(Find, DbFromClock)
check<Equals<Fn<typeof WithDb>, (props: { readonly id: string }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<NotFound | Denied, Auth | Clock>>>>()
// @ts-expect-error still needs Auth and Clock
export const withDbTag = <WithDb id="1" />
// the layer's error is added
export const Failing = View.provide(Find, Layer.effect(Db, Effect.fail(new Boom())))
check<Equals<Fn<typeof Failing>, (props: { readonly id: string }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<NotFound | Denied | Boom, Auth>>>>()
// data-last
export const Piped = Find.pipe(View.provide(DbFromClock))
check<Equals<Fn<typeof Piped>, Fn<typeof WithDb>>>()
// the layer reaches the components brought in with View.use
const List = View.Component(function*() {
  const Item = yield* View.use(Find)
  return <ul><Item id="1" /></ul>
})
export const ListWithDb = View.provide(List, DbLive)
check<Equals<Fn<typeof ListWithDb>, () => Effect.Effect<View.Child, never, View.Instance | View.Subtree<NotFound | Denied, Auth>>>>()
// a layer holding a component from View.use keeps its errors and services
class Rows extends Context.Service<Rows, { readonly Row: View.Closed<{ readonly id: string }> }>()("t/Rows") {}
const RowsLive = Layer.effect(Rows, Effect.map(View.use(Find), (Row) => ({ Row })))
const Table = View.Component(function*() {
  const rows = yield* Rows
  return <table><rows.Row id="1" /></table>
})
export const WithRows = View.provide(Table, RowsLive)
check<Equals<Fn<typeof WithRows>, () => Effect.Effect<View.Child, never, View.Instance | View.Subtree<NotFound | Denied, Db | Auth>>>>()
// @ts-expect-error NotFound and Denied are unhandled
export const rowsMounted = Server.mount("/", WithRows)
// a fully provided and handled tree is closed, and is mounted with no layer
export const Closed = Find.pipe(
  View.provide(Layer.mergeAll(AuthLive, DbLive)),
  View.catchTags({ NotFound: () => null, Denied: () => null })
)
export const closedTag = <Closed id="1" />
export const mounted = Server.mount("/", () => <Closed id="1" />)
check<Equals<typeof mounted, Layer.Layer<never, never, HttpRouter.HttpRouter>>>()
// at the root: one Cart per session, nothing left for the router to provide
class Cart extends Context.Service<Cart, View.SharedState<ReadonlyArray<string>>>()("t/Cart") {
  static readonly layer = Layer.effect(Cart, View.SharedState<ReadonlyArray<string>>([]))
}
const Shop = View.Component(function*() {
  const items = yield* View.watch(yield* Cart)
  return <p>{items.length}</p>
})
export const perSession = Server.mount("/", View.provide(Shop, Cart.layer))
check<Equals<typeof perSession, Layer.Layer<never, never, HttpRouter.HttpRouter>>>()
// without it, the router has to provide Cart
export const shared = Server.mount("/", Shop)
check<Equals<typeof shared, Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request<"Requires", Cart>>>>()
// a layer is built outside the instance: its state cannot be a View.State
class TabCart extends Context.Service<TabCart, View.State<ReadonlyArray<string>>>()("t/TabCart") {
  static readonly layer = Layer.effect(TabCart, View.State<ReadonlyArray<string>>([]))
}
// @ts-expect-error the layer requires Instance
export const perTab = View.provide(Shop, TabCart.layer)
// @ts-expect-error the layer requires Instance
export const perTabPiped = Shop.pipe(View.provide(TabCart.layer))
