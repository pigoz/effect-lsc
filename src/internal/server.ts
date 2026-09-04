/**
 * `Server`: mounts a component on an `HttpRouter` path.
 *
 * A plain GET renders the component once and returns a full HTML document
 * with the browser runtime inlined. The runtime then opens a WebSocket to
 * the same path; that request is upgraded and becomes a live session:
 * the component is rendered again with fresh state, every event from the
 * browser runs its server-side handler, and every state change re-renders
 * and pushes new HTML.
 */
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import type * as Socket from "effect/unstable/socket/Socket"
import { script } from "./runtime.ts"
import type { Instance } from "./instance.ts"
import { type ClientMessage, decodeClientMessage, encodeServerMessage } from "./protocol.ts"
import { render, renderTree } from "./render.ts"
import { dispatch, makeSession } from "./session.ts"
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
 * The "dead" render: a regular HTTP GET.
 */
const page = (component: ComponentFn<{}, unknown, any>, options: MountOptions | undefined) =>
  Effect.scoped(
    Effect.gen(function*() {
      const session = yield* makeSession(false)
      const html = yield* render(session, jsx(component, {}))
      const layout = options?.layout ?? defaultLayout(options?.title ?? "effect-lsc")
      const document = yield* render(yield* makeSession(false), layout(liveContent(html)))
      return HttpServerResponse.html(`<!doctype html>${document}`)
    })
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logError("effect-lsc: render failed", cause),
        HttpServerResponse.text("Internal Server Error", { status: 500 })
      )
    )
  )

/**
 * The live session, running over an upgraded WebSocket.
 */
const live = (component: ComponentFn<{}, unknown, any>, socket: Socket.Socket) =>
  Effect.gen(function*() {
    const session = yield* makeSession(true)
    const write = yield* socket.writer
    const inbox = yield* Queue.unbounded<ClientMessage>()

    // Render, diff against the tree the browser has, send only the patch.
    const push = renderTree(session, jsx(component, {})).pipe(
      Effect.flatMap((tree) => {
        const patch = diffNode(session.tree, tree, session.sentStatics)
        session.tree = tree
        return patch === undefined ? Effect.void : write(encodeServerMessage({ t: "render", p: patch }))
      }),
      Effect.catchCause((cause) => Effect.logError("effect-lsc: render failed", cause))
    )

    yield* push
    // Re-render whenever any watched state changes. Bursts collapse into one.
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Queue.take(session.dirty), push)))
    // Events are handled one at a time, in arrival order.
    yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(inbox), (event) => dispatch(session, event))))
    // Runs until the socket closes; closing the scope stops the fibers above.
    yield* socket.runString((message) =>
      decodeClientMessage(message).pipe(
        Effect.flatMap((decoded) => Queue.offer(inbox, decoded)),
        Effect.catchCause((cause) => Effect.logWarning("effect-lsc: ignoring malformed client message", cause))
      )
    )
  }).pipe(
    Effect.scoped,
    Effect.catchTag("SocketError", () => Effect.void),
    Effect.catchCause((cause) => Effect.logError("effect-lsc: live session failed", cause)),
    Effect.as(HttpServerResponse.empty())
  )

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
 *   Layer.provide(BunHttpServer.layer({ port: 3000 })),
 *   Layer.launch,
 *   BunRuntime.runMain
 * )
 * ```
 */
export const mount = <E = never, R = never>(
  path: HttpRouter.PathInput,
  component: ComponentFn<{}, E, R>,
  options?: MountOptions
): Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request.From<"Requires", Exclude<R, Instance | HttpRouter.Provided>>> => {
  const handler = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    !isUpgrade(request)
      ? page(component, options)
      : !originAllowed(request.headers["origin"], request.headers["host"], options?.origins)
      ? forbidden(request)
      : Effect.flatMap(request.upgrade, (socket) => live(component, socket))
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
    Exclude<R, Instance> | HttpServerRequest.HttpServerRequest | Scope.Scope
  >
  return HttpRouter.use((router) => router.add("GET", path, handler))
}
