/**
 * `Server`: runs components over HTTP and WebSockets.
 *
 * Two platform-independent primitives do the work:
 *
 * - `page` renders a component once into a full HTML document with the
 *   browser runtime inlined (the "dead" render, for a plain GET)
 * - `session` runs the live loop over an Effect `Socket`: the component is
 *   rendered again with fresh state, every event from the browser runs its
 *   server-side handler, and every state change re-renders and pushes a
 *   patch; it ends when the socket closes
 *
 * `mount` wires both to an `HttpRouter` path (Bun, Node); the Cloudflare
 * module wires them to a Durable Object.
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Socket from "effect/unstable/socket/Socket"
import { script } from "./runtime.ts"
import { type ClientMessage, decodeClientMessage, encodeServerMessage } from "./protocol.ts"
import { render, renderTree } from "./render.ts"
import { dispatch, makeSession } from "./session.ts"
import type { Errors, NoScope, Services } from "./view.ts"
import type { Child, ComponentFn } from "./vnode.ts"
import { jsx, raw } from "./vnode.ts"
import { diffNode } from "./wire.ts"

export interface MountOptions {
  /** Document title used by the default layout. */
  readonly title?: string | undefined
  /**
   * Which origins may open the live session. By default only the page's
   * own origin (the `Origin` header must match the `Host` header). Pass a
   * list of allowed origins (`https://app.example`) or a predicate.
   * Requests without an `Origin` header are not browsers and are allowed.
   */
  readonly origins?: ReadonlyArray<string> | ((origin: string) => boolean) | undefined
  /**
   * Send failure details (the pretty-printed `Cause`) to the browser in
   * `error` messages, for development. Off by default: the browser only
   * learns that a handler or a render failed.
   */
  readonly debug?: boolean | undefined
  /**
   * Wraps the live content in a document. Receives the live root and the
   * runtime script; must return the `<html>` element. The layout is static:
   * it is rendered once per page load and is not part of the live tree.
   */
  readonly layout?: ((content: Child) => Child) | undefined
}

const defaultLayout = (title: string) => (content: Child): Child =>
  jsx("html", {
    lang: "en",
    children: [
      jsx("head", {
        children: [
          jsx("meta", { charset: "utf-8" }),
          jsx("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
          jsx("title", { children: title })
        ]
      }),
      jsx("body", { children: content })
    ]
  })

const liveContent = (html: string): Child => [
  jsx("div", { "data-lsc-root": true, children: raw(html) }),
  jsx("script", { children: raw(script) })
]

/**
 * A component that can be served: no typed error left, in its body or in
 * its subtree, and no `Scope` requirement. The intersection names what is
 * wrong in the type error.
 */
export type Root<E, R> = ComponentFn<{}, E, R> & RootCheck<Errors<E, R>> & NoScope<Services<R>>
type RootCheck<E> = [E] extends [never] ? unknown : { readonly "effect-lsc: unhandled errors": E }

/**
 * The types say no typed error reaches the root; one that does got past
 * them, through a cast (`as any`) or a component from `View.use` rendered
 * elsewhere. Say so in the log. A `SocketError` comes from sending the
 * patch, not from the render, and gets no hint.
 */
const rootFailure = (message: string, cause: Cause.Cause<unknown>) =>
  cause.reasons.some((reason) => Cause.isFailReason(reason) && !Socket.isSocketError(reason.error))
    ? Effect.logError(
      `${message} (a typed error reached the root although the types say it cannot: ` +
        "look for a cast, or a component from View.use rendered elsewhere)",
      cause
    )
    : Effect.logError(message, cause)

/**
 * Renders `component` once, with fresh disconnected state, into a full
 * HTML document with the browser runtime inlined.
 */
export const page = <E = never, R = never>(
  component: Root<E, R>,
  options?: MountOptions
): Effect.Effect<string, unknown, Services<R>> =>
  Effect.scoped(
    Effect.gen(function*() {
      const session = yield* makeSession(false)
      const html = yield* render(session, jsx(component, {}))
      const layout = options?.layout ?? defaultLayout(options?.title ?? "effect-lsc")
      const document = yield* render(yield* makeSession(false), layout(liveContent(html)))
      return `<!doctype html>${document}`
    })
  ) as Effect.Effect<string, unknown, Services<R>>

const pageResponse = (component: ComponentFn<{}, any, any>, options: MountOptions | undefined) =>
  page(component as Root<never, any>, options).pipe(
    Effect.map((html) => HttpServerResponse.html(html)),
    Effect.catchCause((cause) =>
      Effect.as(
        rootFailure("effect-lsc: render failed", cause),
        HttpServerResponse.text("Internal Server Error", { status: 500 })
      )
    )
  )

/**
 * Runs the live session for `component` over `socket`, until the socket
 * closes.
 *
 * Failure semantics:
 * - a failing event handler is logged and reported to the browser as an
 *   `error` message; the session and its state survive
 * - a failing render is reported the same way, then the session ends and
 *   the socket is closed with code 1011: the browser reconnects and mounts
 *   a fresh session (use `View.ErrorBoundary` to contain failures instead)
 * - a closed socket is a normal end; the running handler and render are
 *   interrupted, then every instance of the session is closed
 */
export const session = <E = never, R = never>(
  component: Root<E, R>,
  socket: Socket.Socket,
  options?: { readonly debug?: boolean | undefined }
): Effect.Effect<void, never, Services<R>> =>
  Effect.gen(function*() {
    const session = yield* makeSession(true)
    const write = yield* socket.writer
    const inbox = yield* Queue.unbounded<ClientMessage>()
    const rendered = yield* Deferred.make<void>()
    const describe = (scope: "handler" | "render", cause: Cause.Cause<unknown>) =>
      options?.debug ? Cause.pretty(cause) : `${scope} failed`
    const report = (scope: "handler" | "render") => (cause: Cause.Cause<unknown>) =>
      Effect.ignore(write(encodeServerMessage({ t: "error", scope, message: describe(scope, cause) })))

    // Render, diff against the tree the browser has, send only the patch.
    // A failed render ends the session: report, then close the socket.
    const push = renderTree(session, jsx(component, {})).pipe(
      Effect.flatMap((tree) => {
        const patch = diffNode(session.tree, tree, session.sentStatics)
        session.tree = tree
        return patch === undefined ? Effect.void : write(encodeServerMessage({ t: "render", p: patch }))
      }),
      Effect.catchCause((cause) =>
        rootFailure("effect-lsc: render failed, ending the session", cause).pipe(
          Effect.andThen(report("render")(cause)),
          Effect.andThen(Effect.ignore(write(new Socket.CloseEvent(1011, "render failed"))))
        )
      ),
      Effect.ensuring(Deferred.succeed(rendered, undefined))
    )

    // The render loop: the first render when the socket opens, then one
    // whenever watched state changes. Bursts collapse into one. Every render
    // runs on this fiber, so a render that waits (View.result) is never
    // overlapped by the next.
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Queue.take(session.dirty), push)))
    // Events are handled one at a time, in arrival order. Until the first
    // render ends the session has no handlers, although the browser already
    // shows the page, so events wait for it.
    yield* Effect.forkScoped(
      Effect.andThen(
        Deferred.await(rendered),
        Effect.forever(Effect.flatMap(Queue.take(inbox), (event) => dispatch(session, event, report("handler"))))
      )
    )
    // The read loop owns the socket: on some platforms it completes the
    // handshake and only then accepts writes, so onOpen asks the render
    // loop for the first render. Runs until the socket closes; closing the
    // scope stops the fibers above, then closes the instances.
    yield* socket.runString(
      (message) =>
        decodeClientMessage(message).pipe(
          Effect.flatMap((decoded) => Queue.offer(inbox, decoded)),
          Effect.catchCause((cause) => Effect.logWarning("effect-lsc: ignoring malformed client message", cause))
        ),
      { onOpen: Effect.asVoid(Queue.offer(session.dirty, undefined)) }
    )
  }).pipe(
    Effect.scoped,
    Effect.catchTag("SocketError", () => Effect.void),
    Effect.catchCause((cause) => Effect.logError("effect-lsc: live session failed", cause))
  ) as Effect.Effect<void, never, Services<R>>

const isUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["upgrade"]?.toLowerCase() === "websocket"

/**
 * Whether a WebSocket upgrade from `origin` may proceed. Browsers always
 * send `Origin` on upgrades, so a mismatch means another site is trying to
 * drive the session (cross-site WebSocket hijacking).
 */
export const originAllowed = (
  origin: string | undefined,
  host: string | undefined,
  origins: MountOptions["origins"]
): boolean => {
  if (origin === undefined) return true
  if (typeof origins === "function") return origins(origin)
  if (origins !== undefined) return origins.includes(origin)
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const forbidden = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.as(
    Effect.logWarning(`effect-lsc: refused WebSocket upgrade from origin ${request.headers["origin"]}`),
    HttpServerResponse.text("Forbidden", { status: 403 })
  )

/**
 * Mounts `component` at `path`: `GET path` serves the page, and a WebSocket
 * upgrade on the same path runs the live session.
 *
 * ```ts
 * const App = Server.mount("/", Counter, { title: "Counter" })
 *
 * HttpRouter.serve(App).pipe(
 *   Layer.provide(BunHttpServer.layer({ port: 3000, disablePreemptiveShutdown: true })),
 *   Layer.launch,
 *   BunRuntime.runMain
 * )
 * ```
 */
export const mount = <E = never, R = never>(
  path: HttpRouter.PathInput,
  component: Root<E, R>,
  options?: MountOptions
): Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Exclude<Services<R>, HttpRouter.Provided>>> => {
  const handler = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    !isUpgrade(request)
      ? pageResponse(component, options)
      : !originAllowed(request.headers["origin"], request.headers["host"], options?.origins)
      ? forbidden(request)
      : Effect.flatMap(request.upgrade, (socket) => Effect.as(session(component, socket, options), HttpServerResponse.empty()))
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logError("effect-lsc: request failed", cause),
        HttpServerResponse.text("Internal Server Error", { status: 500 })
      )
    )
  ) as Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    Services<R> | HttpServerRequest.HttpServerRequest | Scope.Scope
  >
  return HttpRouter.use((router) => router.add("GET", path, handler))
}
