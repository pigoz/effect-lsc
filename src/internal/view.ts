/**
 * `View`: the component model of effect-lsc.
 *
 * - `View.Component` turns a generator into a component
 * - `View.State` creates component-local state that survives re-renders
 * - `View.watch` subscribes a component to any `SubscriptionRef`
 * - `View.render` renders a tree to HTML once (handy for tests)
 *
 * Components run on the server and re-run on every state change; the
 * resulting HTML is diffed into the page by the browser runtime.
 */
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import { Instance } from "./instance.ts"
import { render as render_ } from "./render.ts"
import { makeSession } from "./session.ts"
import type { Child } from "./vnode.ts"
import { raw as raw_, Fragment as Fragment_ } from "./vnode.ts"

export type {
  EventBase,
  FocusEvent,
  Handler,
  InputEvent,
  KeyboardEvent,
  MouseEvent,
  SubmitEvent,
  ViewEvent
} from "./events.ts"
export type { Child, ComponentFn, ComponentNode, Element, FragmentNode, Props, Raw, VNode } from "./vnode.ts"
export { Instance } from "./instance.ts"

/**
 * Wraps a trusted HTML string so it is emitted verbatim.
 */
export const raw: (html: string) => import("./vnode.ts").Raw = raw_

export const Fragment: typeof Fragment_ = Fragment_

/**
 * Defines a component from a generator body. The body runs on every render
 * of the component and may `yield*` any Effect, including `View.State`.
 *
 * ```tsx
 * const Counter = View.Component(function*() {
 *   const count = yield* View.State(0)
 *   return <button onClick={() => count.update((n) => n + 1)}>{count.value}</button>
 * })
 * ```
 */
export const Component = <
  Args extends [props?: any],
  Eff extends Effect.Effect<any, any, any>,
  A extends Child
>(
  body: (...args: Args) => Generator<Eff, A, never>
): (...args: Args) => Effect.Effect<A, Effect.Error<Eff>, Effect.Services<Eff>> => Effect.fnUntraced(body) as any

/**
 * Component-local state. Reads are synchronous (`state.value`), writes are
 * Effects that also schedule a re-render of the session.
 */
export interface State<A> {
  readonly value: A
  readonly get: Effect.Effect<A>
  readonly set: (value: A) => Effect.Effect<void>
  readonly update: (f: (value: A) => A) => Effect.Effect<void>
  /** The underlying ref, for streaming changes or sharing with other code. */
  readonly ref: SubscriptionRef.SubscriptionRef<A>
}

const makeState = <A>(ref: SubscriptionRef.SubscriptionRef<A>): State<A> => ({
  get value() {
    return SubscriptionRef.getUnsafe(ref)
  },
  get: SubscriptionRef.get(ref),
  set: (value) => SubscriptionRef.set(ref, value),
  update: (f) => SubscriptionRef.update(ref, f),
  ref
})

/**
 * Subscribes the instance to `ref`: every change after the current value
 * invalidates the session. The subscription lives in the instance scope.
 */
const subscribe = <A>(
  ref: SubscriptionRef.SubscriptionRef<A>,
  instance: Instance["Service"]
): Effect.Effect<void, never, Scope.Scope> =>
  SubscriptionRef.changes(ref).pipe(
    Stream.drop(1),
    Stream.runForEach(() => instance.invalidate),
    Effect.forkIn(instance.scope, { startImmediately: true }),
    Effect.asVoid
  )

/**
 * Creates state local to the component instance. The initial value is used
 * on the first render only; later renders return the same `State`.
 *
 * Call it unconditionally and in the same order on every render.
 */
export const State = <A>(initial: A): Effect.Effect<State<A>, never, Instance> =>
  Effect.flatMap(Instance, (instance) =>
    instance.slot(
      Effect.gen(function*() {
        const ref = yield* SubscriptionRef.make(initial)
        yield* subscribe(ref, instance)
        return makeState(ref)
      })
    ))

/**
 * Reads a `SubscriptionRef` and re-renders the component whenever it
 * changes. This is how components depend on state that lives outside them,
 * for example in a service shared by every session.
 */
export const watch = <A>(ref: SubscriptionRef.SubscriptionRef<A>): Effect.Effect<A, never, Instance> =>
  Effect.flatMap(Instance, (instance) =>
    Effect.map(instance.slot(subscribe(ref, instance)), () => SubscriptionRef.getUnsafe(ref)))

/**
 * Renders a tree to an HTML string with a throwaway session. Handlers are
 * rendered as ids but nothing is listening for them.
 */
export const render = (child: Child): Effect.Effect<string, unknown> =>
  Effect.scoped(Effect.flatMap(makeSession, (session) => render_(session, child)))
