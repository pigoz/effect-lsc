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

**Full HTML per render, index-based morph.** The server sends the whole page
fragment every time and the runtime morphs by child index. Focused text
inputs keep the user's value (server attribute changes to `value` on the
element being typed into are ignored), checkboxes/selects mirror the
server, `autofocus` is honoured on inserted nodes, and a live `submit`
resets the form the way a native submit would have. No keys on the client,
so reordering a list re-patches nodes rather than moving them. Good enough to
prove the model; a keyed morph is a contained upgrade.

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

Sending the whole page on every render is an MVP shortcut. The wire format
must become fragments, and the current design was shaped so that this is an
evolution of `render.ts` and the protocol, not a rewrite:

- every node already has a stable path, and component instances live at
  their path; a fragment is "the output of the instance at path P"
- the browser runtime patches by morphing, so it can morph a fragment into
  the subtree at P exactly as it morphs the whole root today
- the protocol is message based; `{t: "render", html}` becomes
  `{t: "patch", fragments: [{path, html}]}` without touching anything else

Two steps, both compiler-free:

1. **Per-instance dirtiness.** `Instance.invalidate` marks the instance
   dirty instead of the whole session. A render pass re-renders only dirty
   instances top-down (descendants of a dirty ancestor are covered by it),
   compares each output with the cached previous one, and sends only the
   fragments that changed. Children whose props are unchanged and are not
   dirty can reuse their cached output (the LiveComponent `update`
   optimisation). This needs components to have a single root element, or
   comment anchors around multi-root output, so the client can find the
   subtree.
2. **Statics and dynamics at runtime.** LiveView's diffs come from its
   template compiler, which we deliberately do not have. But the renderer
   walks the VNode tree, so instead of a string it can emit a shape (tags,
   attribute names, child structure) plus a list of values (text and
   attribute values). The client caches the shape per fingerprint; while
   the shape of an instance is unchanged, a render sends only the values
   that differ by index, like LiveView's `{"0": "1"}`. A shape change falls
   back to the fragment from step 1. Lists and conditionals change shape,
   so keep instance boundaries small around them.

The alternative to step 2 is a server-side VNode diff producing patch ops
(set text, set attribute, insert, remove, move) that the client applies
without morphing. More precise, replaces the morph entirely, but needs the
previous tree per session and a keyed diff algorithm. Step 2 reuses the
morph and maps onto a proven model; try it first.

Fragment boundaries, instance boundaries and island boundaries are the same
thing, which is the reason to keep paths and instances as the core identity.

### Other

- `View.State` identity by explicit key, to lift the call-order rule.
- Batched handler execution: `Reactivity.withBatch` already exists in Effect
  and could wrap each handler so multiple state writes cause one render.
  (The sliding queue already coalesces, so the gain is small.)
- Streaming the first render (`HttpServerResponse.htmlStream`) once components
  do slow work.
