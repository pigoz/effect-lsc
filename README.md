# effect-lsc

**Effect Live Server Components.** A backend-first UI model in the spirit of
Phoenix LiveView, built on [Effect](https://effect.website) v4 and plain JSX.

- components execute on the server, as Effects
- state lives on the server
- JSX describes the UI; event callbacks stay on the server
- the browser runs one small, generic runtime (about 5 KB of plain JS, inlined)
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
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.launch,
  BunRuntime.runMain
)
```

The page the browser receives contains `<h1>0</h1>`, a button with
`data-lsc-click="r.0.1"`, and the runtime. It does not contain the counter,
its state, or the callback.

## Running the examples

```sh
bun install
bun examples/counter/index.tsx   # http://localhost:3000
bun examples/todomvc/index.tsx   # http://localhost:3000, open it in two tabs
PORT=4000 bun examples/counter/index.tsx
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
| `View.Component(function*(props) { … })` | Defines a component. The body is an Effect generator that runs on every render and returns JSX. Plain functions `(props) => JSX` are components too. |
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
WebSocket /      → new session: render again, push {t:"render", html}
click            → runtime finds data-lsc-click="r.0.1" → {t:"event", type:"click", id:"r.0.1"}
server           → looks up the handler at that path → runs the Effect
state change     → SubscriptionRef change → session marked dirty (sliding queue of 1)
re-render        → full HTML for the page → {t:"render", html}
runtime          → morphs the DOM in place (focus and typed input survive)
```

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

## Development

```sh
bun run check   # tsc
bun run test    # vitest
bun run build   # vite (ESM) + tsc (declarations) into dist/
```

## Status

MVP. Working: server render, live sessions, local state, shared state via
`View.watch`, nested keyed components with their own state, forms, lists,
many event types, cross-session updates. Not yet: islands, keyed DOM
morphing, state recovery on reconnect, session-level authorization. See
NOTES.md.
