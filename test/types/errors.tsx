// Type tests: handling typed render errors where a component is defined.
// Checked by `bun run check`; every @ts-expect-error must hide a real error.
import { Effect } from "effect"
import { View } from "effect-lsc/view"
import { Auth, check, Db, Denied, type Equals, type Fn, NotFound } from "./util.ts"

const Find = View.Component(function*(props: { readonly id: string }) {
  const db = yield* Db
  return <li>{yield* db.load(props.id)}</li>
})
const Page = View.Component(function*(props: { readonly admin: boolean }) {
  const auth = yield* Auth
  const Item = yield* View.use(Find)
  if (!props.admin) yield* auth.check
  return <ul><Item id="x" /></ul>
})
check<Equals<Fn<typeof Page>, (props: { readonly admin: boolean }) => Effect.Effect<View.VNode, Denied, Auth | View.Subtree<NotFound, Db>>>>()

// --- data-first --------------------------------------------------------------
// catchTag sees own and subtree errors; what is left moves to Subtree
export const Half = View.catchTag(Page, "NotFound", (error, props) => <p>{error.id} {String(props.admin)}</p>)
check<Equals<Fn<typeof Half>, (props: { readonly admin: boolean }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<Denied, Auth | Db>>>>()
// tag arrays narrow to the union
export const Both = View.catchTag(Page, ["NotFound", "Denied"], (error) => <p>{error._tag}</p>)
check<Equals<Fn<typeof Both>, (props: { readonly admin: boolean }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<never, Auth | Db>>>>()
// a component with no typed error left and services in Subtree is used, not tagged
// @ts-expect-error still needs Auth and Db
export const bothTag = <Both admin />
// @ts-expect-error unknown tag
export const unknownTag = View.catchTag(Page, "Nope", () => null)
// @ts-expect-error the handler gets the narrowed error: NotFound has no user
export const narrowed = View.catchTag(Page, "NotFound", (error) => <p>{error.user}</p>)
// catchTags: one handler per tag, narrowed; unknown tags rejected
export const All = View.catchTags(Page, {
  NotFound: (error) => <p>{error.id}</p>,
  Denied: (error, props) => <p>{error.user} {String(props.admin)}</p>
})
check<Equals<Fn<typeof All>, (props: { readonly admin: boolean }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<never, Auth | Db>>>>()
// @ts-expect-error excess tag
export const excessTag = View.catchTags(Page, { NotFound: () => null, Nope: () => null })
// a handler that may be missing at runtime does not handle its tag
declare const verbose: boolean
export const Maybe = View.catchTags(Page, { NotFound: () => null, ...(verbose ? { Denied: () => <p>login</p> } : {}) })
check<Equals<Fn<typeof Maybe>, (props: { readonly admin: boolean }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<Denied, Auth | Db>>>>()
const cases: { readonly NotFound: () => View.Child; readonly Denied?: () => View.Child } = { NotFound: () => null }
export const Declared = View.catchTags(Page, cases)
check<Equals<Fn<typeof Declared>, Fn<typeof Maybe>>>()
// an effectful handler adds its own errors and services
export const Effectful = View.catchTag(Page, "Denied", () =>
  Effect.gen(function*() {
    const db = yield* Db
    return <p>{yield* db.load("guest")}</p>
  }))
check<Equals<Fn<typeof Effectful>, (props: { readonly admin: boolean }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<NotFound, Auth | Db>>>>()
// so does a component the handler brings in with View.use: NotFound is back, from Find
const guest = () => Effect.map(View.use(Find), (F) => <F id="guest" />)
export const Guest = View.catchTag(Page, ["NotFound", "Denied"], guest)
check<Equals<Fn<typeof Guest>, (props: { readonly admin: boolean }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<NotFound, Auth | Db>>>>()
export const GuestTags = View.catchTags(Page, { NotFound: guest, Denied: guest })
check<Equals<Fn<typeof GuestTags>, Fn<typeof Guest>>>()
// ...even when it may be missing at runtime
export const MaybeGuest = View.catchTags(Page, { NotFound: () => null, ...(verbose ? { Denied: guest } : {}) })
check<Equals<Fn<typeof MaybeGuest>, (props: { readonly admin: boolean }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<NotFound | Denied, Auth | Db>>>>()
// recovery runs outside the instance: View.State in a handler is rejected
// @ts-expect-error return a component that uses View.State instead
export const stateful = View.catchTag(Page, "Denied", () => Effect.map(View.State(0), (n) => <p>{n.value}</p>))
// catchTags cannot reject it in place without losing contextual types: its result is unusable instead
export const StatefulTags = View.catchTags(Page, { Denied: () => Effect.map(View.State(0), (n) => <p>{n.value}</p>) })
// @ts-expect-error the result names the problem
export const statefulTagsUse = View.use(StatefulTags)
export const MaybeStateful = View.catchTags(Page, {
  ...(verbose ? { Denied: () => Effect.map(View.State(0), (n) => <p>{n.value}</p>) } : {})
})
// @ts-expect-error a handler that may be missing is checked too
export const maybeStatefulUse = View.use(MaybeStateful)
// orDie keeps the services, drops the errors
export const Dies = View.orDie(Page)
check<Equals<Fn<typeof Dies>, (props: { readonly admin: boolean }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<never, Auth | Db>>>>()
// a closed component handled on the spot is usable as a tag directly
const Denies = View.Component(function*() {
  return yield* new Denied({ user: "x" })
})
export const SafeDenies = View.catchTag(Denies, "Denied", () => <p>no</p>)
export const safeTag = <SafeDenies />

// --- data-last, through pipe -------------------------------------------------
export const Piped = View.Component(function*(props: { readonly id: string }) {
  const db = yield* Db
  return <li>{yield* db.load(props.id)}</li>
}).pipe(View.catchTag("NotFound", (error, props) => <li>missing {error.id} for {props.id}</li>))
check<Equals<Fn<typeof Piped>, (props: { readonly id: string }) => Effect.Effect<View.Child, never, View.Instance | View.Subtree<never, Db>>>>()
export const PipedTags = Page.pipe(View.catchTags({ NotFound: (error) => <p>{error.id}</p>, Denied: () => <p>login</p> }))
check<Equals<Fn<typeof PipedTags>, Fn<typeof All>>>()
export const PipedDie = Page.pipe(View.orDie)
check<Equals<Fn<typeof PipedDie>, Fn<typeof Dies>>>()
// chains: handle one tag, then the other
export const Chain = Page.pipe(View.catchTag("NotFound", () => null), View.catchTag("Denied", () => <p>login</p>))
check<Equals<Fn<typeof Chain>, Fn<typeof All>>>()
// data-last keeps the errors of a component the handler brings in too
export const PipedGuest = Page.pipe(View.catchTag(["NotFound", "Denied"], guest))
check<Equals<Fn<typeof PipedGuest>, Fn<typeof Guest>>>()
// @ts-expect-error data-last narrows too
export const pipedNarrow = Page.pipe(View.catchTag("NotFound", (error) => <p>{error.user}</p>))
// @ts-expect-error data-last rejects Instance in handlers too
export const pipedState = Page.pipe(View.catchTag("Denied", () => Effect.map(View.State(0), (n) => <p>{n.value}</p>)))
// @ts-expect-error data-last catchTags rejects excess tags
export const pipedExcess = Page.pipe(View.catchTags({ Nope: () => null }))
// a component is not an Effect: Effect combinators do not pipe onto it
// @ts-expect-error
export const notEffect = Page.pipe(Effect.orDie)

