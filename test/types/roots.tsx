// Type tests: what the root (Server.mount, page, session, Cloudflare.app) requires.
// Checked by `bun run check`; every @ts-expect-error must hide a real error.
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type * as Socket from "effect/unstable/socket/Socket"
import { Cloudflare } from "effect-lsc/cloudflare"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"
import { Auth, check, Clock, Db, Denied, type Equals, NotFound } from "./util.ts"

const Find = View.Component(function*(props: { readonly id: string }) {
  const db = yield* Db
  return <li>{yield* db.load(props.id)}</li>
}).pipe(View.catchTag("NotFound", () => <li>missing</li>))
const App = View.Component(function*() {
  const Item = yield* View.use(Find)
  return <ul><Item id="1" /></ul>
})

// the whole tree's services reach mount: Db is only needed by a child
export const app = Server.mount("/", App)
check<Equals<typeof app, Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request<"Requires", Db>>>>()
// merged mounts union their requirements
const Other = View.Component(function*() {
  yield* Clock
  return <p />
})
export const both = Layer.mergeAll(app, Server.mount("/other", Other))
export const bothType: Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request<"Requires", Db | Clock>> = both
// @ts-expect-error Clock is required too
export const bothTypeWrong: Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request<"Requires", Db>> = both
const DbLive = Layer.succeed(Db, { load: (id) => Effect.succeed(id) })
export const served = () =>
  HttpRouter.serve(app).pipe(
    Layer.provide(DbLive),
    Layer.provide(BunHttpServer.layer({ port: 0 })),
    Layer.launch,
    BunRuntime.runMain
  )
export const missing = () =>
  HttpRouter.serve(app).pipe(
    Layer.provide(BunHttpServer.layer({ port: 0 })),
    // @ts-expect-error Db is not provided: reported where the layer is launched
    Layer.launch,
    BunRuntime.runMain
  )

// unhandled errors, own or in the subtree, are rejected and named
const Unsafe = View.Component(function*() {
  const Item = yield* View.use(View.Component(function*() {
    return yield* new Denied({ user: "x" })
  }))
  return <Item />
})
// @ts-expect-error unhandled Denied
export const m1 = Server.mount("/", Unsafe)
// @ts-expect-error unhandled Denied
export const p1 = Server.page(Unsafe)
declare const socket: Socket.Socket
// @ts-expect-error unhandled Denied
export const s1 = Server.session(Unsafe, socket)
export const safe = Server.mount("/", View.catchTag(Unsafe, "Denied", () => <p>denied</p>))
export const dies = Server.mount("/", View.orDie(Unsafe))
// a body failing with its own typed error is rejected too
const OwnError = View.Component(function*() {
  return yield* new NotFound({ id: "x" })
})
// @ts-expect-error unhandled NotFound
export const m2 = Server.mount("/", OwnError)
// Scope in the tree is rejected (it would be the session's)
const Leaky = View.Component(function*() {
  yield* Effect.addFinalizer(() => Effect.void)
  return <p />
})
// @ts-expect-error requires Scope
export const m3 = Server.mount("/", Leaky)

// Cloudflare: the layer must provide the whole tree's services
export const cf = Cloudflare.app(App, { layer: DbLive })
// a layer written inline is checked the same way
export const cfInline = Cloudflare.app(App, { layer: Layer.succeed(Db, { load: (id) => Effect.succeed(id) }) })
export const cfInlineEffect = Cloudflare.app(App, {
  layer: Layer.effect(Db, Effect.succeed({ load: (id: string) => Effect.succeed(id) }))
})
// @ts-expect-error the layer lacks Db: named in the error
export const cfMissing = Cloudflare.app(App, { layer: Layer.succeed(Auth, { check: Effect.succeed("") }) })
// @ts-expect-error unhandled errors are rejected
export const cfUnsafe = Cloudflare.app(Unsafe, { layer: Layer.empty })
// @ts-expect-error the layer may not have requirements of its own
export const cfOpen = Cloudflare.app(App, { layer: Layer.effect(Db, Effect.gen(function*() {
  yield* Clock
  return { load: (id: string) => Effect.succeed(id) }
})) })

// request-scoped services: a router middleware discharges them for the page and the live session
class CurrentUser extends Context.Service<CurrentUser, { readonly name: string }>()("t/CurrentUser") {}
const Authentication = HttpRouter.middleware<{ provides: CurrentUser }>()(
  Effect.succeed((handler) => Effect.provideService(handler, CurrentUser, { name: "ada" }))
)
const Greeting = View.Component(function*() {
  const user = yield* CurrentUser
  return <p>{user.name}</p>
})
export const authenticated = Server.mount("/", Greeting).pipe(Layer.provide(Authentication.layer))
check<Equals<typeof authenticated, Layer.Layer<never, never, HttpRouter.HttpRouter>>>()
