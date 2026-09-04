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
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Socket from "effect/unstable/socket/Socket"
import type { Instance } from "./instance.ts"
import { type MountOptions, originAllowed, page, session } from "./server.ts"
import type { ComponentFn } from "./vnode.ts"

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

export interface App {
  readonly fetch: (request: Request) => Promise<Response>
  /** Releases the services. Call it when the object is destroyed, if ever. */
  readonly dispose: () => Promise<void>
}

const isUpgrade = (request: Request) => request.headers.get("upgrade")?.toLowerCase() === "websocket"

/**
 * A `fetch` handler serving `component` from a Durable Object.
 */
export const app = <E, R>(component: ComponentFn<{}, E, R>, options: AppOptions<Exclude<R, Instance>>): App => {
  const runtime = ManagedRuntime.make(options.layer)
  const fetch = async (request: Request): Promise<Response> => {
    if (!isUpgrade(request)) {
      const rendered = await runtime.runPromiseExit(page(component, options))
      if (rendered._tag === "Failure") {
        console.error("effect-lsc: render failed", rendered.cause)
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
    runtime.runFork(session(component, socket, options))
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }
  return { fetch, dispose: () => runtime.dispose() }
}
