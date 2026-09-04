// A page built for the browser tests: every behaviour the runtime must
// keep is exercised here without any network dependency. Each section is
// its own component, so the tests can assert which element gets morphed.
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Island } from "effect-lsc/island"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"

type Item = { readonly id: number; readonly label: string; readonly done: boolean }

class Shared extends Context.Service<Shared, View.SharedState<number>>()("fixture/Shared") {
  static readonly layer = Layer.effect(Shared, View.SharedState(0))
}

const Counter = View.Component(function*() {
  const count = yield* View.State(0)
  const paused = yield* View.State(false)
  const shared = yield* Shared
  const total = yield* View.watch(shared)
  return (
    <section id="counter">
      <button id="inc" onClick={() => count.update((n) => n + 1)}>+</button>
      <output id="count">{count.value}</output>
      <button id="pause" onClick={() => paused.update((p) => !p)}>{paused.value ? "Resume" : "Pause"}</button>
      <button id="shared-inc" onClick={() => shared.update((n) => n + 1)}>shared</button>
      <output id="shared">{total}</output>
    </section>
  )
})

const Row = View.Component(function*(p: { readonly item: Item; readonly onToggle: Effect.Effect<void> }) {
  const editing = yield* View.State(false)
  return (
    <li class={[p.item.done && "done", editing.value && "editing"]} data-id={p.item.id}>
      <input type="checkbox" class="toggle" checked={p.item.done} onChange={() => p.onToggle} />
      <label onDblClick={() => editing.set(true)}>{p.item.label}</label>
      {editing.value && <input class="edit" value={p.item.label} autofocus onBlur={() => editing.set(false)} />}
    </li>
  )
})

const Done = (p: { readonly items: ReadonlyArray<Item> }) => <output id="done">{p.items.filter((i) => i.done).length}</output>

const ListSection = View.Component(function*() {
  const items = yield* View.State<ReadonlyArray<Item>>([])
  const nextId = yield* View.State(1)
  const add = Effect.gen(function*() {
    const id = nextId.value
    yield* nextId.set(id + 1)
    yield* items.update((all) => [...all, { id, label: `item ${id}`, done: false }])
  })
  const toggle = (id: number) => items.update((all) => all.map((i) => i.id === id ? { ...i, done: !i.done } : i))
  return (
    <section id="list">
      <button id="add" onClick={() => add}>add</button>
      <button id="remove-first" onClick={() => items.update((all) => all.slice(1))}>remove first</button>
      <button id="rotate" onClick={() => items.update((all) => all.length > 0 ? [...all.slice(1), all[0]!] : all)}>rotate</button>
      <button id="reverse" onClick={() => items.update((all) => [...all].reverse())}>reverse</button>
      <ul id="items">
        {items.value.map((item) => <Row key={item.id} item={item} onToggle={toggle(item.id)} />)}
      </ul>
      <Done items={items.value} />
    </section>
  )
})

const FormSection = View.Component(function*() {
  const draft = yield* View.State("")
  const submitted = yield* View.State("")
  return (
    <section id="form">
      <input id="draft" value={draft.value} onInput={(e) => draft.set(e.value)} />
      <output id="echo">{draft.value}</output>
      <form onSubmit={(e) => submitted.set(e.form["text"] ?? "")}>
        <input id="text" name="text" />
        <button id="submit" type="submit">submit</button>
      </form>
      <output id="submitted">{submitted.value}</output>
    </section>
  )
})

const IslandSection = View.Component(function*() {
  const showIsland = yield* View.State(true)
  const islandValue = yield* View.State(1)
  const hookValue = yield* View.State("a")
  const showHook = yield* View.State(true)
  return (
    <section id="islands">
      <button id="island-bump" onClick={() => islandValue.update((n) => n + 1)}>bump</button>
      <button id="island-toggle" onClick={() => showIsland.update((s) => !s)}>{showIsland.value ? "hide" : "show"}</button>
      {showIsland.value && (
        <Island name="Box" props={{ value: islandValue.value }}>
          <em id="placeholder">placeholder</em>
        </Island>
      )}
      <button id="hook-bump" onClick={() => hookValue.update((v) => v + "a")}>hook</button>
      <button id="hook-toggle" onClick={() => showHook.update((s) => !s)}>hook toggle</button>
      {showHook.value && <div id="hooked" data-lsc-hook="probe" data-value={hookValue.value}></div>}
    </section>
  )
})

const Page = () => (
  <main>
    <Counter />
    <ListSection />
    <FormSection />
    <IslandSection />
  </main>
)

const layout = (content: View.Child) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>effect-lsc browser fixture</title>
    </head>
    <body>
      {content}
      <script>
        {View.raw(`
window.__events = [];
window.lsc.hook("probe", {
  mounted: function (el) { window.__events.push("mounted:" + el.getAttribute("data-value")); },
  updated: function (el) { window.__events.push("updated:" + el.getAttribute("data-value")); },
  destroyed: function (el) { window.__events.push("destroyed:" + el.getAttribute("data-value")); }
});
window.lsc.island("Box", {
  mount: function (el, props) {
    window.__events.push("island:mount:" + props.value);
    el.innerHTML = '<b id="box">' + props.value + '</b><i id="local">0</i>';
    var local = 0;
    el.querySelector("#box").addEventListener("click", function () { local++; el.querySelector("#local").textContent = String(local); });
    return {
      update: function (next) { window.__events.push("island:update:" + next.value); el.querySelector("#box").textContent = String(next.value); },
      unmount: function () { window.__events.push("island:unmount"); }
    };
  }
});
`)}
      </script>
    </body>
  </html>
)

HttpRouter.serve(Server.mount("/", Page, { layout })).pipe(
  Layer.provide(Shared.layer),
  Layer.provide(BunHttpServer.layerConfig({
    port: Config.port("PORT").pipe(Config.withDefault(3000)),
    disablePreemptiveShutdown: Config.succeed(true)
  })),
  Layer.launch,
  BunRuntime.runMain
)
