/**
 * Cloudflare Workers and Durable Objects.
 *
 * `app` turns a component and its services into a `fetch` handler for a
 * Durable Object: a plain GET renders the page, a WebSocket upgrade becomes
 * a live session running as a fiber inside the object. Every session of the
 * same object shares the services built from `layer`, so a `SharedState`
 * in a service is shared by every tab routed to that object: the Durable
 * Object is the natural home of shared state.
 *
 * ```ts
 * import { DurableObject } from "cloudflare:workers"
 * import { Cloudflare } from "effect-lsc/cloudflare"
 *
 * export class Room extends DurableObject {
 *   readonly app = Cloudflare.app(Counter, { layer: Count.layer, title: "Counter" })
 *   override fetch(request: Request) {
 *     return this.app.fetch(request)
 *   }
 * }
 *
 * export default {
 *   fetch(request: Request, env: Env) {
 *     return env.ROOM.get(env.ROOM.idFromName("global")).fetch(request)
 *   }
 * }
 * ```
 *
 * Sessions keep their state in memory, so the object must stay alive while
 * sockets are open: this uses the classic `accept()` API, not WebSocket
 * hibernation. Hibernation needs serializable session state; see NOTES.
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Socket from "effect/unstable/socket/Socket"
import { type MountOptions, originAllowed, page, type Root, session } from "./server.ts"
import type { Services } from "./view.ts"

/**
 * The Workers globals this module uses, typed locally so the library does
 * not depend on `@cloudflare/workers-types`.
 */
interface WorkerWebSocket {
  accept(): void
}

declare const WebSocketPair: new() => { readonly 0: WorkerWebSocket & WebSocket; readonly 1: WorkerWebSocket & WebSocket }

export interface AppOptions<R> extends MountOptions {
  /** The services the component requires, built once per object. */
  readonly layer: Layer.Layer<R, unknown, never>
}

/** Names the services the layer lacks in the type error. */
type Missing<Needed, Provided> = [Exclude<Needed, Provided>] extends [never] ? unknown
  : { readonly "effect-lsc: missing services": Exclude<Needed, Provided> }

export interface App {
  readonly fetch: (request: Request) => Promise<Response>
  /** Releases the services. Call it when the object is destroyed, if ever. */
  readonly dispose: () => Promise<void>
}

const isUpgrade = (request: Request) => request.headers.get("upgrade")?.toLowerCase() === "websocket"

/**
 * A `fetch` handler serving `component` from a Durable Object. The layer
 * must provide every service the component's tree needs: a missing one is
 * named in the type error.
 */
export const app = <E = never, R = never, L extends Layer.Layer<never, unknown, never> = Layer.Layer<never>>(
  component: Root<E, R>,
  // The layer is inferred whole and checked in place: a check beside it
  // would stop TypeScript from inferring a layer written inline.
  options: MountOptions & { readonly layer: L & Missing<Services<R>, Layer.Success<L>> }
): App => {
  type ROut = Layer.Success<L>
  const runtime = ManagedRuntime.make(options.layer as unknown as Layer.Layer<ROut, unknown>)
  const fetch = async (request: Request): Promise<Response> => {
    // Built on the first request, and a failed build is kept. Report it as
    // the layer's, not as a render failure.
    const services = await Effect.runPromiseExit(runtime.contextEffect)
    if (services._tag === "Failure") {
      console.error("effect-lsc: services failed to build", services.cause)
      return new Response("Internal Server Error", { status: 500 })
    }
    if (!isUpgrade(request)) {
      const rendered = await runtime.runPromiseExit(page(component, options) as Effect.Effect<string, unknown, ROut>)
      if (rendered._tag === "Failure") {
        // The services are built: a typed failure here got past the types.
        const typed = rendered.cause.reasons.some((reason) => Cause.isFailReason(reason) && !Socket.isSocketError(reason.error))
        console.error(
          typed
            ? "effect-lsc: render failed (a typed error reached the root although the types say it cannot: " +
              "look for a cast, or a component from View.use rendered elsewhere)"
            : "effect-lsc: render failed",
          rendered.cause
        )
        return new Response("Internal Server Error", { status: 500 })
      }
      return new Response(rendered.value, { headers: { "content-type": "text/html; charset=utf-8" } })
    }
    const origin = request.headers.get("origin") ?? undefined
    const host = request.headers.get("host") ?? undefined
    if (!originAllowed(origin, host, options.origins)) {
      console.warn(`effect-lsc: refused WebSocket upgrade from origin ${origin}`)
      return new Response("Forbidden", { status: 403 })
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    const socket = await runtime.runPromise(Socket.fromWebSocket(Effect.succeed(server)))
    runtime.runFork(session(component, socket, options) as Effect.Effect<void, never, ROut>)
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }
  return { fetch, dispose: () => runtime.dispose() }
}
