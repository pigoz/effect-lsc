/**
 * The virtual node model produced by JSX.
 *
 * A VNode is plain data. Nothing here is reactive: a component is just a
 * function from props to a `Child` (or an `Effect` producing one), and the
 * renderer turns the resulting tree into an HTML string on the server.
 */
import type * as Effect from "effect/Effect"
import { hasProperty } from "effect/Predicate"

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
 * Effect service available in the server context.
 */
export type ComponentFn<P, E = never, R = never> = (props: P) => Child | Effect.Effect<Child, E, R>

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
