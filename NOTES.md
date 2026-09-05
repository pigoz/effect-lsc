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
workloads repeatable.

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

A per-session layer could provide resources such as the current user and
release them with the socket. Shared services already cover application
state; the missing piece is an explicit session-layer API.

Derived values currently use ordinary computation inside a component.
For expensive derivations or external notifications, consider watching a
stream with an initial value, derived refs, or an Effect atom integration.
Choose an approach when an example demonstrates the need.

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
