// The TodoMVC components of examples/todomvc, served as a fixture for both runtimes.
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Server } from "effect-lsc/server"
import type { View } from "effect-lsc/view"
import { App } from "../../../examples/todomvc/App.tsx"
import { Todos } from "../../../examples/todomvc/Todos.ts"
import { serve } from "./serve.ts"

const layout = (content: View.Child) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>TodoMVC fixture</title>
    </head>
    <body>{content}</body>
  </html>
)

await serve(HttpRouter.serve(Server.mount("/", App, { layout })).pipe(Layer.provide(Todos.layer)))
