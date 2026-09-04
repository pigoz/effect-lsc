// Serves an HttpRouter application on Bun or Node, whichever is running.
// The examples and the browser fixture use this so the same file runs with
// `bun examples/x/index.tsx` and `node --import tsx examples/x/index.tsx`.
import { Config, Effect, Layer } from "effect"
import type { HttpServer } from "effect/unstable/http"

const port = Config.port("PORT").pipe(Config.withDefault(3000))

export const serve = async <E>(app: Layer.Layer<never, E, HttpServer.HttpServer>): Promise<void> => {
  if (typeof (globalThis as any).Bun !== "undefined") {
    const { BunHttpServer, BunRuntime } = await import("@effect/platform-bun")
    app.pipe(
      Layer.provide(BunHttpServer.layerConfig({
        port,
        // Interrupt live sessions first, then stop: Ctrl+C exits at once. Needs Bun 1.4.1+.
        disablePreemptiveShutdown: Config.succeed(true)
      })),
      Layer.launch,
      BunRuntime.runMain
    )
  } else {
    const { NodeHttpServer, NodeRuntime } = await import("@effect/platform-node")
    const { createServer } = await import("node:http")
    app.pipe(
      Layer.provide(Layer.unwrap(Effect.map(port, (port) => NodeHttpServer.layer(createServer, { port })))),
      Layer.launch,
      NodeRuntime.runMain
    )
  }
}
