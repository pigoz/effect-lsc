// Packs the library, installs the tarball into a temporary project, and
// renders a component through the published entry points with Bun and Node.
// Catches broken exports, missing files and declaration problems that the
// in-repo tests, which import src/ directly, cannot see.
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const run = (command: string, cwd: string) => execSync(command, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim()

const tarball = join(root, run("npm pack --silent", root))
const dir = mkdtempSync(join(tmpdir(), "effect-lsc-smoke-"))
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", type: "module", private: true }))
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, jsx: "react-jsx", jsxImportSource: "effect-lsc", noEmit: true, skipLibCheck: true }
  }))
  writeFileSync(join(dir, "main.tsx"), `
import { Effect } from "effect"
import { Island } from "effect-lsc/island"
import { Server } from "effect-lsc/server"
import { View } from "effect-lsc/view"

const Hello = View.Component(function*(props: { readonly name: string }) {
  const n = yield* View.State(41)
  return <p onClick={() => n.update((x) => x + 1)}>Hello {props.name} {n.value}</p>
})
void Server.mount
const html = await Effect.runPromise(View.render(<main><Hello name="dist" /><Island name="X" props={{ a: 1 }} /></main>))
const expected = '<main><p data-lsc-click="r.0.0">Hello dist 41</p><div data-lsc-island="X" data-lsc-props="{&quot;a&quot;:1}"><div data-lsc-ignore=""></div></div></main>'
if (html !== expected) throw new Error("unexpected html: " + html)
console.log("ok")
`)
  run(`npm install --silent --no-audit --no-fund effect@4.0.0-rc.112 typescript@7 tsx ${tarball}`, dir)
  console.log("types:", run("npx tsc -p tsconfig.json && echo ok", dir))
  console.log("bun:", run("bun main.tsx", dir))
  console.log("node:", run("node --import tsx main.tsx", dir))
} finally {
  rmSync(dir, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}
