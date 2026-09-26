# Roadmap and open questions

This file tracks proposed work, not supported APIs. The current design and
behavior are documented in [ARCHITECTURE.md](./ARCHITECTURE.md); setup and
project status are in the [README](./README.md).

## 1. Session hardening

Keep the current reconnect model: a disconnect ends the session and a
reconnect mounts a fresh one. The next work is to bound resource use and
make connection failures easier to handle:

- **Idle detection:** decide on a heartbeat and timeout that work across
  Bun, Node and Cloudflare.
- **Handler timeouts:** define an optional time limit and report expiry as
  a handler failure. The default and configuration API remain open.
- **Payload limits:** reject oversized messages before decoding them, with
  a consistent library limit across platforms.
- **Session limits:** cap live sessions per process or Durable Object and
  refuse new upgrades when full.
- **Backpressure:** bound memory used by a slow client and define when to
  disconnect it. Patches depend on the previous tree, so dropping an
  arbitrary intermediate patch would require resynchronization.
- **Stale events:** decide whether events should include a render version.
  Today a path resolves to its current handler, or is ignored if absent.
- **Reconnect UI:** decide whether retries should eventually stop and
  expose a terminal state. The runtime currently retries with backoff.

Each behavior needs fault tests for its observable result and cleanup.

## 2. Stress and leak tests

Exercise 100, 500 and 1000 sessions before adding navigation. Include
simultaneous tickers, bursts of events and repeated connect/disconnect
cycles. Measure latency and memory after scopes close and garbage
collection runs. A raw-socket driver under `scripts/` would make these
workloads repeatable. Include sessions watching atoms, and measure whether
the atom registry needs a `scheduleTask` other than its default.

## 3. UI primitives

Candidates: form serialization on change, keyboard filters, event debounce
and throttle, and live title/head updates. These should address concrete
example needs without adding application-specific browser code to the core.

## 4. Navigation

Keep routing outside the core where possible. Explore the minimum session
hooks a separate router would need: URL and history access, handling URL
parameter changes and server-initiated navigation.

## Further design questions

### Session services and derived state

Session services are settled. A service that depends on the request, such
as the current user, comes from `HttpRouter` middleware, which runs for the
HTTP render and for the WebSocket upgrade. A service for one session, or
one subtree, comes from `View.provide`: its layer is built once per
instance and released with it. A layer that fails to build stays failed
until the component remounts; whether to retry it on a later render is
open.

Derived values use ordinary computation inside a component, or derived
Effect atoms; see [atoms](./ARCHITECTURE.md#atoms).

### Typed errors and `View.use`

- **`View.catch` and `View.catchCause`:** boundaries for every typed error
  of a subtree, or for its whole cause. `View.catchTags`, `View.orDie` and
  `View.ErrorBoundary` cover these cases for now.
- **`yield*` on a component:** `const Row = yield* Member` could stand for
  `yield* View.use(Member)`. Components would have to be iterable, and a
  plain function returning an Effect is not, so `View.use` would remain for
  those.
- **Typed handler errors:** handlers must handle theirs. Tracking them in
  the type would need handlers declared in the component body, as
  `View.use` does for components. Left for when a real case needs it.

### Atoms

The atom integration leaves these open:

- **Shared services:** `Atom.runtime(layer)` builds its own instances of
  services the application has already built. `Atom.context({ memoMap })`
  with the application's memo map could share them.
- **Persistence:** `Atom.kvs` on Durable Object storage, so that shared
  atoms survive a restart of their object.
- **Islands:** start browser-side atoms in an island from the server's
  values, with `Hydration` and `Atom.serializable`.
- **Ambient registry:** the renderer could provide a default registry, so
  that a component that only watches atoms needs no `View.use`. Revisit if
  those `use` lines become annoying.
- **`AtomRef`:** `View.watch` does not accept one. Atoms and
  `SubscriptionRef` cover its uses for now.
- **Synchronous listeners for `SharedState`:** a watch of a `SharedState`
  runs a fiber that follows its changes. A synchronous listener, as atoms
  use, would need no fiber.
- **A redundant render after `View.result`:** the value that ends the wait
  also notifies the waiting component, so the session renders it once
  more for nothing. Muting the slot's listener while it waits would avoid
  that.

### Serializable state

An Elm-style model with state as one value and events as data could support
session recovery, replay and Cloudflare WebSocket hibernation. A local
`View.State<Model>` and a dispatch helper can explore this without adding a
new public API. Serializing the model alone would not recover the complete
session: subscriptions, component identity and the browser's render tree
also need a recovery strategy.

### Islands

Islands currently receive server props and keep their own DOM and client
state. There is no dedicated island-to-server event API; communication
currently relies on DOM events on elements with server handlers. Decide
whether a direct dispatch API is needed and how it should validate events.

### Other experiments

- Explicit keys for state slots as an alternative to call-order identity.
- Batching state writes during handlers beyond the existing dirty queue.
- Streaming the initial HTTP render for components that perform slow work.
