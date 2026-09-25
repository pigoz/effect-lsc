/**
 * `View`: the component model of effect-lsc.
 *
 * - `View.Component` turns a generator into a component
 * - `View.use` brings a component with services or typed errors into a parent
 * - `View.State` creates component-local state that survives re-renders
 * - `View.SharedState` creates state shared by components and sessions
 * - `View.watch` makes a component re-render when a state or an atom changes
 * - `View.result` waits for the value of an async atom
 * - `View.catchTag`, `View.catchTags`, `View.orDie` handle typed render errors
 * - `View.provide` provides a layer to a component and its subtree
 * - `View.render` renders a tree to HTML once (handy for tests)
 *
 * Components run on the server and re-run when their state changes; the
 * resulting patches are merged into the page by the browser runtime.
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { dual, identity } from "effect/Function"
import * as Layer from "effect/Layer"
import { type Pipeable, pipeArguments } from "effect/Pipeable"
import * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import type * as Types from "effect/Types"
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type * as Atom from "effect/unstable/reactivity/Atom"
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import { isAtom, result as result_, watchAtom } from "./atom.ts"
import { follow, Instance } from "./instance.ts"
import { render as render_ } from "./render.ts"
import { makeSession } from "./session.ts"
import type { Boundary, Child, ClosedComponent, Props } from "./vnode.ts"
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
 * Typed errors are handled where a component is defined, with
 * `View.catchTag`, `View.catchTags` or `View.orDie`; this boundary is for
 * defects (thrown exceptions, `orDie`, interruptions).
 *
 * ```tsx
 * <View.ErrorBoundary fallback={(cause) => <p>Something broke</p>}>
 *   <Risky />
 * </View.ErrorBoundary>
 * ```
 *
 * Called as a function, it returns a node of itself, like the other
 * boundaries, so the boundary still applies.
 */
export const ErrorBoundary: (props: {
  readonly fallback: (cause: Cause.Cause<unknown>) => Child
  readonly children?: Child
}) => Child = Object.assign((props: Props): Child => jsx(ErrorBoundary, props), {
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

const pipeable = <F extends Function>(f: F): any =>
  Object.assign(f, {
    pipe(this: unknown) {
      return pipeArguments(this, arguments)
    }
  })

/**
 * Defines a component from a generator body. The body runs when the
 * component renders and may `yield*` any Effect, including `View.State`.
 * The result is typed with the body's own errors and services, plus the
 * `Subtree` of the components it brought in with `View.use`. It has a
 * `pipe` method, for `View.catchTag` and the other boundaries.
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
): // Subtree entries merged into one. Written inline: an alias would show up in hovers.
  & Signature<
    Args,
    Effect.Effect<
      A,
      Effect.Error<Eff>,
      | Exclude<Effect.Services<Eff>, Subtree<any, any>>
      | ([Extract<Effect.Services<Eff>, Subtree<any, any>>] extends [never] ? never
        : Subtree<ErrorsIn<Effect.Services<Eff>>, ServicesIn<Effect.Services<Eff>>>)
    >
  >
  & Pipeable => pipeable(Effect.fnUntraced(body))

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
export type Component<Args extends [props?: any], E = never, R = never> =
  & Signature<Args, Effect.Effect<Child, E, Instance | R | Lift<E, R>>>
  & Pipeable

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
 * `SharedState`, or, as an escape hatch, any `SubscriptionRef`. Atoms are
 * watched too, see `watch`.
 */
export type Watchable<A> = State<A> | SharedState<A> | SubscriptionRef.SubscriptionRef<A>

/** Subscribes the instance to a source; the result releases the subscription. */
const subscribe = <A>(source: Watchable<A>, instance: Instance["Service"]): Effect.Effect<Effect.Effect<void>> => {
  if (StateTypeId in source) {
    const add = subscribers.get(source)!
    // a listener of its own: releasing it must not remove the owner's, which
    // is the same `invalidate` when a component watches its own state
    return Effect.sync(() => Effect.sync(add(Effect.suspend(() => instance.invalidate))))
  }
  const ref: SubscriptionRef.SubscriptionRef<A> = SharedStateTypeId in source
    ? refs.get(source)!
    : source as SubscriptionRef.SubscriptionRef<A>
  return SubscriptionRef.changes(ref).pipe(
    Stream.drop(1),
    Stream.runForEach(() => instance.invalidate),
    Effect.forkIn(instance.scope, { startImmediately: true }),
    Effect.map((fiber) => Fiber.interrupt(fiber))
  )
}

const read = <A>(source: Watchable<A>): A =>
  StateTypeId in source || SharedStateTypeId in source
    ? (source as State<A> | SharedState<A>).value
    : SubscriptionRef.getUnsafe(source as SubscriptionRef.SubscriptionRef<A>)

/**
 * Reads a state or an atom and re-renders the component whenever it
 * changes. This is how a component depends on state it does not own: a
 * `SharedState` from a service, a `State` handle received from a parent, or
 * an Effect atom (`effect/unstable/reactivity`).
 *
 * Each call is a slot, like `View.State`. When a later render passes a
 * different source at the same position (a new handle in the props,
 * `Atom.family(props.id)` with a new id), the slot follows it: it
 * subscribes to the new source and releases the old one.
 *
 * Atoms are read from the `AtomRegistry` service, which the application
 * provides once (`AtomRegistry.layer`), so every session shares them
 * unless a subtree provides its own. An async atom is an `AsyncResult`:
 * render it with `AsyncResult.builder`, or use `View.result` to wait for it.
 */
export const watch: {
  <A>(atom: Atom.Atom<A>): Effect.Effect<A, never, Instance | AtomRegistry.AtomRegistry>
  <A>(source: Watchable<A>): Effect.Effect<A, never, Instance>
} = <A>(source: Watchable<A> | Atom.Atom<A>): Effect.Effect<A, never, any> =>
  isAtom(source)
    ? watchAtom(source)
    : Effect.flatMap(Instance, (instance) =>
      Effect.map(follow(instance, [source], subscribe(source, instance)), () => read(source)))

/**
 * Watches an async atom and returns its value once it has one: the render
 * waits while the atom is `Initial` (and, with `suspendOnWaiting`, while it
 * is refreshing), and the atom's typed error becomes the component's, to be
 * handled with `View.catchTag`. The whole session render waits with it, so
 * use it for fast data or data the first page must contain; otherwise
 * `watch` the `AsyncResult` and render its states. Each call is a slot,
 * like `View.watch`.
 */
export const result: <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: { readonly suspendOnWaiting?: boolean | undefined }
) => Effect.Effect<A, E, Instance | AtomRegistry.AtomRegistry> = result_

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
 * they do. Only render boundaries (`View.catchTag` and friends) remove
 * its errors, and only `View.provide` provides its services. The root
 * reads it back: `View.render` fails with its errors and needs its
 * services, `Server.mount`, `Server.page`, `Server.session` and
 * `Cloudflare.app` need its services and reject its errors.
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
 * A component that renders `component` inside a boundary. Rendered as a
 * tag, the renderer runs `component` as its body; called as a function, it
 * returns a node of itself, so the boundary is never skipped. It has the
 * instance and the path of the component it wraps.
 */
const boundary = (component: (props: any) => Child | Effect.Effect<Child, any, any>, spec: Omit<Boundary, "render">): any => {
  const self: any = pipeable(Object.assign((props?: Props) => Effect.succeed(jsx(self, props ?? {})), {
    [BoundaryTypeId]: { render: component, ...spec } satisfies Boundary
  }))
  return self
}

/**
 * Rejects recovery handlers that use `View.State`, `View.watch` or
 * `View.once`: recovery runs outside any instance. Return a component
 * (`<Fallback />`) that does instead.
 */
type NoInstance<R> = [Extract<R, Instance>] extends [never] ? unknown
  : { readonly "effect-lsc: recovery runs outside the instance; return a component that uses View.State instead": never }
type Recovered<E2, R2> = (Child | Effect.Effect<Child, E2, R2>) & NoInstance<R2>
type TagOf<K> = K extends ReadonlyArray<string> ? K[number] : K
/** A boundary: its errors and services all surface when it renders, so they are all in `Subtree`. */
type Bounded<Args extends [props?: any], E, R> =
  & Signature<Args, Effect.Effect<Child, never, Instance | Lift<E, Services<R>>>>
  & Pipeable

const hasTag = (error: unknown, tags: ReadonlyArray<string>): error is { readonly _tag: string } =>
  typeof error === "object" && error !== null && "_tag" in error && tags.includes((error as any)._tag)

/**
 * Handles typed errors with the given tag (or tags) raised while rendering
 * `component` or anything in its subtree, rendering `f(error, props)` in
 * its place. Other failures pass through to the next boundary. Like
 * `Effect.catchTag`, it handles the first typed failure of the cause.
 *
 * It is a render boundary: it retries when its subtree changes, and it
 * keeps the instance and path of `component`. Define it at module level;
 * applied during a render it would create a new component every time.
 *
 * ```tsx
 * const Member = View.Component(function*(props: { readonly id: string }) {
 *   const users = yield* Users
 *   const user = yield* users.find(props.id) // fails with UserNotFound
 *   return <li>{user.name}</li>
 * }).pipe(View.catchTag("UserNotFound", (error) => <li>unknown user {error.id}</li>))
 * ```
 */
export const catchTag: {
  <
    E,
    R,
    Args extends [props?: any],
    const K extends Types.Tags<Errors<E, R>> | readonly [Types.Tags<Errors<E, R>>, ...Array<Types.Tags<Errors<E, R>>>],
    E2 = never,
    R2 = never
  >(
    tag: K,
    f: (error: NoInfer<Types.ExtractTag<Errors<E, R>, TagOf<K>>>, props: NoInfer<Args[0]>) => Recovered<E2, R2>
  ): (
    component: (...args: Args) => Effect.Effect<Child, E, R>
  ) => Bounded<Args, Types.ExcludeTag<Errors<E, R>, TagOf<K>> | Errors<E2, R2>, R | R2>
  <
    Args extends [props?: any],
    E,
    R,
    const K extends Types.Tags<Errors<E, R>> | readonly [Types.Tags<Errors<E, R>>, ...Array<Types.Tags<Errors<E, R>>>],
    E2 = never,
    R2 = never
  >(
    component: (...args: Args) => Effect.Effect<Child, E, R>,
    tag: K,
    f: (error: Types.ExtractTag<Errors<E, R>, TagOf<K>>, ...args: Args) => Recovered<E2, R2>
  ): Bounded<Args, Types.ExcludeTag<Errors<E, R>, TagOf<K>> | Errors<E2, R2>, R | R2>
} = dual(3, (component: any, tag: string | ReadonlyArray<string>, f: (error: unknown, props: unknown) => any) => {
  const tags: ReadonlyArray<string> = typeof tag === "string" ? [tag] : tag
  return boundary(component, {
    recover: (cause, props) => {
      const error = Cause.findError(cause)
      return Result.isSuccess(error) && hasTag(error.success, tags) ? f(error.success, props) : Effect.failCause(cause)
    }
  })
})

type CasesOf<E, Args extends [props?: any]> = {
  readonly [K in Types.Tags<E>]+?: (error: Types.ExtractTag<E, K>, props: Args[0]) => Child | Effect.Effect<Child, any, any>
}
/** The tags with a handler: an optional key, or one that may be `undefined`, may have none at runtime. */
type HandledTags<Cases> = {
  [K in keyof Cases]-?: {} extends Pick<Cases, K> ? never : undefined extends Cases[K] ? never : K
}[keyof Cases]
type CaseOutput<Cases> = {
  [K in keyof Cases]-?: NonNullable<Cases[K]> extends (...args: any) => infer Out ? Out : never
}[keyof Cases]
type CaseError<Cases> = Effect.Error<Extract<CaseOutput<Cases>, Effect.Effect<any, any, any>>>
type CaseServices<Cases> = Effect.Services<Extract<CaseOutput<Cases>, Effect.Effect<any, any, any>>>
/**
 * A boundary for `catchTags`. A handler that needs `Instance` cannot be
 * rejected where it is written without losing the handlers' contextual
 * types, so the result is unusable instead, and names the problem.
 */
type CatchTagsResult<Args extends [props?: any], E, R, Cases> = [Extract<CaseServices<Cases>, Instance>] extends [never]
  ? Bounded<
    Args,
    Exclude<Errors<E, R>, { readonly _tag: HandledTags<Cases> }> | Errors<CaseError<Cases>, CaseServices<Cases>>,
    R | CaseServices<Cases>
  >
  : { readonly "effect-lsc: recovery runs outside the instance; return a component that uses View.State instead": never }
type NoExtraTags<Cases, E> = { readonly [K in Exclude<keyof Cases, Types.Tags<E>>]: never }

/**
 * `catchTag` for several tags at once, one handler per tag. Unknown tags
 * are rejected.
 */
export const catchTags: {
  <E, R, Args extends [props?: any], Cases extends CasesOf<Errors<E, R>, Args> & NoExtraTags<Cases, Errors<E, R>>>(
    cases: Cases
  ): (component: (...args: Args) => Effect.Effect<Child, E, R>) => CatchTagsResult<Args, E, R, Cases>
  <Args extends [props?: any], E, R, Cases extends CasesOf<Errors<E, R>, Args> & NoExtraTags<Cases, Errors<E, R>>>(
    component: (...args: Args) => Effect.Effect<Child, E, R>,
    cases: Cases
  ): CatchTagsResult<Args, E, R, Cases>
} = dual(2, (component: any, cases: Record<string, ((error: unknown, props: unknown) => any) | undefined>) => {
  const tags = Object.keys(cases).filter((tag) => cases[tag] !== undefined)
  return boundary(component, {
    recover: (cause, props) => {
      const error = Cause.findError(cause)
      return Result.isSuccess(error) && hasTag(error.success, tags)
        ? cases[error.success._tag]!(error.success, props)
        : Effect.failCause(cause)
    }
  })
})

/**
 * Turns every typed error of `component` and its subtree into a defect,
 * for the nearest `View.ErrorBoundary` (or the end of the session). Only
 * the typed failures change; the rest of the cause is kept.
 */
export const orDie = <Args extends [props?: any], E, R>(
  component: (...args: Args) => Effect.Effect<Child, E, R>
): Bounded<Args, never, R> =>
  boundary(component as any, {
    recover: (cause) =>
      Effect.failCause(
        Cause.fromReasons(cause.reasons.map((reason) => Cause.isFailReason(reason) ? Cause.makeDieReason(reason.error) : reason))
      )
  })

/**
 * Rejects layers that need `Instance`, such as one built with `View.State`:
 * the layer is built outside the instance, whose slots belong to the
 * component. The layer keeps its state in a `View.SharedState` instead.
 */
type NoInstanceIn<RIn> = [Extract<RIn, Instance>] extends [never] ? unknown
  : { readonly "effect-lsc: a View.provide layer runs outside the instance; use View.SharedState instead of View.State": never }

/**
 * Provides `layer` to `component` and its whole subtree. Each instance
 * builds its own copy, on its first render and in its instance scope, even
 * when the application or an enclosing `View.provide` has built the same
 * layer. The copy is released when the component leaves the page or the
 * session ends, after the components below it. At the root, that is one
 * build per page render and one per live session:
 *
 * ```ts
 * Server.mount("/", View.provide(App, TabCache.layer))
 * ```
 *
 * The result no longer needs what the layer provides; it needs what the
 * layer requires and can fail with its error, in its `Subtree`. A layer
 * that fails to build fails the render, up to the next boundary, and is
 * not rebuilt until the component remounts. Define it at module level.
 */
export const provide: {
  <ROut, E2, RIn>(
    layer: Layer.Layer<ROut, E2, RIn> & NoInstanceIn<RIn>
  ): <Args extends [props?: any], E, R>(
    component: (...args: Args) => Child | Effect.Effect<Child, E, R>
  ) => Bounded<Args, Errors<E, R> | Errors<E2, RIn>, Exclude<Services<R>, ROut> | RIn>
  <Args extends [props?: any], E, R, ROut, E2, RIn>(
    component: (...args: Args) => Child | Effect.Effect<Child, E, R>,
    layer: Layer.Layer<ROut, E2, RIn> & NoInstanceIn<RIn>
  ): Bounded<Args, Errors<E, R> | Errors<E2, RIn>, Exclude<Services<R>, ROut> | RIn>
} = dual(2, (component: any, layer: Layer.Layer<any, any, any>) =>
  boundary(component, {
    // `Layer.fresh`: `Layer.build` would reuse a build of the same layer
    // from the memo map of the application or of an enclosing View.provide.
    // Built without Instance, so a cast layer cannot take the component's
    // slots. The build's exit is kept in a slot: a failed build fails every
    // render until the instance remounts.
    wrap: (render) =>
      Effect.flatMap(
        once(Effect.exit(Effect.updateContext(Layer.build(Layer.fresh(layer)), Context.omit(Instance)))),
        (built) => Exit.isSuccess(built) ? Effect.provideContext(render, built.value) : Effect.failCause(built.cause)
      )
  }))

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
