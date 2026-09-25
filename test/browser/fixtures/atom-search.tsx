// The components of examples/atom-search, served as a fixture for both runtimes.
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { AtomRegistry } from "effect/unstable/reactivity"
import { Server } from "effect-lsc/server"
import { Search } from "../../../examples/atom-search/App.tsx"
import { serve } from "./serve.ts"

await serve(HttpRouter.serve(Server.mount("/", Search, { title: "Atom search fixture" })).pipe(Layer.provide(AtomRegistry.layer)))
