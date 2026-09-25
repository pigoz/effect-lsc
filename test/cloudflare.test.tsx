// Cloudflare.app outside a Durable Object: a plain GET needs only a Request.
import { assert, describe, it } from "@effect/vitest"
import { Context, Data, Effect, Layer } from "effect"
import { Cloudflare } from "effect-lsc/cloudflare"
import { View } from "effect-lsc/view"
import { vi } from "vitest"

class NotFound extends Data.TaggedError("NotFound")<{}> {}
class Db extends Context.Service<Db, { readonly name: string }>()("test/Db") {}

const Name = View.Component(function*() {
  const db = yield* Db
  return <b>{db.name}</b>
})
const App = View.Component(function*() {
  const N = yield* View.use(Name)
  return <main><N /></main>
})
const DbLive = Layer.succeed(Db, { name: "db" })
const NoDb = Layer.effect(Db, Effect.fail(new Error("no database binding")))

/** Runs `f` with `console.error` recorded: the first argument of each call. */
const errors = async (f: () => Promise<void>): Promise<ReadonlyArray<unknown>> => {
  const logged: Array<unknown> = []
  const spy = vi.spyOn(console, "error").mockImplementation((message) => {
    logged.push(message)
  })
  try {
    await f()
  } finally {
    spy.mockRestore()
  }
  return logged
}

describe("Cloudflare.app", () => {
  it("renders the page for a plain GET, with the services of its layer", async () => {
    const app = Cloudflare.app(App, { layer: DbLive })
    const response = await app.fetch(new Request("http://localhost/"))
    assert.strictEqual(response.status, 200)
    assert.include(await response.text(), "<main><b>db</b></main>")
    await app.dispose()
  })

  it("reports a layer that fails to build as such, not as a render failure", async () => {
    const app = Cloudflare.app(App, { layer: NoDb })
    const logged = await errors(async () => {
      assert.strictEqual((await app.fetch(new Request("http://localhost/"))).status, 500)
    })
    assert.deepStrictEqual(logged, ["effect-lsc: services failed to build"])
    await app.dispose()
  })

  it("says a typed error at the root got past the types", async () => {
    const Fails = View.Component(function*() {
      return yield* new NotFound()
    })
    const app = Cloudflare.app(Fails as unknown as () => View.Child, { layer: Layer.empty })
    const logged = await errors(async () => {
      assert.strictEqual((await app.fetch(new Request("http://localhost/"))).status, 500)
    })
    assert.strictEqual(logged.length, 1)
    assert.include(String(logged[0]), "effect-lsc: render failed (a typed error reached the root")
    await app.dispose()
  })
})
