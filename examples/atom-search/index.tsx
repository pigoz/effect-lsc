import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { AtomRegistry } from "effect/unstable/reactivity"
import { Server } from "effect-lsc/server"
import { Search } from "./App.tsx"

const App = Server.mount("/", Search, { title: "Atom search" })

HttpRouter.serve(App).pipe(
  // One registry for the process: every tab shares its atoms.
  Layer.provide(AtomRegistry.layer),
  Layer.provide(BunHttpServer.layer({ port: 3000, disablePreemptiveShutdown: true })),
  Layer.launch,
  BunRuntime.runMain
)
