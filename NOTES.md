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

**Local state is a cell, shared state is a `SubscriptionRef`, `watch` is
the bridge.** The first version made every `View.State` a `SubscriptionRef`
with a `Stream` subscription fiber per cell, for uniformity. Measured: 51 µs
per cell, ten times the ref itself, all in the stream pipeline; 1000
components with one state each took 58 ms to render the first time. Local
state knows exactly whom to invalidate, and handlers of a session run one
at a time, so it is now a plain cell with a listener set (the owner
instance, plus any instance that `watch`es the handle): 3.5 µs per cell, 9 ms
for the same page. Setting the identical value is a no-op. Shared state
keeps the `SubscriptionRef`, wrapped in `View.SharedState`: there the
semaphore matters, because handlers of different sessions update it
concurrently, and its `changes` stream is the fan-out that keeps tabs in
sync. `View.watch` accepts both, and a raw `SubscriptionRef` as an escape
hatch; a `Stream` with an initial value is the natural next source
(database notifications, Redis). It is the only place where Effect
reactivity meets the component graph: "this instance observed this source
during its render; when it changes, invalidate it." Effect's
`unstable/reactivity` `AtomRef` has exactly the cell's shape; it can replace
the twenty lines here once it is stable, without changing the API.

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
different contexts. LiveView has the same shape (`connected?/1`), and so do
we: `View.connected` is `false` in the HTTP render and `true` live.

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
in any runtime; it is generic and does not change per application. It is
written readably in `browser.ts` and served from `runtime.ts`, a committed
minified copy produced by `scripts/build-runtime.ts` (Bun's minifier), the
same arrangement as the vendored idiomorph; a test compares the hash of the
source recorded in the copy with the current source, so it cannot go stale
unnoticed. The page-facing surface is `window.lsc` (morph entry point, and
the registries hooks and islands will use).

**Handler errors are logged, not fatal.** A failing handler or render logs
its `Cause` and the session continues. A crashed process in LiveView would
re-mount; here the session simply keeps its state. Worth revisiting once
there is an error boundary story.

## Testing

Three layers. Unit tests (`bun run test`) cover the renderer, the wire
protocol, memoization and, by evaluating the runtime's own merge code, the
browser's side of the protocol: a round trip where the client reproduces the
server HTML after every patch. Browser tests (`bun run test:browser`) run
the real runtime in Chromium against `test/browser/fixtures/app.tsx`, a
page with no network dependency that exercises every behaviour the runtime
must keep, and against the examples. Every bug found by hand has a test at
the layer where it lives: the single-child path collision (unit), a
memoized child reading a `State` prop (unit, and the TodoMVC footer in the
browser), idiomorph's `ignoreActiveValue` skipping a focused button's label
(browser), element identity across list operations (browser). `bun run
check` type-checks the declarations build too, since it has neither DOM nor
Node types and once broke on the `URL` global.

## Known limitations

- Reconnecting starts a new session: state is lost. LiveView has the same
  default; recovery needs serializable state (see Elm below).
- One handler at a time per session, in order. A slow handler delays the
  next event. Concurrency per handler is easy (a `FiberSet`), but ordering
  is the safer default.
- The WebSocket upgrade checks `Origin` against `Host` (or the `origins`
  option). Authentication of the user behind a session is still up to the
  application, for example in a middleware around `Server.mount`.
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

Done, as predicted: nothing in the session model changed. `<Island name
props>` renders a container carrying the name and the props as JSON around
a mount point marked `data-lsc-ignore`, which the morph skips (idiomorph's
`beforeNodeMorphed`) and list reconciliation moves as a whole. The island
node is a component, so it is anchored and memoized like any other; a props
change morphs its container only, and `updated` hands the new props to the
renderer. Islands are a built-in case of element hooks
(`data-lsc-hook`, `lsc.hook(name, { mounted, updated, destroyed })`), whose
lifecycle is driven from the places the runtime already knows nodes enter
and leave: the initial scan, idiomorph's add/morph/remove callbacks, and the
list reconciliation. `examples/react-island` mounts a React chart fed by a
server ticker; React state survives every patch, and hide/show
unmounts and remounts it.

Found while testing it: idiomorph's `ignoreActiveValue` also skips the
children of the focused element, so a clicked button never updated its
label until it lost focus. The runtime now protects only the `value` of
the focused text input, through `beforeAttributeUpdated`.

Not covered yet: events from an island back to the server (an island can
only talk to the server through DOM events on server-handled elements) and
server-rendered content for the island beyond a placeholder.

### Shared application state

What TodoMVC taught:

- A `Context.Service` holding a `View.SharedState` plus operations,
  provided with a `Layer`, is a perfectly good shared store. `View.watch`
  connects a component to it, and the store's fan-out (`PubSub` under the
  `SubscriptionRef`) gives multi-session updates without a message bus.
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
2. ~~Ignored regions~~ Done: `data-lsc-ignore`.
3. ~~Element lifecycle hooks~~ Done: `data-lsc-hook` and `lsc.hook`.
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
| file uploads | chunked over the socket in LiveView | large |

Suggested order: debounce and key filters, form serialization, then design
navigation and reconnection together. Streams, ignored regions, hooks,
islands, `connected` and the origin check are done.
Then stop and design navigation and reconnection together: both touch the
session model and should not be bolted on one at a time.
