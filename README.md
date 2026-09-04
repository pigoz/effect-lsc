# effect-lsc

**Effect Live Server Components.** A backend-first UI model in the spirit of
Phoenix LiveView, built on [Effect](https://effect.website) v4 and plain JSX.

- components execute on the server, as Effects
- state lives on the server
- JSX describes the UI; event callbacks stay on the server
- the browser runs one small, generic runtime (about 13 KB inlined, 9 of which are [idiomorph](https://github.com/bigskysoftware/idiomorph))
- events travel to the server over a WebSocket and come back as DOM updates
- no React, no compiler plugin, no bundler integration: normal TypeScript JSX
  compilation is enough

This is an MVP whose goal is to find the smallest useful primitive for
LiveView-style applications with Effect. See [NOTES.md](./NOTES.md) for the
design, the trade-offs, and the open questions.

## A counter

```tsx
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"

const Counter = View.Component(function*() {
  const count = yield* View.State(0)

  return (
    <main>
      <h1>{count.value}</h1>
      <button onClick={() => count.update((n) => n + 1)}>Increment</button>
    </main>
  )
})

const App = Server.mount("/", Counter, { title: "Counter" })

HttpRouter.serve(App).pipe(
  Layer.provide(BunHttpServer.layer({ port: 3000, disablePreemptiveShutdown: true })),
  Layer.launch,
  BunRuntime.runMain
)
```

The page the browser receives contains `<h1>0</h1>`, a button with
`data-lsc-click="r.0.1"`, and the runtime. It does not contain the counter,
its state, or the callback.

## Running the examples

Requires Bun 1.4.1 or later.

```sh
bun install
bun examples/counter/index.tsx          # per-tab state
bun examples/shared-counter/index.tsx   # one counter shared by every tab
bun examples/todomvc/index.tsx          # shared list, open it in two tabs
PORT=4000 bun examples/counter/index.tsx # all examples listen on PORT, default 3000
```

`View.State` is local to a session (a browser tab). To share state across
tabs, put a `SubscriptionRef` in a service and `View.watch` it, as in
`examples/shared-counter`:

```tsx
class Count extends Context.Service<Count, SubscriptionRef.SubscriptionRef<number>>()("app/Count") {
  static readonly layer = Layer.effect(Count, SubscriptionRef.make(0))
}

const Counter = View.Component(function*() {
  const shared = yield* Count
  const total = yield* View.watch(shared) // re-rendered in every tab on change
  return <button onClick={() => SubscriptionRef.update(shared, (n) => n + 1)}>{total}</button>
})

HttpRouter.serve(Server.mount("/", Counter)).pipe(Layer.provide(Count.layer), …)
```

## Setup in your own project

```sh
bun add effect-lsc effect @effect/platform-bun
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "effect-lsc"
  }
}
```

That is the whole integration: TypeScript, Bun and Vite compile `<div/>` to
`jsx("div", …)` imported from `effect-lsc/jsx-runtime`.

## API

### `effect-lsc/view`

| | |
|---|---|
| `View.Component(function*(props) { … })` | Defines a component. The body is an Effect generator that returns JSX. Plain functions `(props) => JSX` are components too. A component re-runs when its state or a watched ref changes, when a descendant's does, or when it receives different props (shallow comparison); otherwise its previous output is reused. |
| `View.State(initial)` | Component-local state, persisted across renders. `state.value` reads synchronously; `state.set` / `state.update` are Effects. Backed by a `SubscriptionRef`, exposed as `state.ref`. |
| `View.watch(ref)` | Reads any `SubscriptionRef` and re-renders whenever it changes. This is how components depend on shared state, for example a service that every session sees. |
| `View.raw(html)` | Trusted HTML, emitted verbatim. |
| `View.render(jsx)` | Renders once to an HTML string. Handy in tests. |
| `View.Instance` | The service that `State` and `watch` need; the renderer provides it. Its `scope` closes when the component leaves the tree. |

Event handlers receive a small, generic event: `{ type, value?, checked?,
key?, form? }`. A handler may return an Effect, which the session runs, or
nothing. Handlers cannot require services: acquire them in the component
body with `yield*` and close over them, so a page's requirements stay visible
in its type.

Attributes use their HTML names (`class`, `for`). `class` also accepts an
array with falsy entries, and `style` an object.

Because unchanged components are reused, keep prop identities stable: pass
the same object for the same item (as `todos.map(t => t.id === id ? {...t, done} : t)`
does). A component that reads something outside its props must do so
through `View.watch` or `View.State`, not by reading a service value
directly in the body. The same applies to a `View.State` handle received as
a prop: the handle never changes, so read it with `View.watch(handle.ref)`,
as the TodoMVC footer does with the filter.

### `effect-lsc/server`

`Server.mount(path, Component, options?)` returns a `Layer` that registers
the page on an `HttpRouter`:

- `GET path` renders the component once and returns a full document
- a WebSocket upgrade on the same path runs the live session

Options: `title`, or a `layout: (content) => <html>…</html>` function for a
custom document (the layout is static, rendered once per page load).

Services required by the root component must be provided to the router
layer, as in the TodoMVC example (`Layer.provide(Todos.layer)`).

## How it works

```
GET /            → render Component with fresh state → HTML document + runtime
WebSocket /      → new session: render again, send the tree {t:"render", p:{f, s, 0:…}}
click            → runtime finds data-lsc-click="r.0.1" → {t:"event", type:"click", id:"r.0.1"}
server           → looks up the handler at that path → runs the Effect
state change     → SubscriptionRef change → session marked dirty (sliding queue of 1)
re-render        → diff against the tree the browser holds → {t:"render", p:{f, 0:{f, 1:"1"}}}
runtime          → merges the patch, regenerates the touched subtrees, morphs them with idiomorph
```

A render is a tree of nodes: static strings (tags, attribute names,
structure, literal sibling lists) interleaved with slots (text, attribute
values, handler ids, nested nodes, lists). Statics are identified by a
fingerprint and travel once per session; after that only slots whose value
changed are sent. Dynamic arrays (`{items.map(…)}`) are lists diffed by
`key`, so a reorder sends the new key order and nothing else, and items
share their statics. Components are nested nodes, so a conditional component
costs only its own slot. This is LiveView's statics/dynamics split, derived
from the VNode tree at runtime instead of by a template compiler: the
compiled `jsx()`/`jsxs()` calls already expose the structure and tell static
siblings from dynamic children. The first render costs the same bytes as the
HTML; for 1000 todos, toggling one sends 137 bytes instead of 255 KB, and
the server re-runs two component bodies, not a thousand: an instance whose
state, watched refs, descendants and props are unchanged returns the node of
its previous render, and the diff skips it by reference. In the browser,
nodes whose HTML is a single element carry an anchor (`data-lsc-n`, added
by the runtime, never sent), and only the anchored subtrees a patch touched
are morphed: toggling a todo morphs its `<li>` and the footer.

Two tips that follow from this: a component is the unit of memoization and
of morphing, so wrap a dynamic list or a large conditional subtree in a
component of its own, and keep it a single root element.

Every node has a path (`r.0.1`, keyed children `r.0.k42`). Component
instances live at their path, which is what makes `View.State` persist, and
handler ids are element paths, so an event from a DOM that has since been
re-rendered still maps to the current handler at that position.

Effect primitives doing the work: `HttpRouter` and `HttpServerRequest.upgrade`
for HTTP and WebSocket, `Socket` for the connection, `Scope` for instance and
session lifetimes, `SubscriptionRef` and `Stream` for state and change
notification, `Queue.sliding(1)` for render coalescing, `Schema` for the
wire protocol, `Context.Service` and `Layer` for wiring. There is no custom
Promise-based infrastructure.

## Shutdown

The examples pass `disablePreemptiveShutdown: true` to the Bun server layer,
so Ctrl+C exits immediately: live sessions are interrupted first, their
WebSockets close, then the server stops. With the default settings
`BunHttpServer` waits up to 20 seconds for the sockets before interrupting
anything. This needs Bun 1.4.1 or later; on older Bun the stop never
resolves once a socket was upgraded.

## Development

```sh
bun run check   # tsc
bun run test    # vitest
bun run build   # vite (ESM) + tsc (declarations) into dist/
```

## Status

MVP. Working: server render, live sessions with slot-level patches and
memoized components, local state, shared state via `View.watch`, nested
keyed components with their own state, forms, lists, many event types,
cross-session updates. Not yet:
islands, state recovery on reconnect, session-level authorization. See
NOTES.md.
