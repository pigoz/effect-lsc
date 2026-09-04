# Design notes

Working notes on the effect-lsc MVP: what was built, why, and what is left
open. Read alongside the source, which is small (`src/internal`, about 1000 lines including the browser runtime).

## The primitive

The primitive is a **session**: one live page over one WebSocket, owning

- a tree of component **instances**, keyed by tree path
- a **handler table** rebuilt on every render, keyed by element path
- a **dirty signal**, a `Queue.sliding(1)`

and two loops: take dirty → render → push HTML; take event → run handler.
Everything else is derived from this.

A component is `(props) => JSX | Effect<JSX>`. `View.Component` is only
`Effect.fnUntraced` with a nicer name. A component body re-runs on every
render, and reads state synchronously (`count.value`), so derived state is
plain computation and there is no dependency tracking at all. That is the
LiveView trade: rendering is cheap on the server, so re-render everything
and let the browser diff.

## Decisions

**Path-based identity.** Both instances and handlers are identified by the
node's path in the tree (`r.0.1`, `r.0.k42` for keys). It is stable across
renders, it needs no counters, and a stale event from an old DOM resolves to
the current handler at that position, which is what a user expects when
they click "the second button". Cost: keys must be unique among siblings,
and the same component type at the same path is the same instance.

**Slots in call order.** `View.State` and `View.watch` take the next slot of
the instance on each render. This is the hooks contract (unconditional
calls, same order). The alternative, explicit keys (`View.State("count",
0)`), is more honest but noisier; the MVP keeps the requested API and
documents the rule.

**All state is a `SubscriptionRef`.** Local state and shared state are the
same thing; the only difference is who owns the ref. An instance subscribes
to the ref's `changes` stream (in its own scope, dropping the replayed
current value) and offers to the session's dirty queue. So `View.watch` on a
service-owned ref gives cross-session updates for free: TodoMVC in two tabs
stays in sync with no extra code.

**Handlers take no services.** `Handler<E>` returns
`Effect<unknown, unknown, never>`. Services are acquired in the component
body (`const todos = yield* Todos`) and closed over. This keeps the root
component's requirements in its type, which `Server.mount` turns into the
`Layer`'s requirements, so forgetting `Layer.provide(Todos.layer)` is a
compile error. Nested components are not tracked at the type level (JSX
erases them): their services must be provided at the server too, and a
missing one fails at render time.

**Dead render, then live render.** `GET` renders with a fresh session and
throws it away; the WebSocket starts another fresh session. Initial state
computations run twice, and a component that reads the request could see two
different contexts. LiveView has the same shape (`connected?/1`); a
`View.connected` flag or a mount-once hook would be the fix.

**Slot-level patches, idiomorph on the client.** A render is a tree of
statics and slots (`wire.ts`); the session keeps the tree the browser has and
sends only changed slots, statics once per fingerprint, lists diffed by
`key`, components as nested nodes. The browser merges the patch into its
copy of the tree, regenerates the HTML and morphs it into the page with
idiomorph (vendored as a string by `scripts/vendor-idiomorph.ts`, no asset
pipeline). `ignoreActiveValue` keeps the value of the input being typed
into, `restoreFocus` survives moves, `autofocus` is honoured on inserted
nodes, and a live `submit` resets the form the way a native submit would.
The morph is still whole-root: patches are small on the wire, but the DOM
walk covers the page. Morphing only the subtrees a patch touched is the
next step, and needs a DOM anchor per component (`data-lsc-i`), which the
paths already provide.

**No compiler, no bundler.** `jsxImportSource: "effect-lsc"` is the entire
integration; Bun honours it through `tsconfig` `paths` even inside this repo.
The browser runtime is a string constant so that it needs no asset pipeline
in any runtime; it is generic and does not change per application.

**Handler errors are logged, not fatal.** A failing handler or render logs
its `Cause` and the session continues. A crashed process in LiveView would
re-mount; here the session simply keeps its state. Worth revisiting once
there is an error boundary story.

## Known limitations

- Reconnecting starts a new session: state is lost. LiveView has the same
  default; recovery needs serializable state (see Elm below).
- One handler at a time per session, in order. A slow handler delays the
  next event. Concurrency per handler is easy (a `FiberSet`), but ordering
  is the safer default.
- The WebSocket does no origin check. Same-origin is assumed; production use
  needs `Origin` validation and a session/auth story at `Server.mount`.
- Rendering the layout also goes through the renderer, with a throwaway
  session, so a layout is never live.
- Shutdown: Bun's graceful `server.stop()` waits for open WebSockets, and
  `BunHttpServer` waits for it (20 s by default) before interrupting the
  fibers that own them. The examples use `disablePreemptiveShutdown: true`
  (interrupt first, then stop: 30 ms), which needs Bun 1.4.1+; on 1.3.x that
  stop never resolves. The proper fix belongs in `@effect/platform-bun`:
  interrupt fibers owning upgraded sockets before waiting.
- Attribute typing covers common elements; unknown attributes on known
  elements are compile errors, by design.

## Open questions

### Islands

`<Island>` would mark a subtree that another client renderer owns. The
current design leaves room for it: the renderer already emits a stable path
per node, and the morph could be told to skip a subtree (`data-lsc-island`)
and hand its serialized props to a client hydrator. What the server would
need: a way to render the island's initial HTML (or a placeholder) and to
forward events from inside the island (or not). Nothing in the session
model changes.

### Shared application state

What TodoMVC taught:

- A `Context.Service` holding a `SubscriptionRef` plus operations, provided
  with a `Layer`, is a perfectly good shared store. `View.watch` connects a
  component to it, and the store's fan-out (`PubSub` under the ref) gives
  multi-session updates without a message bus.
- Derived state did not need anything: it is computed in the body.
- Passing a `View.State` handle down as a prop (`filter` into `Footer`)
  works for parent-owned state without a context mechanism.

Directions that seem worth exploring next, in order of cost:

1. **Scoped services**: per-session services (`Layer` built when the socket
   opens, closed with the session) for things like the current user. This is
   just `Layer.build` into the session scope.
2. **Derived refs**: `View.watch` on a `Stream`, or a small `derive(refs, f)`
   producing a read-only `SubscriptionRef`, for expensive derivations that
   should not re-run on every render.
3. **Atom graph**: Effect v4 now ships `effect/unstable/reactivity` (`Atom`,
   `AtomRegistry`, `Reactivity`). A registry per session with
   `View.watch(atom)` bridging `Atom.toStream` into the dirty signal would
   give dependency-tracked derived state without changing the session model.
   Not needed for TodoMVC; adopt when derived state gets expensive.

### Elm-style architecture

`State + Event + update + view` maps cleanly onto the session:

```ts
View.Elm({ init, update: (state, event) => Effect<State>, view: (state, dispatch) => JSX })
```

Handlers would become `() => dispatch(Event)`, and `update` would be the one
place state changes. Advantages: state is one serializable value, so
reconnection recovery and time-travel debugging become possible; events are
data, so they can be validated with `Schema` and logged. It coexists with
`View.State`: a single `View.State<Model>` plus a `dispatch` helper is
already an Elm program. The MVP does not commit; the primitive supports both.

### Fragments, not whole pages

Done: the wire carries slot-level patches (see `wire.ts` and the README).
What the implementation settled:

- children arrays are lists of wrapper nodes keyed by `key` or index, so a
  conditional child (`{cond && <X/>}`) changes only its own slot, and a
  reorder sends only the key order
- components are nested nodes; elements are inlined into their parent's
  statics, so a component is the unit of shape (fingerprint) and of identity
- statics are deduplicated per session by fingerprint, which covers
  repeated list items (LiveView's comprehensions) and any repeated shape
- a shape change costs the nested node in full, once

Measured with a 120-line spike before implementing (bytes on the wire):

| change | full HTML | patch |
|---|---|---|
| counter 0 → 1 | 72 | 27 |
| 20 todos, toggle one | 5363 | 130 |
| 20 todos, rename one | 5331 | 69 |
| 20 todos, append one | 5572 | 416 |
| 0 → 1 todos (shape change) | 614 | 725 |

Still open: morphing only touched subtrees on the client (currently the
whole root is morphed after every patch), and per-instance dirtiness on the
server so that a change deep in the tree does not re-run every component
body. Neither affects the wire format.

Fragment boundaries, instance boundaries and island boundaries are the same
thing, which is the reason to keep paths and instances as the core identity.

### Other

- `View.State` identity by explicit key, to lift the call-order rule.
- Batched handler execution: `Reactivity.withBatch` already exists in Effect
  and could wrap each handler so multiple state writes cause one render.
  (The sliding queue already coalesces, so the gain is small.)
- Streaming the first render (`HttpServerResponse.htmlStream`) once components
  do slow work.
