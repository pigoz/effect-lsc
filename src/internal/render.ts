/**
 * Renders a `Child` tree to an HTML string for a session.
 *
 * Every node has a path (`r.0.2.k42.1`): array indices, or `k<key>` for keyed
 * children. Paths are stable across renders for the same tree position, and
 * are used for two things:
 *
 * - component instances live at their path, so `View.State` persists
 * - event handlers are registered under their element path, which is what
 *   the browser sends back; a click on an already re-rendered element still
 *   maps to the current handler at that position
 */
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import type * as Events from "./events.ts"
import { escapeAttribute, escapeText, renderAttribute, voidElements } from "./html.ts"
import { Instance, makeInstance } from "./instance.ts"
import type { Session } from "./session.ts"
import { handlerKey } from "./session.ts"
import type { Child, VNode } from "./vnode.ts"
import { isVNode } from "./vnode.ts"

interface RenderContext {
  readonly session: Session
  readonly handlers: Map<string, Events.Handler<any>>
  readonly seen: Set<string>
  readonly out: Array<string>
}

export const rootPath = "r"

const childPath = (path: string, index: number, key: string | undefined) =>
  key === undefined ? `${path}.${index}` : `${path}.k${key}`

const keyOf = (child: Child): string | undefined => isVNode(child) && child._tag !== "Raw" ? child.key : undefined

/**
 * Renders the children of a node at `path`. Arrays index their items; a
 * single child gets index 0, so a child never shares its parent's path.
 */
const renderChildren = (ctx: RenderContext, children: Child, path: string): Effect.Effect<void, unknown> =>
  Array.isArray(children)
    ? renderChild(ctx, children, path)
    : renderChild(ctx, children, childPath(path, 0, keyOf(children)))

const renderChild = (ctx: RenderContext, child: Child, path: string): Effect.Effect<void, unknown> =>
  Effect.suspend(() => {
    if (child === null || child === undefined || typeof child === "boolean") return Effect.void
    if (typeof child === "string") {
      ctx.out.push(escapeText(child))
      return Effect.void
    }
    if (typeof child === "number") {
      ctx.out.push(String(child))
      return Effect.void
    }
    if (Array.isArray(child)) {
      return Effect.forEach(
        child as ReadonlyArray<Child>,
        (item, index) => renderChild(ctx, item, childPath(path, index, keyOf(item))),
        { discard: true }
      )
    }
    if (isVNode(child)) return renderVNode(ctx, child, path)
    return Effect.die(new TypeError(`effect-lsc: cannot render value of type ${typeof child}`))
  })

const renderVNode = (ctx: RenderContext, node: VNode, path: string): Effect.Effect<void, unknown> => {
  switch (node._tag) {
    case "Raw": {
      ctx.out.push(node.html)
      return Effect.void
    }
    case "Fragment":
      return renderChildren(ctx, node.children, path)
    case "Element":
      return renderElement(ctx, node, path)
    case "Component":
      return renderComponent(ctx, node, path)
  }
}

const renderElement = (
  ctx: RenderContext,
  node: Extract<VNode, { _tag: "Element" }>,
  path: string
): Effect.Effect<void, unknown> => {
  const { out } = ctx
  out.push(`<${node.type}`)
  for (const name of Object.keys(node.props)) {
    if (name === "children" || name === "key") continue
    const value = node.props[name]
    if (name.startsWith("on") && typeof value === "function") {
      const event = name.slice(2).toLowerCase()
      ctx.handlers.set(handlerKey(event, path), value as Events.Handler<any>)
      out.push(` data-lsc-${event}="${escapeAttribute(path)}"`)
      continue
    }
    const rendered = renderAttribute(name, value)
    if (rendered !== undefined) out.push(rendered)
  }
  out.push(">")
  if (voidElements.has(node.type)) return Effect.void
  return Effect.map(renderChildren(ctx, node.props.children, path), () => {
    out.push(`</${node.type}>`)
  })
}

const renderComponent = (
  ctx: RenderContext,
  node: Extract<VNode, { _tag: "Component" }>,
  path: string
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    let instance = ctx.session.instances.get(path)
    if (instance !== undefined && instance.type !== node.type) {
      yield* instance.close
      ctx.session.instances.delete(path)
      instance = undefined
    }
    if (instance === undefined) {
      const scope = yield* Scope.fork(ctx.session.scope)
      const invalidate = Effect.asVoid(Queue.offer(ctx.session.dirty, undefined))
      instance = makeInstance(node.type, scope, invalidate)
      ctx.session.instances.set(path, instance)
    }
    ctx.seen.add(path)
    instance.reset()
    const result = node.type(node.props)
    const output: Child = Effect.isEffect(result)
      ? yield* Effect.provideService(result as Effect.Effect<Child, unknown, Instance>, Instance, instance)
      : result
    yield* renderChildren(ctx, output, path)
  })

/**
 * Renders `child` for `session`. Replaces the session's handler table and
 * disposes component instances that are no longer in the tree.
 */
export const render = (session: Session, child: Child): Effect.Effect<string, unknown> =>
  Effect.gen(function*() {
    const ctx: RenderContext = { session, handlers: new Map(), seen: new Set(), out: [] }
    yield* renderChild(ctx, child, rootPath)
    session.handlers = ctx.handlers
    for (const [path, instance] of session.instances) {
      if (ctx.seen.has(path)) continue
      session.instances.delete(path)
      yield* instance.close
    }
    return ctx.out.join("")
  })
