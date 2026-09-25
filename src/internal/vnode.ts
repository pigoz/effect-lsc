/**
 * The virtual node model produced by JSX.
 *
 * A VNode is plain data. Nothing here is reactive: a component is just a
 * function from props to a `Child` (or an `Effect` producing one), and the
 * renderer turns the resulting tree into an HTML string on the server.
 */
import type * as Cause from "effect/Cause"
import type * as Effect from "effect/Effect"
import { hasProperty } from "effect/Predicate"
import type { Instance } from "./instance.ts"

export const TypeId = "~effect-lsc/VNode" as const
export type TypeId = typeof TypeId

export type Primitive = string | number | boolean | null | undefined

/**
 * Anything that can appear as JSX children.
 */
export type Child = VNode | Primitive | ReadonlyArray<Child>

export type Props = { readonly [key: string]: unknown; readonly children?: Child }

/**
 * A component: a function from props to a `Child`, optionally wrapped in an
 * `Effect`. Effectful components can use `View.State`, `View.watch` and any
 * Effect service; a component with services or typed errors is brought
 * into its parent with `View.use`.
 */
export type ComponentFn<P, E = never, R = never> = (props: P) => Child | Effect.Effect<Child, E, R>

/**
 * A component that can appear as a JSX tag: it has no typed errors and
 * requires no service besides `Instance`, which the renderer provides.
 * A component with requirements or errors is brought into a parent with
 * `View.use`, which moves them into the parent's type.
 */
export type ClosedComponent<P> = (props: P) => Child | Effect.Effect<Child, never, Instance>

/**
 * What JSX accepts as a tag: `ClosedComponent`, with the requirements
 * widened by a literal type no component requires, so a tag rejected for
 * its services contains `... is not assignable to type '"effect-lsc:
 * bring it in with View.use" | Instance'`. The error channel stays `never`:
 * a literal there would let `E = any` through.
 */
export type ElementComponent = (props: any) => Child | Effect.Effect<Child, never, Instance | ServiceHint>
type ServiceHint = "effect-lsc: bring it in with View.use"

/**
 * The check `ElementComponent` misses on a generic tag: TypeScript
 * relates it to `(props: any) => ...` without checking the errors and
 * services its type parameters give. Read with `infer`, the return has
 * them erased to `unknown`, so such a tag gets a required prop named
 * after the fix, even when its instantiation would be closed. Applied by
 * `JSX.LibraryManagedAttributes` and the factories; `unknown` for every
 * other tag. It is an indexed access, not a conditional type: for a tag
 * whose type is a type parameter, a conditional type would stay deferred
 * and reject every prop, while the index resolves through the
 * parameter's constraint.
 */
export type TagCheck<C> = {
  readonly closed: unknown
  readonly open: { readonly [K in ServiceHint]: never }
}[TagKind<C>]
type TagKind<C> = C extends ElementComponent
  ? C extends (props: any) => infer Out ? ClosedReturn<Extract<Out, Effect.Effect<any, any, any>>> : "closed"
  : "closed"
/** `ServiceHint` is left out, so a tag typed `ElementComponent` itself is closed. */
type ClosedReturn<Eff> = [Effect.Error<Eff> | Exclude<Effect.Services<Eff>, Instance | ServiceHint>] extends [never]
  ? "closed"
  : "open"

export interface Element {
  readonly [TypeId]: TypeId
  readonly _tag: "Element"
  readonly type: string
  readonly props: Props
  readonly key: string | undefined
  /**
   * `true` when the JSX transform emitted `jsxs`: the children array is a
   * literal list of siblings, so its shape is fixed and it can be inlined.
   * `false` for dynamic children such as `{items.map(…)}`, which become a
   * keyed list.
   */
  readonly staticChildren: boolean
}

export interface ComponentNode {
  readonly [TypeId]: TypeId
  readonly _tag: "Component"
  readonly type: ComponentFn<any, any, any>
  readonly props: Props
  readonly key: string | undefined
}

export interface FragmentNode {
  readonly [TypeId]: TypeId
  readonly _tag: "Fragment"
  readonly children: Child
  readonly key: string | undefined
  readonly staticChildren: boolean
}

/**
 * Trusted, pre-rendered HTML. Never escaped.
 */
export interface Raw {
  readonly [TypeId]: TypeId
  readonly _tag: "Raw"
  readonly html: string
}

export type VNode = Element | ComponentNode | FragmentNode | Raw

export const Fragment: unique symbol = Symbol.for("effect-lsc/Fragment")
export type Fragment = typeof Fragment

/**
 * Marks a component the renderer treats as a boundary. The property holds
 * the component's `Boundary`, which says how it renders and recovers. See
 * `View.ErrorBoundary`.
 */
export const BoundaryTypeId = "~effect-lsc/ErrorBoundary" as const
export type BoundaryTypeId = typeof BoundaryTypeId

export const isBoundary = (type: unknown): boolean => typeof type === "function" && BoundaryTypeId in type

/**
 * How a boundary recovers: it receives the failure of its whole subtree
 * (its own body and every descendant) and its props. Returning a failing
 * Effect passes the failure on to the next boundary up.
 */
export type Recover = (cause: Cause.Cause<unknown>, props: any) => Child | Effect.Effect<Child, unknown>

/**
 * What the renderer runs for a boundary component. `render` is the body,
 * whose output the renderer renders. When that render (body and subtree)
 * fails, what `recover` returns is rendered in its place; a boundary
 * without `recover` lets the failure through. When present, `wrap` runs
 * the whole render, recovery included, with the boundary's `Instance`
 * (`View.provide`).
 */
export interface Boundary {
  readonly render: (props: any) => Child | Effect.Effect<Child, unknown, unknown>
  readonly recover?: Recover | undefined
  readonly wrap?: (<A>(render: Effect.Effect<A, unknown>, props: any) => Effect.Effect<A, unknown, Instance>) | undefined
}

export const boundaryOf = (type: unknown): Boundary => (type as { readonly [BoundaryTypeId]: Boundary })[BoundaryTypeId]

export const isVNode = (u: unknown): u is VNode => hasProperty(u, TypeId)

export const raw = (html: string): Raw => ({ [TypeId]: TypeId, _tag: "Raw", html })

const normalizeKey = (key: unknown): string | undefined =>
  key === undefined || key === null ? undefined : String(key)

/**
 * The JSX factory. TypeScript / Bun compile `<div class="a">x</div>` to
 * `jsx("div", { class: "a", children: "x" })` when `jsxImportSource` is
 * `effect-lsc`.
 */
export const jsx = (type: unknown, props: Props, key?: unknown, staticChildren: boolean = false): VNode => {
  const k = normalizeKey(key)
  if (typeof type === "string") {
    return { [TypeId]: TypeId, _tag: "Element", type, props, key: k, staticChildren }
  }
  if (type === Fragment) {
    return { [TypeId]: TypeId, _tag: "Fragment", children: props.children, key: k, staticChildren }
  }
  if (typeof type === "function") {
    return { [TypeId]: TypeId, _tag: "Component", type: type as ComponentFn<any, any, any>, props, key: k }
  }
  throw new TypeError(`effect-lsc: invalid JSX element type: ${String(type)}`)
}
