/**
 * `Island`: a boundary where another client-side renderer owns the DOM.
 *
 * The server renders a container with the island's name and its props as
 * JSON, around a mount point the browser runtime never morphs. In the
 * page, `lsc.island(name, { mount, update, unmount })` receives the mount
 * point and the props, and is called again whenever the props change.
 * Everything else on the page stays server-driven.
 */
import type { Child, VNode } from "./vnode.ts"
import { jsx } from "./vnode.ts"

export interface IslandProps {
  /** The renderer registered in the page with `lsc.island(name, …)`. */
  readonly name: string
  /** Serialized as JSON and handed to `mount`, then to `update` on change. */
  readonly props?: unknown
  /** Element for the container; `div` by default. */
  readonly tag?: string | undefined
  readonly class?: string | undefined
  /** Server-rendered content of the mount point, shown until the renderer takes over. */
  readonly children?: Child
}

export const Island = (p: IslandProps): VNode =>
  jsx(p.tag ?? "div", {
    "data-lsc-island": p.name,
    "data-lsc-props": JSON.stringify(p.props ?? null),
    class: p.class,
    children: jsx("div", { "data-lsc-ignore": true, children: p.children })
  })
