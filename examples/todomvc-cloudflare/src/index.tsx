import { DurableObject } from "cloudflare:workers"
import { Cloudflare } from "effect-lsc/cloudflare"
import { App } from "./App.tsx"
import { layout } from "./layout.tsx"
import { Todos } from "./Todos.ts"

export class Room extends DurableObject {
  // Built once per object: every connected tab watches the same todo list.
  readonly app = Cloudflare.app(App, { layer: Todos.layer, layout })

  override fetch(request: Request): Promise<Response> {
    return this.app.fetch(request)
  }
}

interface Env {
  readonly ROOM: DurableObjectNamespace<Room>
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // HTTP requests and WebSocket connections must reach the same object.
    const room = env.ROOM.get(env.ROOM.idFromName("global"))
    return room.fetch(request)
  }
} satisfies ExportedHandler<Env>
