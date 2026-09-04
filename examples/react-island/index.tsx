import { Effect } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Island } from "effect-lsc/island"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"
import { serve } from "../runtime.ts"

// A server-driven page with a React island inside it. The server owns the
// data (a sample every second) and pushes it to the island as props; React
// owns the island's DOM and its own state, which server patches never touch.
const Dashboard = View.Component(function*() {
  const samples = yield* View.State<ReadonlyArray<number>>([])
  const paused = yield* View.State(false)
  const shown = yield* View.State(true)
  const live = yield* View.connected

  // One fiber per session, started on the first live render, gone with the instance.
  yield* View.once(
    live
      ? Effect.forkScoped(
        Effect.forever(
          Effect.sleep("1 second").pipe(
            Effect.andThen(Effect.suspend(() =>
              paused.value ? Effect.void : samples.update((s) => [...s.slice(-19), Math.round(Math.random() * 100)])
            ))
          )
        )
      )
      : Effect.void
  )

  return (
    <main>
      <h1>Server-driven page, React island</h1>
      <p>
        The server samples a value every second and pushes it as props. Buttons in this
        paragraph are handled on the server; the chart below is rendered by React.
      </p>
      <p>
        <button onClick={() => paused.update((p) => !p)}>{paused.value ? "Resume" : "Pause"}</button>{" "}
        <button onClick={() => samples.set([])}>Reset</button>{" "}
        <button onClick={() => shown.update((s) => !s)}>{shown.value ? "Hide chart" : "Show chart"}</button>{" "}
        <span>{samples.value.length} samples</span>
      </p>
      {shown.value && (
        <Island name="Chart" props={{ values: samples.value }}>
          <em>Loading chart...</em>
        </Island>
      )}
    </main>
  )
})

const layout = (content: View.Child) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>React island · effect-lsc</title>
      <style>{`body{font-family:system-ui;margin:2rem;max-width:40rem}.bars{display:flex;align-items:flex-end;gap:2px;height:120px;border-bottom:1px solid #999}.bar{flex:1;background:#4a90e2}.bar.hot{background:#e24a4a}`}</style>
    </head>
    <body>
      {content}
      <script type="module">
        {View.raw(`
import React, { useState } from "https://esm.sh/react@19";
import { createRoot } from "https://esm.sh/react-dom@19/client";

function Chart({ values }) {
  // Client-only state: survives every server patch.
  const [clicks, setClicks] = useState(0);
  const [hot, setHot] = useState(false);
  return React.createElement("div", { className: "chart" },
    React.createElement("div", { className: "bars" },
      values.map((v, i) => React.createElement("div", { key: i, className: "bar" + (hot ? " hot" : ""), style: { height: v + "%" }, title: String(v) }))),
    React.createElement("p", null,
      React.createElement("button", { onClick: () => setClicks(clicks + 1) }, "React clicks: " + clicks), " ",
      React.createElement("button", { onClick: () => setHot(!hot) }, hot ? "Cool" : "Hot"), " ",
      React.createElement("span", null, values.length + " values from the server")));
}

window.lsc.island("Chart", {
  mount(element, props) {
    const root = createRoot(element);
    root.render(React.createElement(Chart, props));
    return {
      update: (next) => root.render(React.createElement(Chart, next)),
      unmount: () => root.unmount()
    };
  }
});
`)}
      </script>
    </body>
  </html>
)

await serve(HttpRouter.serve(Server.mount("/", Dashboard, { layout })))
