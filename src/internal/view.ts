/**
 * `View`: the component model of effect-lsc.
 *
 * - `View.Component` turns a generator into a component
 * - `View.use` brings a component with services or typed errors into a parent
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
import type { Boundary, Child, ClosedComponent } from "./vnode.ts"
import { BoundaryTypeId, Fragment as Fragment_, jsx, raw as raw_ } from "./vnode.ts"

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
export type { ClosedComponent as Closed }
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
}) => Child = Object.assign((props: { readonly children?: Child }) => props.children, {
  [BoundaryTypeId]: {
    render: (props: { readonly children?: Child }) => props.children,
    recover: (cause: Cause.Cause<unknown>, props: { readonly fallback: (cause: Cause.Cause<unknown>) => Child }) =>
      props.fallback(cause)
  } satisfies Boundary
})

// -----------------------------------------------------------------------------
// Components
// -----------------------------------------------------------------------------

/**
 * The call signature of a component. `(...args: []) => A` would let JSX
 * accept any attribute on a component without props; `() => A` keeps the
 * excess-attribute check.
 */
type Signature<Args extends [props?: any], A> = [Args] extends [[]] ? () => A : (...args: Args) => A

/**
 * Defines a component from a generator body. The body runs when the
 * component renders and may `yield*` any Effect, including `View.State`.
 * The result is typed with the body's own errors and services, plus the
 * `Subtree` of the components it brought in with `View.use`.
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
): Signature<
  Args,
  Effect.Effect<
    A,
    Effect.Error<Eff>,
    // Subtree entries merged into one. Written inline: an alias would show up in hovers.
    | Exclude<Effect.Services<Eff>, Subtree<any, any>>
    | ([Extract<Effect.Services<Eff>, Subtree<any, any>>] extends [never] ? never
      : Subtree<ErrorsIn<Effect.Services<Eff>>, ServicesIn<Effect.Services<Eff>>>)
  >
> => Effect.fnUntraced(body) as any

/**
 * The type of a component whose tree fails with at most `E` and needs at
 * most `R`; `View.Component<Args>` alone is a closed component. Annotate a
 * recursive component with it:
 *
 * ```tsx
 * const Tree: View.Component<
 *   [props: { readonly id: string }],
 *   NotFound,
 *   Db
 * > = View.Component(function*(props) {
 *   const Node = yield* View.use(Tree)
 *   ...
 * })
 * ```
 */
export type Component<Args extends [props?: any], E = never, R = never> = Signature<
  Args,
  Effect.Effect<Child, E, Instance | R | Lift<E, R>>
>

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

// -----------------------------------------------------------------------------
// Services and typed errors across components
// -----------------------------------------------------------------------------

declare const SubtreeTypeId: unique symbol

/**
 * What a component's subtree can fail with (`E`) and needs (`R`), as
 * recorded by `View.use`. It lives in the requirements channel on purpose:
 * those errors and services belong to children that render after the
 * parent's body has returned, so `Effect.catchTag` or `Effect.provide`
 * around the parent cannot handle them, and the types must not pretend
 * they do. The root reads it back: `View.render` fails with its errors and
 * needs its services, `Server.mount`, `Server.page`, `Server.session` and
 * `Cloudflare.app` need its services.
 */
export interface Subtree<out E, out R> {
  readonly [SubtreeTypeId]: { readonly E: () => E; readonly R: () => R }
}

type ErrorsIn<R> = R extends Subtree<infer E, any> ? E : never
type ServicesIn<R> = R extends Subtree<any, infer S> ? S : never
type Own<R> = Exclude<R, Subtree<any, any>>
/** Every typed error of a component with `E` and `R`, its subtree's included. */
export type Errors<E, R> = [E | ErrorsIn<R>][0]
/** Every service a component with `R` needs, its subtree's included, `Instance` excluded. */
export type Services<R> = [Exclude<Own<R> | ServicesIn<R>, Instance>][0]
type Lift<E, R> = [E | R] extends [never] ? never : Subtree<[E][0], [R][0]>

/**
 * Rejects components that require `Scope`: during a render it would be the
 * session's scope, so every render would add a finalizer to it.
 */
export type NoScope<R> = [Extract<R, Scope.Scope>] extends [never] ? unknown
  : { readonly "effect-lsc: this component requires Scope; acquire resources with View.once": never }

/**
 * Brings a component with services or typed errors into the current
 * component, and returns it as a closed component usable as a JSX tag.
 * Its errors and services, and those of its own subtree, are recorded in
 * the caller's `Subtree`, so they reach the root's type.
 *
 * At runtime it returns the same function: the child keeps its instance
 * and state, and `use` takes no slot, so it may be called conditionally.
 *
 * ```tsx
 * const App = View.Component(function*() {
 *   const Item = yield* View.use(TodoItem)
 *   return <ul>{todos.map((todo) => <Item key={todo.id} todo={todo} />)}</ul>
 * })
 * ```
 */
export const use = <Args extends [props?: any], E = never, R = never>(
  component: ((...args: Args) => Child | Effect.Effect<Child, E, R>) & NoScope<Services<R>>
): Effect.Effect<Signature<Args, Effect.Effect<Child, never, Instance>>, never, Lift<Errors<E, R>, Services<R>>> =>
  Effect.succeed(component as any)

/**
 * Renders a tree, or a component with its props, to an HTML string with a
 * throwaway, disconnected session. Handlers are rendered as ids but
 * nothing is listening for them. A component's typed errors and services,
 * its subtree's included, become those of the returned Effect.
 */
export const render: {
  <E = never, R = never>(
    component: (() => Child | Effect.Effect<Child, E, R>) & NoScope<Services<R>>
  ): Effect.Effect<string, Errors<E, R>, Services<R>>
  <P, E = never, R = never>(
    component: ((props: P) => Child | Effect.Effect<Child, E, R>) & NoScope<Services<R>>,
    props: P
  ): Effect.Effect<string, Errors<E, R>, Services<R>>
  (child: Child): Effect.Effect<string>
} = ((child: any, props?: any): Effect.Effect<string, any, any> =>
  Effect.scoped(Effect.flatMap(makeSession(false), (session) =>
    render_(session, typeof child === "function" ? jsx(child, props ?? {}) : child)))) as any
