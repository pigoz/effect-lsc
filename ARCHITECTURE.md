# Architecture

Components, state and event handlers run on the server. The browser receives
HTML and a generic runtime that sends events over a WebSocket and applies
updates to the page. Start with the [README](./README.md) for runnable examples.

- [API](#api)
- [Platform integration](#platform-integration)
- [Errors and reconnects](#errors-and-reconnects)
- [How it works](#how-it-works)

## API

### Components and JSX

Import `View` from `effect-lsc/view`. `View.Component` wraps an Effect
generator that receives props and returns JSX:

```tsx
const Greeting = View.Component(function*(props: { readonly name: string }) {
  const expanded = yield* View.State(false)
  return (
    <button onClick={() => expanded.update((value) => !value)}>
      {expanded.value ? `Hello, ${props.name}` : "Say hello"}
    </button>
  )
})
```

Plain functions returning JSX are components too. Attributes use HTML names
such as `class` and `for`. `class` accepts an array with falsy entries, and
`style` accepts an object. Use `key` on dynamic list items to preserve their
component identity when items are inserted, removed or moved.

JSX accepts closed components: plain functions, and components whose Effect
has no typed error and needs no service besides `View.Instance`, which the
renderer provides. A component with services or typed errors is brought
into its parent with `View.use`; see
[services and typed errors](#services-and-typed-errors-across-components).
`View.Closed<P>` is the type of a closed component, for props that receive
one.

`View.Component` does not keep the type parameters of a generic body. Write
a generic component as a plain function; it can return `Effect.gen(...)` to
use `View.State`. JSX rejects a generic tag whose typed errors or services
come from a type parameter; see
[services and typed errors](#services-and-typed-errors-across-components).

A component runs on its first render, when its state or watched sources
change, when a descendant changes, or when its props differ. Otherwise the
renderer reuses its previous output. Derived values can be computed in the
body, such as `todos.filter((todo) => !todo.completed).length`.

### State

| API | Purpose |
| --- | --- |
| `View.State(initial)` | Create state owned by this component instance. The initial value is used only on its first render. |
| `View.SharedState(initial)` | Create state that multiple components or sessions can share. Put it in a service to give it a lifetime beyond one component. |
| `View.watch(source)` | Read and subscribe to a local state handle, shared state, Effect `SubscriptionRef` or Effect atom; see [atoms](#atoms). Changes schedule a render of this component. |

Both state types expose `value` for synchronous reads, `get` for an Effect
read, and `set(value)` / `update(f)` for writes. Writes are Effects: return
them from a handler or execute them with `yield*`.

Shared state also has `modify(f)`, where `f` returns `[result, nextState]`,
and a `changes` stream for consumers outside components. Updates to the
same shared state are serialized, including updates from different sessions.
Sharing does not imply persistence: the state lasts as long as its owner.

**Call `View.State`, `View.watch`, `View.result` and `View.once` in the
same order on each render.** They occupy slots in the component instance.
A `watch` slot follows its source: when a later render passes a different
one at the same position, such as a new handle in the props, it
subscribes to the new source and releases the old one. A component's own
state is tracked automatically; state from elsewhere must be watched:

```tsx
const CountLabel = View.Component(function*(props: {
  readonly count: View.State<number>
}) {
  const count = yield* View.watch(props.count)
  return <span>{count}</span>
})
```

Reading only `props.count.value` would not subscribe `CountLabel`. The handle
keeps the same identity, so props comparison alone would not re-render it.
Likewise, watch shared state from a service instead of reading its `value`
directly in the component body.

### Events and services

Handlers receive a small payload extracted from the DOM event, not a browser
`Event` object:

| Handlers | Payload beyond `type` |
| --- | --- |
| `onClick`, `onDblClick` | Element `value` / `checked`, when available |
| `onInput`, `onChange` | `value`, and `checked` for checkbox or radio inputs |
| `onKeyDown`, `onKeyUp` | `key`, and element values when available |
| `onFocus`, `onBlur` | Element values when available |
| `onSubmit` | `form`, a record of field names and string values |

A handler returns an Effect or nothing. Acquire services in the component
body and close over them in handlers:

```tsx
const NewTodo = View.Component(function*() {
  const todos = yield* Todos
  return (
    <form onSubmit={(event) => {
      const title = (event.form.title ?? "").trim()
      if (title) return todos.add(title)
    }}>
      <input name="title" />
    </form>
  )
})
```

Here `Todos` is the application service from the TodoMVC examples. Provide
its layer to the server with `Layer.provide(Todos.layer)`, or to
`Cloudflare.app` through its `layer` option. `NewTodo` needs `Todos`, so its
parent brings it in with `View.use`, and the root's type requires `Todos`.

Events run one at a time, in arrival order, within each session. A slow
handler delays later events from that browser. Other sessions can continue
handling their own events.

### Services and typed errors across components

A component's Effect covers its body only. Its children render later, after
the body has returned, so their services and errors are not part of that
Effect. `View.use` records them in the parent's type instead:

```tsx
const Member = View.Component(function*(props: { readonly id: string }) {
  const users = yield* Users
  const user = yield* users.find(props.id) // fails with UserNotFound
  return <li>{user.name}</li>
})

const Members = View.Component(function*(props: { readonly ids: ReadonlyArray<string> }) {
  const Row = yield* View.use(Member)
  return <ul>{props.ids.map((id) => <Row key={id} id={id} />)}</ul>
})
// (props) => Effect<VNode, never, View.Subtree<UserNotFound, Users>>
```

`use` returns the child as a closed component, usable as a tag. At runtime
it returns the same function: the child keeps its instance and state, and
`use` takes no slot, so it may be called conditionally. Every `use` in a
`View.Component` body merges into one `View.Subtree<E, R>`, which also
carries what the child itself used.

| Where the tree is rendered | What happens to `Subtree` |
| --- | --- |
| `View.render(Component, props)` | The Effect fails with every typed error in the tree and needs every service. |
| `Server.mount`, `Server.page`, `Server.session`, `Cloudflare.app` | They need every service in the tree, so a missing one is a type error, not a failure when the child renders. A typed error left in the tree is a type error too; see [what a root accepts](#what-a-root-accepts). |

`Subtree` lives in the requirements channel so that no Effect combinator
can remove it. `Effect.catchTag(Members(props), "UserNotFound", ...)` does
not compile, and `Effect.provideService(Members(props), Users, users)`
still requires `Subtree<UserNotFound, Users>`: neither would reach the
rows, which render after the body. `View.use` itself requires the
`Subtree` it records, so `Effect.runSync(View.use(Member))` does not
compile either. Provide services to the rows with `View.provide` instead;
see [services for a subtree](#services-for-a-subtree).

Handle a typed error in the body that raises it, or with `View.catchTag`
where the component is defined; see [typed errors](#typed-errors). At
runtime, an unhandled one fails the render like a defect:
`View.ErrorBoundary` catches it, but the types keep it in the parent's
`Subtree`.

`use` and `View.render` reject a component that requires `Scope`: during a
render it would be the session's scope, and every render would add a
finalizer to it. Acquire resources with `View.once`.

`View.Errors<E, R>` and `View.Services<R>` compute the typed errors and
the services of a component's whole tree, `Subtree` included, from the
`E` and `R` of its Effect, and `View.NoScope<R>` rejects `Scope`. `use`
and `View.render` are typed with them, as a wrapper around them can be.

A recursive component refers to its own type before it is inferred.
Annotate it with `View.Component<Args, E, R>`, the type of a component
whose tree fails with at most `E` and needs at most `R`:

```tsx
const Tree: View.Component<
  [props: { readonly node: TreeNode }],
  LabelNotFound,
  Labels
> = View.Component(function*(props) {
  const labels = yield* Labels
  const Self = yield* View.use(Tree)
  const label = yield* labels.find(props.node.id) // fails with LabelNotFound
  const children = props.node.children.map((c) => <Self key={c.id} node={c} />)
  return <li>{label}<ul>{children}</ul></li>
})
```

`use` does not keep the type parameters of a generic component. Pass an
instantiation expression: `View.use(Rows<number>)`.

JSX checks a generic tag with its type parameters erased, since the check
cannot see the instantiation. A tag whose typed errors or services come
from a type parameter is therefore rejected, even where they would be
`never`. Bring such a component in with `use` and an instantiation, which
records what it fails with and needs:

```tsx
const Await = <A, E, R>(props: {
  readonly effect: Effect.Effect<A, E, R>
  readonly children: (value: A) => View.Child
}) => Effect.map(props.effect, props.children)

const Profile = View.Component(function*(props: { readonly id: string }) {
  const users = yield* Users
  const AwaitUser = yield* View.use(Await<User, UserNotFound, never>)
  return <AwaitUser effect={users.find(props.id)}>{(u) => <h1>{u.name}</h1>}</AwaitUser>
})
```

`<Await effect={Effect.succeed(1)}>` is rejected too: use
`View.use(Await<number, never, never>)`. A generic component that only uses
`View.State` and the other `View` helpers is accepted as a tag.

The accounting follows `use`. A component obtained with `use` and then
stored elsewhere, in state or a service, or rendered by another root,
escapes the accounting of the parent that used it. `as any` casts also get
through, and so does a service key made for the `View.Subtree` type
itself: `Effect.provideService` with it removes the `Subtree`, which
amounts to a cast. An overloaded component is checked against one of its
overloads only, so give a component with services or typed errors a
single signature. Handler errors and defects are not typed.

### Services for a subtree

`View.provide` provides a layer to a component and every component it
renders. At the root, it gives each tab its own services:

```tsx
type Items = ReadonlyArray<string>

class Cart extends Context.Service<Cart, View.SharedState<Items>>()("app/Cart") {
  static readonly layer = Layer.effect(Cart, View.SharedState<Items>([]))
}

// Every component in App's tree that needs Cart gets this tab's cart.
const Shop = View.provide(App, Cart.layer)
const Routes = Server.mount("/", Shop)
```

The layer is built on the component's first render, in its instance
scope, and released when the component leaves the page or the session
closes, after the components below it. Later renders reuse it. Each
instance builds its own copy, even of a layer that the application or an
enclosing `View.provide` has already built. At the root, the HTTP render
and the live session each build it, so it is built twice per page load;
see [component lifetime](#component-lifetime-and-rendering-helpers). A
service that depends on the request, such as the current user, comes from
router middleware instead; see [what a root accepts](#what-a-root-accepts).

The layer is built outside the component instance, so a layer that uses
`View.State`, `View.watch` or `View.once` is a type error. Keep its state
in a `View.SharedState`, as `Cart` does.

The result no longer needs what the layer provides, in its body or its
`Subtree`. What the layer requires, and its error, are added to the
`Subtree`. A layer that fails to build fails the render, up to the next
boundary. The failure is kept: the layer is built again only when the
component remounts.

`View.provide` is a render boundary, like [`View.catchTag`](#typed-errors):
it is the instance of the component it wraps, at the same path. It also
takes the layer alone, for `pipe`: `App.pipe(View.provide(Cart.layer))`.
Define it at module level: created in a body, it remounts and builds its
layer again on every render, and the renderer logs a warning.

**Never `Effect.provide(layer)` a component**, as in
`Effect.provide(Members(props), layer)`. The layer would cover the body
alone: it would be built on every render and released as soon as the body
returns, before the handlers that captured its services run. The children
render after the body, so they would not get the services, and the
`Subtree` keeps requiring them.

### Component lifetime and rendering helpers

| API | Purpose |
| --- | --- |
| `View.once(effect)` | Run an Effect once per component instance in its scope, returning the same result on later renders. |
| `View.connected` | Read whether this is a live WebSocket session (`true`) or the initial HTTP render (`false`). |
| `View.provide(Component, layer)` | Provide a layer to a component and its subtree, built once per instance; see [services for a subtree](#services-for-a-subtree). |
| `View.ErrorBoundary` | Render a fallback when a child fails to render; see [errors and reconnects](#errors-and-reconnects). |
| `View.render(jsx)` | Render to an HTML string in a temporary, disconnected session. Useful in tests; it does not start a live connection. |
| `View.render(Component, props)` | Render a component the same way. The Effect fails with the tree's typed errors and needs its services. |
| `View.raw(html)` | Emit trusted HTML verbatim, without escaping. |
| `View.Fragment` / `<>…</>` | Group children without an extra HTML element. |
| `View.Instance` | Access the renderer-provided instance service and its scope. Usually the helpers above are sufficient. |

The HTTP request and the WebSocket create separate component instances.
Initialization therefore happens twice per page load. Start live-only work
using `View.connected`, and scope it with `View.once`:

```ts
if (yield* View.connected) {
  yield* View.once(Effect.forkScoped(ticker))
}
```

`connected` stays constant for the lifetime of an instance, so this branch
keeps slot order stable. The ticker ends when the component leaves the tree
or the session closes. `once` applies to one instance, not to the whole
application or to subsequent reconnects.

### Atoms

Components can watch Effect atoms, from `effect/unstable/reactivity`, as
they watch state. The integration is experimental: that module is unstable
and may change in any Effect release.

```tsx
import { Atom, AtomRegistry } from "effect/unstable/reactivity"

const count = Atom.make(0).pipe(Atom.keepAlive)
const doubled = Atom.map(count, (n) => n * 2)

const Doubled = View.Component(function*() {
  const registry = yield* AtomRegistry.AtomRegistry
  const n = yield* View.watch(doubled)
  return <button onClick={() => registry.update(count, (x) => x + 1)}>{n}</button>
})
```

| API | Purpose |
| --- | --- |
| `View.watch(atom)` | Read an atom and re-render when it changes. An async atom gives its `AsyncResult`. |
| `View.result(atom, options?)` | Wait for the value of an async atom. Its typed error becomes the component's. |

A `watch` or `result` of an atom is a slot like any other. It follows a
new atom at the same position, such as `Atom.family(props.id)` with a new
id, and a new registry.

Atoms live in the `AtomRegistry` service, so a component that watches one
needs `AtomRegistry`, and its parent brings it in with `View.use`. Provide
`AtomRegistry.layer` once: next to the server layer, for one registry per
process, or in the `Cloudflare.app` layer, for one per Durable Object.
Every session shares the atoms of its registry. Build the registry with a
layer, not at module scope, so that it is disposed with the application.

`View.provide(App, AtomRegistry.layer)` gives each session a registry of
its own instead. The HTTP render and the live session of a tab are
separate sessions with separate registries, so the live session starts
its atoms again, whatever their TTL.

| Atom | Use | Lifetime |
| --- | --- | --- |
| `Atom.make(value).pipe(Atom.keepAlive)` | Application state | As long as the registry. |
| A plain or derived atom | Derived values | Freed a tick after its last watcher leaves. A writable one loses its value. |
| An atom with `Atom.setIdleTTL(duration)`, or any atom in a registry from `AtomRegistry.layerOptions({ defaultIdleTTL })` | Async data, families | Kept for the TTL after its last watcher leaves. With a shared registry, other tabs and the live session reuse its value. |
| `Atom.runtime(layer).pipe(Atom.keepAlive)` | Services for effectful atoms | Its layer is built once per registry, apart from the application's layers. |

With a shared registry, the HTTP render and the live session watch the
same atoms. The HTTP render's instances close once the document is
rendered, so an async atom without an idle TTL is freed and its Effect
interrupted; the live session runs it again. With an idle TTL, the live
session finds it running or done.
`AtomRegistry.layerOptions({ defaultIdleTTL: 5_000 })` gives every atom
one; the library sets no default.

An atom built from an Effect gives an `AsyncResult`. An Effect that
completes synchronously is a `Success` in the same render. Otherwise the
render shows `Initial`, and the session renders again when the value
arrives. Render each state with `AsyncResult.builder`, whose `exhaustive()`
only type-checks once every typed error, defects and interruptions are
handled:

```tsx
const runtime = Atom.runtime(Titles.layer).pipe(Atom.keepAlive)
const title = Atom.family((id: string) =>
  runtime.atom(Effect.gen(function*() {
    const titles = yield* Titles
    return yield* titles.find(id) // fails with NotFound
  })).pipe(Atom.setIdleTTL("30 seconds"))
)

const Title = View.Component(function*(props: { readonly id: string }) {
  const result = yield* View.watch(title(props.id))
  return AsyncResult.builder(result)
    .onInitial(() => <p>Loading…</p>)
    .onErrorTag("NotFound", (error) => <p>No title for {error.id}</p>)
    .onDefect(() => <p>Could not load the title.</p>)
    .onInterrupt(() => <p>Stopped.</p>)
    .onSuccess((value) => <h1>{value}</h1>)
    .exhaustive()
})
```

Here `Titles` stands for an application service whose `find` fails with
`NotFound`. `View.result` waits instead. The render waits while the atom
is `Initial`, and with `{ suspendOnWaiting: true }` while it refreshes.
The atom's typed error becomes the component's, handled with
[`View.catchTag`](#typed-errors) like any other. The whole session render
waits with it, and so does the HTTP response. Events that arrive during
the first live render wait for it to end; during later renders they are
handled meanwhile. Use it for fast data, or for data the first page must
contain.

The [search example](./examples/atom-search/App.tsx) combines these: the
query is `View.State`, local to each tab, and the results are a family of
atoms with an idle TTL, so two tabs searching for the same text share one
call to the backend.

Handlers write through the registry taken in the body.
`registry.set(atom, value)` and `registry.update(atom, f)` return nothing,
so a handler calls them directly. `Atom.set` is an Effect that needs
`AtomRegistry`, which a handler cannot require, so it is a type error. A
write notifies the watchers synchronously, inside the writer's call, which
may be another session's handler. Each listener only marks its component
dirty and wakes its session. A write that lands while that session renders
leaves the component dirty for the next render.

`Atom.fn` in a shared registry is one action for every tab: a call from a
second tab interrupts the first. Run an action that belongs to one tab as
an Effect in its handler, and keep its status in `View.State`.

The Effects of atoms run on fibers of the registry. They do not see the
session's services, logger or tracer; an effectful atom gets its services
from `Atom.runtime`. Closing a session only unsubscribes its components.
When that was an atom's last watcher, the atom follows its lifetime from
the table above. A plain one is freed a tick later, and its Effect
interrupted. One with an idle TTL keeps running, and is interrupted only
if it is still running when the TTL expires, rounded up to the registry's
timeout resolution (1 second by default). A `keepAlive` one is kept, and
its Effect is interrupted only when the registry is disposed.

Pitfalls:

- Define atoms at module level, or take them from an `Atom.family`. An
  atom created in a body is a new atom on every render. The watch follows
  it, so a writable one goes back to its initial value, and an async one
  runs its Effect again and renders again, in a loop.
- A derived atom's `read` must not throw. It runs inside the writer's
  `set`, possibly in another session's handler.
- Do not write atoms or state in a component body. The write renders the
  component again, which writes again, in a loop.
- A family of `keepAlive` atoms keeps every member it creates, so it grows
  without bound. Give a family an idle TTL instead.
- `View.result` has no timeout.

### Client-side islands and hooks

Import `Island` from `effect-lsc/island` to let a browser renderer own part
of the page:

```tsx
<Island name="Chart" props={{ values }}>
  <p>Loading chart…</p>
</Island>
```

`props` must be JSON-serializable. Optional `tag` and `class` configure the
container. Children provide initial content until the renderer takes over.
Register the renderer in a script in the page layout:

```js
window.lsc.island("Chart", {
  mount(element, props) {
    const chart = createChart(element, props)
    return {
      update(nextProps) { chart.update(nextProps) },
      unmount() { chart.destroy() }
    }
  }
})
```

`createChart` represents your chosen client library. The runtime calls
`mount` when the island appears, `update` when its props change, and
`unmount` when it leaves. It preserves the island's owned DOM during server
updates. See the [React example](./examples/react-island/index.tsx) for a
complete integration.

For direct DOM integration, `data-lsc-ignore` marks a subtree the runtime
must leave alone. `data-lsc-hook="name"` attaches callbacks registered with
`window.lsc.hook(name, { mounted, updated, destroyed })`.

## Platform integration

### HTTP and WebSocket servers

Import `Server` from `effect-lsc/server`:

| API | Purpose |
| --- | --- |
| `Server.mount(path, Component, options?)` | Register an HTTP page and WebSocket upgrade at the same path on an Effect `HttpRouter`. Returns a Layer. |
| `Server.page(Component, options?)` | Render a full document with the browser runtime inlined. Returns an Effect producing a string. |
| `Server.session(Component, socket, options?)` | Run the live session over an Effect `Socket` until it closes. Its option is `debug`. |

`page` and `mount` accept these document options; `mount` also uses the
origin and debug settings for the live connection:

| Option | Behavior |
| --- | --- |
| `title` | Document title with the default layout. |
| `layout(content)` | Return an `<html>` document containing `content`, which includes the live root and runtime script. The layout renders once per page load and is not live. |
| `origins` | Allow a list of origins or use a predicate. By default the upgrade's `Origin` URL host must match `Host`. Requests without an `Origin` header are allowed. |
| `debug` | Send detailed failure causes to the browser. Defaults to generic error messages. |

Origin checks do not authenticate users. Applications must provide their
own authentication and authorization.

On Bun, provide `BunHttpServer.layer` as shown in the README. For Node,
provide `NodeHttpServer.layer` instead:

```ts
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"

// App is the Layer returned by Server.mount, with application services provided.
HttpRouter.serve(App).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
  Layer.launch,
  NodeRuntime.runMain
)
```

### Cloudflare

`Cloudflare.app(Component, { layer, ...options })`, from
`effect-lsc/cloudflare`, returns an object with `fetch(request)` and
`dispose()`. It accepts the same options as `Server.mount`, plus the
application layer. Forward the Durable Object's `fetch` to this adapter.

The layer is built once per Durable Object. Tabs routed to the same object
therefore share its services; routing to different objects separates them.
It is built on the first request. A layer that fails to build is logged as
such, and every request to the object gets HTTP 500. The Worker must send
both HTTP requests and WebSocket upgrades to the intended object. Complete
configurations are in
[shared-counter-cloudflare](./examples/shared-counter-cloudflare/README.md)
and [todomvc-cloudflare](./examples/todomvc-cloudflare/README.md).

The adapter uses `WebSocketPair` and the classic `accept()` API. Sessions
live in memory and keep the object awake while sockets are open; WebSocket
hibernation and automatic state persistence are not implemented.
`dispose()` releases the application's managed Effect runtime.

### What a root accepts

`Server.mount`, `Server.page`, `Server.session` and `Cloudflare.app` take a
`Server.Root<E, R>`: a component without props whose whole tree, the body
and its `Subtree`, has no typed error left and does not require `Scope`.
Otherwise the call is a type error that names the problem:

| Mistake | The type error contains |
| --- | --- |
| A typed error left in the tree | `"effect-lsc: unhandled errors": UserNotFound` |
| A component that requires `Scope` | `"effect-lsc: this component requires Scope; acquire resources with View.once"` |
| A `Cloudflare.app` layer that lacks a service | `"effect-lsc: missing services": Users` |

Handle typed errors with `View.catchTag`, `View.catchTags` or `View.orDie`;
see [typed errors](#typed-errors). A typed error that still reaches the
root at runtime got past the types, through a cast such as `as any` or a
component from `View.use` rendered elsewhere; see
[services and typed errors](#services-and-typed-errors-across-components).
The server logs the render failure with a hint.

The root requires every service the tree uses, except those
`View.provide` provides to a subtree. `Server.page` and `Server.session`
return Effects that require them. `Server.mount` returns a Layer that
requires them from the router, like any route, so a service that no layer
provides is reported where the application is launched, at the
`Layer.launch` step, not at `mount`. `Cloudflare.app` checks its `layer`
against the tree instead and names the services it lacks. That layer may
not have requirements of its own.

A service that depends on the request, such as the current user, comes
from an `HttpRouter` middleware. The middleware runs for the HTTP render
and for the WebSocket upgrade, so the live session keeps the value
resolved when it connected:

```ts
class CurrentUser extends Context.Service<CurrentUser, {
  readonly name: string
}>()("app/CurrentUser") {}

const Authentication = HttpRouter.middleware<{ provides: CurrentUser }>()(
  Effect.succeed((handler) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.provideService(handler, CurrentUser, {
        name: request.cookies["user"] ?? "guest"
      })
    )
  )
)

// Routes no longer requires CurrentUser: the middleware provides it to App's tree.
const Routes = Server.mount("/", App).pipe(Layer.provide(Authentication.layer))
```

The cookie stands in for real authentication. A service for each session
rather than each request is provided at the root with `View.provide`; see
[services for a subtree](#services-for-a-subtree).

## Errors and reconnects

An event handler changing state and a component rendering that state are
separate steps. A failure in each step has a different outcome:

| What fails | What happens to the page | What happens to state |
| --- | --- | --- |
| An event handler | The server logs the error and notifies the browser. The session continues accepting events. | Existing state stays, including changes made before the failure. |
| A component inside `View.ErrorBoundary` | The boundary shows its fallback; the rest of the page remains live. | The session stays alive. The boundary retries when its subtree is invalidated. |
| A component with a typed error handled by `View.catchTag` or `View.catchTags` | The handler's output renders in its place; the rest of the page remains live. | The same as with `View.ErrorBoundary`. |
| A live render without a boundary to catch it | The server reports the error and closes the socket with code 1011. The browser tries to reconnect. | Reconnecting creates fresh component-local state. |
| The initial HTTP render | The server adapter returns HTTP 500. | No live session has started. |

For example, if a Save handler updates local state and then a database
write fails, the local update is **not rolled back**. Handle expected errors
in the application and decide when to publish the state change. An update
or `modify` on one shared state serializes that operation; it does not make
several state writes or external effects a transaction.

Use a boundary to keep a failing part of the UI from ending the session:

```tsx
<View.ErrorBoundary fallback={() => <p>Could not load the chart.</p>}>
  <Chart />
</View.ErrorBoundary>
```

`View.ErrorBoundary` is for defects: thrown exceptions, components wrapped
in `View.orDie`, and interruptions. Handle typed errors where the component
is defined; see [typed errors](#typed-errors).

Boundaries catch rendering failures, not event handler failures. They retry
on subtree changes; they do not poll or automatically fix the error. A
fallback removes the event handlers of the failed subtree. Components the
failed render reached, including the one that failed, keep their instances
and state for the retry. Components it did not reach, such as siblings after
the failing one, are closed and lose their state. The fallback has paths
of its own, so a component in it, such as `fallback={() => <Retry />}`,
does not replace `<Chart />`. It is closed when a retry succeeds.

When a socket closes, its session scope closes too. The running handler
and render are interrupted first. Then the instances close, and their
tasks, subscriptions, `View.once` resources and `View.provide` layers are
released, so a handler never resumes on a released resource. A reconnect
always starts a new session. Shared services outside that session can
retain state, but restarting their server process or Durable Object loses
in-memory data.

The browser exposes these signals for application UI and diagnostics:

- `data-lsc-disconnected` on the live root while disconnected.
- `data-lsc-error="handler"` or `"render"` after a server error, cleared on
  the next render.
- An `lsc:error` event on `window` with `{ scope, message }` in its detail.
  Messages include the failure cause only with `debug: true`.

These signals do not display an error banner by themselves. The application
can use them to show connection status or an error message.

### Typed errors

`Effect.catchTag` around a component covers its body, not its children.
Typed render errors are handled by a render boundary instead, applied where
the component is defined:

```tsx
const Member = View.Component(function*(props: { readonly id: string }) {
  const users = yield* Users
  const user = yield* users.find(props.id) // fails with UserNotFound
  return <li>{user.name}</li>
}).pipe(View.catchTag("UserNotFound", (_, props) => <li>Unknown user {props.id}</li>))
```

| API | Purpose |
| --- | --- |
| `View.catchTag(tag, f)` | Render `f(error, props)` when the component or its subtree fails with a typed error with this tag. `tag` may be an array of tags. |
| `View.catchTags({ Tag: f, ... })` | The same for several tags, one handler per tag. An unknown tag is a type error. |
| `View.orDie` | Turn every typed error of the component and its subtree into a defect, for `View.ErrorBoundary`. The rest of the cause is kept. |

`View.Component` returns a component with a `pipe` method. Each helper also
takes the component first: `View.catchTag(Member, "UserNotFound", f)`.
Effect combinators such as `Effect.orDie` do not apply, since a component
is a function, not an Effect.

The result no longer fails with the handled errors. Its other errors and
its services move to its `Subtree`, so the parent brings it in with
`View.use`; with neither left, it is a closed component. These helpers are
the only way to remove errors from a `Subtree`, and a root accepts a tree
only when none is left; see [what a root accepts](#what-a-root-accepts).

Like `Effect.catchTag`, a boundary handles the first typed failure of the
cause. Other failures, defects included, pass to the next boundary up. A
handler may return an Effect: its errors and services are added to the
result's type, and a failing handler passes its failure on. Also like
`Effect.catchTag`, a tag given through a variable typed as a union, such
as `tag: "NotFound" | "Denied"`, removes every member of the union from
the type, while only the tag it holds is handled.

Handlers run outside the component instance, so `View.State`, `View.watch`
and `View.once` in a handler are type errors. Return a component that uses
them, such as `() => <Retry />`, instead. Return another boundary as a tag
too, as in `(_, props) => <Fallback {...props} />`: the call
`Fallback(props)` is rejected with the same message.

The boundary is the instance of the component it wraps, at the same path;
in a chain of helpers, each further one adds a level. Like
`View.ErrorBoundary`, it retries when its subtree changes, and the
components the failed render reached keep their state. The handler's
output renders under paths of its own, as a fallback does. Called as a
function, `yield* Member(props)`, it returns a node of itself, so the
boundary still applies.

**Define boundaries at module level.** Applied in a body, as in
`View.use(View.orDie(Item))`, the helper creates a new component on every
render. The renderer then remounts it each time, losing its state, and logs
a warning.

## How it works

### From a page request to an update

1. An HTTP request renders the component with temporary state and returns
   the document and browser runtime. The temporary scope is then closed.
2. The runtime opens a WebSocket at the page's path. The server creates a
   new session, renders again, and sends the initial render tree.
3. A browser event sends its type, handler ID and input values. The handler
   function itself stays on the server.
4. The session looks up the handler and runs its Effect. State writes mark
   affected components and their ancestors for rendering.
5. The render loop builds the next tree, reusing unchanged components, and
   sends a patch describing differences from the previous tree.
6. The runtime merges that patch and updates the affected DOM elements.

Each session owns component instances, a handler table, the previous render
tree and a dirty queue. The dirty queue holds one pending signal, coalescing
bursts of changes. Event processing and rendering have separate loops, so
this coalescing is not a transaction around a whole handler.

The render loop runs every render of the session, the first one included,
one at a time. A render that waits, in `View.result` for instance, delays
the next one. Changes that arrive meanwhile are rendered after it. Events
that arrive before the first render ends wait for it; later ones are
handled while a render waits.

### Identity and component reuse

Instances are identified by their path in the tree: positional children use
paths such as `r.0.1`, keyed children paths such as `r.0.k42`, and a
boundary's fallback paths such as `r.0.f.0`. The same component type at the
same path, under the same parent component, reuses its instance and state
slots. A component of another type at that path remounts the whole subtree,
even the components below it that keep their type. A component whose parent
changes remounts too. In `q ? <Q /> : <div><C /></div>`, where Q renders
`<C />`, C has the same path in both branches, but it remounts each time
`q` changes and gets the services provided above its new place. Keys must
be unique among siblings.

A state change marks its owner or subscribers and their ancestors dirty.
Ancestors must be revisited because their cached output includes child
nodes. Siblings can keep their existing output. Props are compared shallowly,
so preserve objects for unchanged items:

```ts
todos.map((todo) => todo.id === id ? { ...todo, completed: true } : todo)
```

Recreating every item object defeats this reuse. Newly constructed JSX in
`children` can also cause props to differ.

Re-rendered instances replace their handlers; reused instances keep theirs;
removed instances release their scope and handlers, descendants before
ancestors. They close at the end of the render, so a component that
replaces another renders before the old one's finalizers run. A finalizer
that fails is logged and does not fail the render.
Event IDs are element paths, so an old event resolves against the current
handler at that path. If no handler exists there, the event is ignored.
There is no render-version check that rejects all events from an older
DOM.

A render swaps in its handlers when it ends, failed or not. Until then,
events resolve against the handlers of the previous render, which match
the page the browser has, even while the render waits or yields to other
fibers. The first live render has no previous one, so events that arrive
before it ends wait for it. The swap forgets the handlers of removed
instances first, so an element that takes the path of a removed
instance's element keeps its own handler.

### Render trees and wire patches

The renderer splits JSX into static structure and dynamic slots. Static
structure includes tags and attribute names; slots hold changing text,
values, handlers, nested component nodes and lists. Static structures are
identified by fingerprints and sent once per session. Later messages carry
only changed slots and any newly encountered structures.

The ordinary JSX transform supplies enough structure for this split:
literal siblings and dynamic arrays are represented differently. No custom
template compiler is needed. Components form nested nodes, and dynamic
lists are compared by key. Insertions and removals can be sent without
resending the whole list order; actual reorders include the new order.

### Updating the DOM

The browser retains its own render tree and merges each patch into it.
Nodes that render a single root element receive a browser-side `data-lsc-n`
anchor. The runtime uses these anchors to find the affected elements and
morph them with idiomorph, preserving existing DOM where possible.

Keyed lists can be reconciled directly: move retained elements, create new
ones and remove missing ones. When a suitable anchor is unavailable, such
as for a multi-root item, the runtime falls back to morphing an ancestor.
A single root element per component gives it a useful DOM update boundary.

The runtime preserves active text input values and focus during updates,
honors `autofocus` on inserted elements, and resets forms after live submit.
Hooks and islands receive lifecycle callbacks as elements enter, change or
leave the page.

### Source map

| File | Responsibility |
| --- | --- |
| [view.ts](./src/internal/view.ts) | Public component helpers, local and shared state, subscriptions |
| [atom.ts](./src/internal/atom.ts) | Atom subscriptions; the only module that imports `effect/unstable/reactivity` at runtime |
| [instance.ts](./src/internal/instance.ts) | Instance scopes, slots and invalidation |
| [session.ts](./src/internal/session.ts) | Instance and handler registries, event dispatch |
| [vnode.ts](./src/internal/vnode.ts) | JSX nodes and factory, how boundaries render, recover and wrap their subtree |
| [render.ts](./src/internal/render.ts) | JSX traversal and component reuse |
| [wire.ts](./src/internal/wire.ts) | Render tree representation and diffs |
| [protocol.ts](./src/internal/protocol.ts) | Message schemas and encoding |
| [server.ts](./src/internal/server.ts) | HTTP documents and live session loops |
| [cloudflare.ts](./src/internal/cloudflare.ts) | Durable Object adapter |
| [browser.ts](./src/internal/browser.ts) | Browser event forwarding, patch merging and DOM updates |

Effect supplies scopes and fibers for lifetimes, `SubscriptionRef` and
streams for shared state, queues for event and render scheduling, and
services and layers for application wiring. The browser runtime is bundled
into a committed string so every server adapter can inline it in the page.
