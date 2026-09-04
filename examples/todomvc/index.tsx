import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import type { View } from "effect-lsc/view"
import { App } from "./App.tsx"
import { Todos } from "./Todos.ts"

const layout = (content: View.Child) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>TodoMVC · effect-lsc</title>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/todomvc-common@1.0.5/base.css" />
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/todomvc-app-css@2.4.3/index.css" />
    </head>
    <body>
      {content}
      <footer class="info">
        <p>Double-click to edit a todo</p>
        <p>Open this page in two tabs: the list is shared server state</p>
      </footer>
    </body>
  </html>
)

const Routes = Server.mount("/", App, { layout })

HttpRouter.serve(Routes).pipe(
  Layer.provide(Todos.layer),
  Layer.provide(BunHttpServer.layerConfig({
    port: Config.port("PORT").pipe(Config.withDefault(3000)),
    // Interrupt live sessions first, then stop: Ctrl+C exits at once.
    // Needs Bun 1.4.1+.
    disablePreemptiveShutdown: Config.succeed(true)
  })),
  Layer.launch,
  BunRuntime.runMain
)
