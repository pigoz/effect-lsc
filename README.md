# effect-lsc

**Effect Live Server Components.** A backend-first UI model in the spirit of
Phoenix LiveView, built on [Effect](https://effect.website) v4 and plain JSX.

- components execute on the server, as Effects
- state lives on the server
- JSX describes the UI; event callbacks stay on the server
- the browser runs one small, generic runtime (17.1 KB inlined, 6.2 KB gzipped),
  including [idiomorph](https://github.com/bigskysoftware/idiomorph) (9.7 KB minified before bundling)
- events travel to the server over a WebSocket and come back as DOM updates
- no React, no compiler plugin, no bundler integration: normal TypeScript JSX
  compilation is enough

This is an MVP whose goal is to find the smallest useful primitive for
LiveView-style applications with Effect.

## A counter

```tsx
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
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

## A shared counter

`View.State` belongs to one component in one browser session. To share a
counter across tabs, create a `View.SharedState` in a service and read it
with `View.watch`. Each change then re-renders every component watching it.

The same application with a shared count:

```tsx
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Context, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"

class Count extends Context.Service<Count, View.SharedState<number>>()("app/Count") {
  static readonly layer = Layer.effect(Count, View.SharedState(0))
}

const Counter = View.Component(function*() {
  const shared = yield* Count
  const total = yield* View.watch(shared)

  return (
    <button onClick={() => shared.update((n) => n + 1)}>
      {total}
    </button>
  )
})

const App = Server.mount("/", Counter, { title: "Shared counter" })

HttpRouter.serve(App).pipe(
  Layer.provide(Count.layer),
  Layer.provide(BunHttpServer.layer({ port: 3000, disablePreemptiveShutdown: true })),
  Layer.launch,
  BunRuntime.runMain
)
```

The service owns the count; the components subscribe to it. In this example,
all tabs connected to the same server process share one counter. See the
[complete example](./examples/shared-counter/index.tsx) for a shared total
alongside a count local to each tab.

## Running the examples

```sh
bun install
bun examples/counter/index.tsx          # per-tab state
bun examples/shared-counter/index.tsx   # one counter shared by every tab
bun examples/todomvc/index.tsx          # shared list, open it in two tabs
bun examples/react-island/index.tsx     # a React chart inside a server-driven page
bun run shared-counter-cloudflare       # shared counter in a Durable Object
bun run todomvc-cloudflare              # shared TodoMVC in a Durable Object
```

The Bun examples listen on port 3000 and require Bun 1.4.1 or later.
The Cloudflare examples run under `wrangler dev` (port 8787 by default).

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

The examples above use Bun. The same components run on Node with
`@effect/platform-node`, or in Cloudflare Durable Objects with
`effect-lsc/cloudflare`; see [platform integration](./ARCHITECTURE.md#platform-integration).

## API & How it works

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the API, session lifecycle,
error handling and rendering protocol.

## Development

```sh
bun run check         # type-check sources, declarations and both Cloudflare examples
bun run test          # unit tests for rendering, state and the wire protocol
bun run test:browser  # Chromium tests, WebSocket protocol tests and local Wrangler tests
bun run test:node     # the same suite with the HTTP fixtures running on Node
bun run build         # ESM and TypeScript declarations into dist/
bun run smoke         # install the packed package and render with Bun and Node
bun run runtime       # regenerate the browser runtime and vendored idiomorph
```

Browser tests use Playwright's Chromium (`bunx playwright install chromium`)
or an installed Google Chrome. They check DOM updates, element identity,
focus, form input, islands and error handling. CI runs the suites with both
Bun and Node.

The browser runtime lives in `src/internal/browser.ts`. After editing it,
run `bun run runtime` to update the committed, minified copy in
`src/internal/runtime.ts`; a test checks that the generated copy is current.

## Status

Experimental MVP, built on Effect v4. The core works on Bun, Node and
Cloudflare: server rendering, live WebSocket sessions, local and shared
state, forms, keyed lists, and client-side islands. Updates use incremental
patches and reuse unchanged components and DOM elements.

The main limitations are:

- **No session recovery.** Reconnecting creates a fresh session and resets
  component-local state. Shared state survives while its owning service
  stays alive; the examples do not persist it to storage.
- **No built-in navigation or user authentication.** Applications provide
  their own routing and access control. WebSocket origin checks are included.
- **Session limits are still to come.** There are no built-in handler
  timeouts, session caps or application-level backpressure controls.
- **No Cloudflare WebSocket hibernation.** Live sessions stay in memory and
  keep their Durable Object awake while connected.

Planned work and unresolved design choices are tracked in [NOTES.md](./NOTES.md).
