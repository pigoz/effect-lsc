import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { Island } from "effect-lsc/island"
import { View } from "effect-lsc/view"
import { render } from "../src/internal/render.ts"
import { makeSession } from "../src/internal/session.ts"

describe("Island", () => {
  it.effect("renders a container with the name, JSON props and an ignored mount point", () =>
    Effect.gen(function*() {
      const html = yield* View.render(
        <Island name="Chart" props={{ values: [1, 2], label: `a"b<c` }} class="wide">
          <em>loading</em>
        </Island>
      )
      assert.strictEqual(
        html,
        `<div data-lsc-island="Chart" data-lsc-props="{&quot;values&quot;:[1,2],&quot;label&quot;:&quot;a\\&quot;b&lt;c&quot;}" class="wide"><div data-lsc-ignore=""><em>loading</em></div></div>`
      )
      assert.strictEqual(yield* View.render(<Island name="X" tag="section" />), `<section data-lsc-island="X" data-lsc-props="null"><div data-lsc-ignore=""></div></section>`)
    }))
})

describe("View.once", () => {
  it.effect("runs once per instance, in its scope, and returns the same result on every render", () =>
    Effect.gen(function*() {
      const counter = yield* Ref.make(0)
      const Comp = View.Component(function*() {
        const tick = yield* View.State(0)
        const started = yield* View.once(Effect.flatMap(Ref.updateAndGet(counter, (n) => n + 1), (n) => Effect.succeed(n)))
        return <button onClick={() => tick.update((t) => t + 1)}>{started}:{tick.value}</button>
      })
      const session = yield* makeSession()
      assert.strictEqual(yield* render(session, <Comp />), `<button data-lsc-click="r.0">1:0</button>`)
      yield* Effect.flatMap(Effect.succeed(session), () => Effect.void)
      assert.strictEqual(yield* render(session, <Comp />), `<button data-lsc-click="r.0">1:0</button>`)
      assert.strictEqual(yield* Ref.get(counter), 1)
    }))
})
