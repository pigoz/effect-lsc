import { defineConfig } from "vite"

// Library build: one ES module per public entry, `effect` left external.
// Declarations are emitted separately by `tsc -p tsconfig.build.json`.
export default defineConfig({
  build: {
    target: "es2022",
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        "index": "src/index.ts",
        "view": "src/view.ts",
        "server": "src/server.ts",
        "jsx-runtime": "src/jsx-runtime.ts",
        "jsx-dev-runtime": "src/jsx-dev-runtime.ts"
      },
      formats: ["es"]
    },
    rollupOptions: {
      external: (id) => id === "effect" || id.startsWith("effect/") || id.startsWith("@effect/"),
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "internal/[name]-[hash].js"
      }
    }
  }
})
