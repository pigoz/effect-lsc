import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { type Browser, type BrowserContext, chromium, type Page } from "playwright"

const root = fileURLToPath(new URL("../..", import.meta.url))

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")))
    })
  })

/** Which runtime runs the servers under test: `bun` (default) or `node`. */
export const runtime: "bun" | "node" = process.env["LSC_RUNTIME"] === "node" ? "node" : "bun"

const command = (file: string): [string, Array<string>] =>
  runtime === "node" ? ["node", ["--import", "tsx", file]] : ["bun", [file]]

/** Starts an example or fixture on a free port with the selected runtime and waits for it. */
export const startServer = async (file: string): Promise<{ url: string; stop: () => Promise<void> }> => {
  const port = await freePort()
  const [bin, args] = command(file)
  const child: ChildProcess = spawn(bin, args, { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout?.on("data", (chunk) => (log += chunk))
  child.stderr?.on("data", (chunk) => (log += chunk))
  const url = `http://127.0.0.1:${port}/`
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return { url, stop: () => new Promise((resolve) => { child.once("exit", () => resolve()); child.kill("SIGINT") }) }
    } catch {}
    if (child.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 100))
  }
  child.kill("SIGKILL")
  throw new Error(`server did not start: ${file}\n${log}`)
}

/** Starts the Cloudflare example under `wrangler dev` (local workerd) on a free port. */
export const startWrangler = async (): Promise<{ url: string; stop: () => Promise<void> }> => {
  const port = await freePort()
  const child: ChildProcess = spawn(
    "node",
    ["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "examples/cloudflare/wrangler.toml", "--port", String(port), "--ip", "127.0.0.1"],
    { cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] }
  )
  let log = ""
  child.stdout?.on("data", (chunk) => (log += chunk))
  child.stderr?.on("data", (chunk) => (log += chunk))
  const url = `http://127.0.0.1:${port}/`
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return { url, stop: () => new Promise((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM") }) }
    } catch {}
    if (child.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill("SIGKILL")
  throw new Error(`wrangler dev did not start\n${log}`)
}

/** A headless browser: Playwright's Chromium, or Chrome when that is not installed. */
export const launch = async (): Promise<Browser> => {
  try {
    return await chromium.launch({ headless: true })
  } catch (error) {
    try {
      return await chromium.launch({ headless: true, channel: "chrome" })
    } catch {
      throw new Error(`no browser available; run \`bunx playwright install chromium\`\n${String(error)}`)
    }
  }
}

export interface Harness {
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  readonly url: string
  readonly stop: () => Promise<void>
}

export const open = async (file: string): Promise<Harness> => {
  const server = await startServer(file)
  const browser = await launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(server.url)
  await page.waitForFunction(() => document.querySelector("[data-lsc-root]") !== null)
  return {
    browser,
    context,
    page,
    url: server.url,
    stop: async () => {
      await browser.close()
      await server.stop()
    }
  }
}

/** Records the tag of every element the runtime asks idiomorph to morph. */
export const traceMorphs = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    w.__morphs = []
    const original = w.lsc.morph
    w.lsc.morph = (element: Element, markup: string, options: unknown) => {
      w.__morphs.push(element.tagName + (element.id ? "#" + element.id : ""))
      return original(element, markup, options)
    }
  })

export const takeMorphs = (page: Page): Promise<Array<string>> => page.evaluate(() => (window as any).__morphs.splice(0))

export const events = (page: Page): Promise<Array<string>> => page.evaluate(() => (window as any).__events.splice(0))

/** Waits until the live session has connected (the first render arrived). */
export const connected = (page: Page) =>
  page.waitForFunction(() => !document.querySelector("[data-lsc-root]")!.hasAttribute("data-lsc-disconnected") && (window as any).lsc !== undefined)

export const settle = (page: Page, ms = 250) => page.waitForTimeout(ms)
