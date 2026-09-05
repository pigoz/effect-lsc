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

A component runs on its first render, when its state or watched sources
change, when a descendant changes, or when its props differ. Otherwise the
renderer reuses its previous output. Derived values can be computed in the
body, such as `todos.filter((todo) => !todo.completed).length`.

### State

| API | Purpose |
| --- | --- |
| `View.State(initial)` | Create state owned by this component instance. The initial value is used only on its first render. |
| `View.SharedState(initial)` | Create state that multiple components or sessions can share. Put it in a service to give it a lifetime beyond one component. |
| `View.watch(source)` | Read and subscribe to a local state handle, shared state, or Effect `SubscriptionRef`. Changes schedule a render of this component. |

Both state types expose `value` for synchronous reads, `get` for an Effect
read, and `set(value)` / `update(f)` for writes. Writes are Effects: return
them from a handler or execute them with `yield*`.

Shared state also has `modify(f)`, where `f` returns `[result, nextState]`,
and a `changes` stream for consumers outside components. Updates to the
same shared state are serialized, including updates from different sessions.
Sharing does not imply persistence: the state lasts as long as its owner.

**Call `View.State`, `View.watch` and `View.once` in the same order on each
render.** They occupy slots in the component instance. Keep the source
passed to each `watch` stable, since its subscription is established on the
first render. A component's own state is tracked automatically; state from
elsewhere must be watched:

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
`Cloudflare.app` through its `layer` option. Requirements acquired by the
root component appear in its type. JSX does not carry child component
requirements into the parent's type, so services used only by children
must also be provided; a missing service fails when the child renders.

Events run one at a time, in arrival order, within each session. A slow
handler delays later events from that browser. Other sessions can continue
handling their own events.

### Component lifetime and rendering helpers

| API | Purpose |
| --- | --- |
| `View.once(effect)` | Run an Effect once per component instance in its scope, returning the same result on later renders. |
| `View.connected` | Read whether this is a live WebSocket session (`true`) or the initial HTTP render (`false`). |
| `View.ErrorBoundary` | Render a fallback when a child fails to render; see [errors and reconnects](#errors-and-reconnects). |
| `View.render(jsx)` | Render to an HTML string in a temporary, disconnected session. Useful in tests; it does not start a live connection. |
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
The Worker must send both HTTP requests and WebSocket upgrades to the
intended object. Complete configurations are in
[shared-counter-cloudflare](./examples/shared-counter-cloudflare/README.md)
and [todomvc-cloudflare](./examples/todomvc-cloudflare/README.md).

The adapter uses `WebSocketPair` and the classic `accept()` API. Sessions
live in memory and keep the object awake while sockets are open; WebSocket
hibernation and automatic state persistence are not implemented.
`dispose()` releases the application's managed Effect runtime.

## Errors and reconnects

An event handler changing state and a component rendering that state are
separate steps. A failure in each step has a different outcome:

| What fails | What happens to the page | What happens to state |
| --- | --- | --- |
| An event handler | The server logs the error and notifies the browser. The session continues accepting events. | Existing state stays, including changes made before the failure. |
| A component inside `View.ErrorBoundary` | The boundary shows its fallback; the rest of the page remains live. | The session stays alive. The boundary retries when its subtree is invalidated. |
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

Boundaries catch rendering failures, not event handler failures. They retry
on subtree changes; they do not poll or automatically fix the error.

When a socket closes, its session scope closes too: running handlers,
component tasks and subscriptions are interrupted and cleaned up. A
reconnect always starts a new session. Shared services outside that session
can retain state, but restarting their server process or Durable Object
loses in-memory data.

The browser exposes these signals for application UI and diagnostics:

- `data-lsc-disconnected` on the live root while disconnected.
- `data-lsc-error="handler"` or `"render"` after a server error, cleared on
  the next render.
- An `lsc:error` event on `window` with `{ scope, message }` in its detail.
  Messages include the failure cause only with `debug: true`.

These signals do not display an error banner by themselves. The application
can use them to show connection status or an error message.

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

### Identity and component reuse

Instances are identified by their path in the tree: positional children use
paths such as `r.0.1`, keyed children paths such as `r.0.k42`. The same
component type at the same path reuses its instance and state slots. Keys
must be unique among siblings.

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
removed instances release their scope and handlers. Event IDs are element
paths, so an old event resolves against the current handler at that path.
If no handler exists there, the event is ignored. There is no render-version
check that rejects all events from an older DOM.

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
| [instance.ts](./src/internal/instance.ts) | Instance scopes, slots and invalidation |
| [session.ts](./src/internal/session.ts) | Instance and handler registries, event dispatch |
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
