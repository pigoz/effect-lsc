/**
 * `View`: the component model of effect-lsc.
 *
 * - `View.Component` turns a generator into a component
 * - `View.State` creates component-local state that survives re-renders
 * - `View.SharedState` creates state shared by components and sessions
 * - `View.watch` makes a component re-render when a state changes
 * - `View.render` renders a tree to HTML once (handy for tests)
 *
 * Components run on the server and re-run when their state changes; the
 * resulting patches are merged into the page by the browser runtime.
 */
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { identity } from "effect/Function"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import { Instance } from "./instance.ts"
import { render as render_ } from "./render.ts"
import { makeSession } from "./session.ts"
import type { Child } from "./vnode.ts"
import { BoundaryTypeId, Fragment as Fragment_, raw as raw_ } from "./vnode.ts"

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
 * Catches failures while rendering its children and renders
 * `fallback(cause)` instead, keeping the rest of the page alive. The
 * boundary re-renders, and so retries, whenever its subtree changes.
 * Without a boundary, a render failure ends the session and the browser
 * remounts a fresh one.
 *
 * ```tsx
 * <View.ErrorBoundary fallback={(cause) => <p>Something broke</p>}>
 *   <Risky />
 * </View.ErrorBoundary>
 * ```
 */
export const ErrorBoundary: (props: {
  readonly fallback: (cause: Cause.Cause<unknown>) => Child
  readonly children?: Child
}) => Child = Object.assign((props: { readonly children?: Child }) => props.children, { [BoundaryTypeId]: BoundaryTypeId })

/**
 * Defines a component from a generator body. The body runs when the
 * component renders and may `yield*` any Effect, including `View.State`.
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

// -----------------------------------------------------------------------------
// Local state
// -----------------------------------------------------------------------------

const StateTypeId = "~effect-lsc/View/State" as const
type StateTypeId = typeof StateTypeId

/**
 * Component-local state. Reads are synchronous (`state.value`), writes are
 * Effects that re-render the owning component and every component that
 * `watch`es the handle. Setting the identical value is a no-op.
 *
 * A state is a plain cell with listeners: no fiber, no stream, no lock.
 * Handlers of a session run one at a time, so none is needed.
 */
export interface State<A> {
  readonly [StateTypeId]: StateTypeId
  readonly value: A
  readonly get: Effect.Effect<A>
  readonly set: (value: A) => Effect.Effect<void>
  readonly update: (f: (value: A) => A) => Effect.Effect<void>
}

type Listener = Effect.Effect<void>
const subscribers = new WeakMap<object, (listener: Listener) => () => void>()

export const isState = (u: unknown): u is State<unknown> =>
  typeof u === "object" && u !== null && StateTypeId in u

const makeState = <A>(initial: A, owner: Listener): State<A> => {
  let current = initial
  const listeners = new Set<Listener>([owner])
  const notify = Effect.suspend(() => Effect.forEach(listeners, identity, { discard: true }))
  const set = (value: A): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (Object.is(value, current)) return Effect.void
      current = value
      return notify
    })
  const state: State<A> = {
    [StateTypeId]: StateTypeId,
    get value() {
      return current
    },
    get: Effect.sync(() => current),
    set,
    update: (f) => Effect.suspend(() => set(f(current)))
  }
  subscribers.set(state, (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  })
  return state
}

/**
 * Creates state local to the component instance. The initial value is used
 * on the first render only; later renders return the same `State`.
 *
 * Call it unconditionally and in the same order on every render.
 */
export const State = <A>(initial: A): Effect.Effect<State<A>, never, Instance> =>
  Effect.flatMap(Instance, (instance) => instance.slot(Effect.sync(() => makeState(initial, instance.invalidate))))

// -----------------------------------------------------------------------------
// Shared state
// -----------------------------------------------------------------------------

const SharedStateTypeId = "~effect-lsc/View/SharedState" as const
type SharedStateTypeId = typeof SharedStateTypeId

/**
 * State shared by components, and by sessions when it lives in a service:
 * every component that `watch`es it re-renders when it changes, whichever
 * session changed it. Backed by a `SubscriptionRef`, so concurrent updates
 * from different sessions are serialized.
 */
export interface SharedState<A> {
  readonly [SharedStateTypeId]: SharedStateTypeId
  readonly value: A
  readonly get: Effect.Effect<A>
  readonly set: (value: A) => Effect.Effect<void>
  readonly update: (f: (value: A) => A) => Effect.Effect<void>
  readonly modify: <B>(f: (value: A) => readonly [B, A]) => Effect.Effect<B>
  /** Every change, for code outside components. */
  readonly changes: Stream.Stream<A>
}

const refs = new WeakMap<object, SubscriptionRef.SubscriptionRef<any>>()

export const isSharedState = (u: unknown): u is SharedState<unknown> =>
  typeof u === "object" && u !== null && SharedStateTypeId in u

/**
 * Creates shared state. Put it in a service to share it across sessions:
 *
 * ```ts
 * class Count extends Context.Service<Count, View.SharedState<number>>()("app/Count") {
 *   static readonly layer = Layer.effect(Count, View.SharedState(0))
 * }
 * ```
 */
export const SharedState = <A>(initial: A): Effect.Effect<SharedState<A>> =>
  Effect.map(SubscriptionRef.make(initial), (ref) => {
    const state: SharedState<A> = {
      [SharedStateTypeId]: SharedStateTypeId,
      get value() {
        return SubscriptionRef.getUnsafe(ref)
      },
      get: SubscriptionRef.get(ref),
      set: (value) => SubscriptionRef.set(ref, value),
      update: (f) => SubscriptionRef.update(ref, f),
      modify: (f) => SubscriptionRef.modify(ref, f),
      changes: Stream.drop(SubscriptionRef.changes(ref), 1)
    }
    refs.set(state, ref)
    return state
  })

// -----------------------------------------------------------------------------
// Watching
// -----------------------------------------------------------------------------

/**
 * What a component can watch: its own or another component's `State`, a
 * `SharedState`, or, as an escape hatch, any `SubscriptionRef`.
 */
export type Watchable<A> = State<A> | SharedState<A> | SubscriptionRef.SubscriptionRef<A>

/** Subscribes the instance to a ref: every change invalidates it. */
const subscribeRef = <A>(
  ref: SubscriptionRef.SubscriptionRef<A>,
  instance: Instance["Service"]
): Effect.Effect<void, never, Scope.Scope> =>
  SubscriptionRef.changes(ref).pipe(
    Stream.drop(1),
    Stream.runForEach(() => instance.invalidate),
    Effect.forkIn(instance.scope, { startImmediately: true }),
    Effect.asVoid
  )

const subscribe = <A>(source: Watchable<A>, instance: Instance["Service"]): Effect.Effect<void, never, Scope.Scope> => {
  if (StateTypeId in source) {
    const add = subscribers.get(source)!
    return Effect.acquireRelease(
      Effect.sync(() => add(instance.invalidate)),
      (unsubscribe) => Effect.sync(unsubscribe)
    ).pipe(Effect.asVoid)
  }
  const ref: SubscriptionRef.SubscriptionRef<A> = SharedStateTypeId in source
    ? refs.get(source)!
    : source as SubscriptionRef.SubscriptionRef<A>
  return subscribeRef(ref, instance)
}

const read = <A>(source: Watchable<A>): A =>
  StateTypeId in source || SharedStateTypeId in source
    ? (source as State<A> | SharedState<A>).value
    : SubscriptionRef.getUnsafe(source as SubscriptionRef.SubscriptionRef<A>)

/**
 * Reads a state and re-renders the component whenever it changes. This is
 * how a component depends on state it does not own: a `SharedState` from a
 * service, or a `State` handle received from a parent.
 */
export const watch = <A>(source: Watchable<A>): Effect.Effect<A, never, Instance> =>
  Effect.flatMap(Instance, (instance) => Effect.map(instance.slot(subscribe(source, instance)), () => read(source)))

/**
 * Runs `effect` once per component instance, on its first render, in the
 * instance scope, and returns its result on every render. Use it to start
 * a fiber that lives with the component:
 *
 * ```ts
 * yield* View.once(Effect.forkScoped(ticker))
 * ```
 */
export const once = <A>(effect: Effect.Effect<A, never, Scope.Scope>): Effect.Effect<A, never, Instance> =>
  Effect.flatMap(Instance, (instance) => instance.slot(effect))

/**
 * `false` during the HTTP render of the page, `true` in the live session.
 * Both run the component; use it to skip work that only matters live, such
 * as subscribing to a feed or starting a timer.
 *
 * ```ts
 * if (yield* View.connected) yield* startTicker
 * ```
 */
export const connected: Effect.Effect<boolean, never, Instance> = Effect.map(Instance, (instance) => instance.connected)

/**
 * Renders a tree to an HTML string with a throwaway, disconnected session.
 * Handlers are rendered as ids but nothing is listening for them.
 */
export const render = (child: Child): Effect.Effect<string, unknown> =>
  Effect.scoped(Effect.flatMap(makeSession(false), (session) => render_(session, child)))
