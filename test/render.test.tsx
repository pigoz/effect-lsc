import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { View } from "effect-lsc/view"

describe("View.render", () => {
  it.effect("renders elements, text and attributes", () =>
    Effect.gen(function*() {
      const html = yield* View.render(
        <main id="app" class={["a", false, "b"]} style={{ color: "red", fontSize: 12 }}>
          <h1>Hello &amp; {"<world>"}</h1>
          <input type="checkbox" checked={true} disabled={false} value={3} />
          <br />
        </main>
      )
      assert.strictEqual(
        html,
        `<main id="app" class="a b" style="color:red;font-size:12"><h1>Hello &amp; &lt;world&gt;</h1><input type="checkbox" checked value="3"><br></main>`
      )
    }))

  it.effect("skips null, undefined and booleans; renders numbers and fragments", () =>
    Effect.gen(function*() {
      const html = yield* View.render(
        <ul>
          {null}
          {undefined}
          {false}
          {true}
          {[1, 2].map((n) => <li key={n}>{n}</li>)}
          <>
            <li>3</li>
          </>
        </ul>
      )
      assert.strictEqual(html, "<ul><li>1</li><li>2</li><li>3</li></ul>")
    }))

  it.effect("emits raw html verbatim and escapes attribute values", () =>
    Effect.gen(function*() {
      const html = yield* View.render(
        <div title={`a"b<c`}>{View.raw("<b>bold</b>")}</div>
      )
      assert.strictEqual(html, `<div title="a&quot;b&lt;c"><b>bold</b></div>`)
    }))

  it.effect("renders handlers as opaque ids derived from the element path", () =>
    Effect.gen(function*() {
      const html = yield* View.render(
        <main>
          <button onClick={() => Effect.void}>a</button>
          <ul>
            {["x", "y"].map((id) => <li key={id} onDblClick={() => {}}>{id}</li>)}
          </ul>
        </main>
      )
      assert.strictEqual(
        html,
        `<main><button data-lsc-click="r.0">a</button><ul><li data-lsc-dblclick="r.1.kx">x</li><li data-lsc-dblclick="r.1.ky">y</li></ul></main>`
      )
    }))

  it.effect("renders plain function components and effectful components", () =>
    Effect.gen(function*() {
      const Plain = (props: { readonly name: string }) => <span>{props.name}</span>
      const Effectful = View.Component(function*(props: { readonly n: number }) {
        const doubled = yield* Effect.succeed(props.n * 2)
        return <b>{doubled}</b>
      })
      const html = yield* View.render(
        <div>
          <Plain name="a" />
          <Effectful n={2} />
        </div>
      )
      assert.strictEqual(html, "<div><span>a</span><b>4</b></div>")
    }))
})
