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

**Slot-level patches, memoized instances, subtree morphs.** A render is a
tree of statics and slots (`wire.ts`); the session keeps the tree the
browser has and sends only changed slots, statics once per fingerprint,
lists diffed by `key`, components as nested nodes. The browser merges the
patch into its copy of the tree and, while merging, records the nodes it
touched (a string slot changed, a node created or patched, a list
reordered). Nodes whose HTML is a single element (`e: 1`, sent with the
statics) are anchored in the DOM with `data-lsc-n="<client path>"`, added
by the runtime when it generates HTML and never sent; for each touched node
the runtime walks up to the nearest anchor present in the DOM (new nodes
have none yet) and morphs that element alone with idiomorph (vendored as a
string by `scripts/vendor-idiomorph.ts`, no asset pipeline). Only when no
anchor exists does it morph the root. `ignoreActiveValue` keeps the value
of the input being typed into, `restoreFocus` survives moves, `autofocus`
is honoured on inserted nodes, and a live `submit` resets the form the way
a native submit would.

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

- the JSX transform already distinguishes a literal list of siblings
  (`jsxs`, or `isStaticChildren` in `jsxDEV`) from dynamic children such
  as `{items.map(…)}` (`jsx`). Static siblings are inlined into the
  parent's statics, exactly like a LiveView template; dynamic arrays become
  lists of nodes keyed by `key` or index, diffed by key
- components are nested nodes, so a component is the unit of shape
  (fingerprint) and of identity, and a conditional component costs only its
  own slot; a conditional *element* among static siblings flips the
  enclosing node's fingerprint instead, so wrap large conditional subtrees
  in a component
- a list carries the fingerprint most of its items share; those items are
  bare arrays of slots and the statics travel once (LiveView's
  comprehensions); items of another shape carry their own fingerprint
- statics are deduplicated per session by fingerprint

Measured on a todo list, bytes on the wire and milliseconds on the server
(toggle one item):

| n | full HTML | first render | patch | render | diff |
|---|---|---|---|---|---|
| 100 | 25 KB | 1.01× | 136 B | 0.4 ms | 0.2 ms |
| 1000 | 255 KB | 1.01× | 137 B | 1.4 ms | 0.3 ms |
| 5000 | 1.29 MB | 1.02× | 138 B | 5.8 ms | 1.8 ms |

Two steps got here. The first encoding wrapped every list item and every
static sibling in its own node, which put the first render at 1.8× the HTML;
inlining static siblings and sharing list statics brought it to the size of
the HTML and the diff to a third. Then memoization: before it, every render
re-ran every component body (12.6 ms for 1000 todos, 42 ms for 5000), which
dominated; now an instance whose state, watched refs, descendants and props
are unchanged returns its previous node, so the toggle re-runs the item and
the app, and the diff skips reused nodes by reference.

**Memoization, precisely.** Invalidation (`View.State` writes, `View.watch`
changes) marks the instance and its ancestor chain dirty, because a parent's
cached node embeds its children's nodes; siblings stay reused. Props are
compared shallowly by identity, so `children` (new VNodes every render)
defeats memoization, and so does rebuilding item objects that did not
change. Handlers live in a session table maintained incrementally: a
re-rendered instance forgets its own keys and registers again, a reused one
keeps them, a disposed one removes them. Instance GC follows the recorded
children of reused instances. The semantic change: a component that reads a
value outside props, state and watched refs no longer picks up changes by
accident, which is the same contract as LiveView's assigns.

Then subtree morphing in the browser, measured by instrumenting
`Idiomorph.morph` in the page: toggling a todo morphs its `<li>` and the
footer, opening the editor morphs the `<li>`.

Then list operations (LiveView's streams, without the developer doing
anything). On the wire, when the keys kept by both renders stay in the same
relative order, a list sends removals (`r`) and insertions with their index
(`a`) instead of the whole key order, which is kept for real reorders. In
the browser, a list whose keys changed is reconciled in place by key: kept
elements are moved, new ones built from their HTML, missing ones removed,
and the container is never morphed; kept elements keep their identity and
state. When a kept item has no anchor (multi-root item) or the list was
empty, it falls back to morphing the nearest anchored ancestor. Measured:
adding a todo morphs only the footer, filtering morphs the two footer links
whose `selected` class changed and nothing else, the first `<li>` keeps a
JS property across adds and filters.

Fragment boundaries, instance boundaries and island boundaries are the same
thing, which is the reason to keep paths and instances as the core identity.

### Other

- `View.State` identity by explicit key, to lift the call-order rule.
- Batched handler execution: `Reactivity.withBatch` already exists in Effect
  and could wrap each handler so multiple state writes cause one render.
  (The sliding queue already coalesces, so the gain is small.)
- Streaming the first render (`HttpServerResponse.htmlStream`) once components
  do slow work.

## Roadmap

What is left, compared with LiveView's client and runtime, in the order
worth doing it. The primitive itself is done and measured; the first block
completes it on the DOM side, the second is framework territory.

### Morph

1. ~~Streams / list operations.~~ Done: removals and insertions by key on
   the wire, in-place reconciliation by key in the browser. A real reorder
   still sends the whole key order (O(n) keys); a move encoding is possible
   if it ever matters.
2. **Ignored regions** (`phx-update="ignore"`): an attribute the morph does
   not touch, so a client library (editor, map, chart) can own a subtree.
   With idiomorph it is a `beforeNodeMorphed` callback returning `false`.
   Prerequisite for islands.
3. **Element lifecycle hooks** (`phx-hook`: mounted, updated, destroyed):
   the hook to start client code on a node. With ignored regions this gives
   minimal islands without any other runtime.
4. **`<title>` and `<head>` updates.** The layout is static today; idiomorph
   has a `head` option, only a channel to send them is missing.

Not needed: `phx-value-*` and `phx-target` exist because Elixir handlers are
event names; closures cover both.

### Runtime

| what | why | cost |
|---|---|---|
| debounce / throttle and key filters (`phx-debounce`, `phx-key`) | every `keydown` is a round trip today; the todo editor sends each letter to look for Enter and Escape | small, an option per handler |
| reconnection with recovery | a reconnect starts a fresh session; LiveView rejoins the same session and recovers forms being filled | medium, needs a session token and a grace period on the server |
| navigation and URL (`live_patch`, pushState, `handle_params`) | no multi-page apps without it; the TodoMVC filter does not survive a reload | medium |
| form serialization on `change` | only the element's value is sent; a multi-field form wants every field | small |
| loading states (`phx-*-loading`, `disable-with`) | feedback during the round trip; `data-lsc-disconnected` exists | small |
| origin check and CSRF on the socket | upgrades are accepted from any origin | small, and needed before exposing anything |
| `connected` flag / single mount | the dead render and the live render run initialisation twice | small |
| file uploads | chunked over the socket in LiveView | large |

Suggested order: streams, ignored regions and hooks (they unlock islands,
one of the three open questions), debounce and key filters, origin check.
Then stop and design navigation and reconnection together: both touch the
session model and should not be bolted on one at a time.
