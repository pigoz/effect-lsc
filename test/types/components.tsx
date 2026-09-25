// Type tests: which components JSX accepts.
// Checked by `bun run check`; every @ts-expect-error must hide a real error.
import { Effect } from "effect"
import { View } from "effect-lsc/view"
import { check, type Equals } from "./util.ts"

// --- props are checked as for any function component ------------------------
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
