/**
 * Renders a `Child` tree into a wire `Node` for a session.
 *
 * Every node has a path (`r.0.2.k42.1`): array indices, or `k<key>` for keyed
 * children. Paths are stable across renders for the same tree position, and
 * are used for two things:
 *
 * - component instances live at their path, so `View.State` persists
 * - event handlers are registered under their element path, which is what
 *   the browser sends back; a click on an already re-rendered element still
 *   maps to the current handler at that position
 *
 * Elements are written inline into the current node as statics (tag,
 * attribute names) and slots (attribute values, text, handler ids), and so
 * are literal sibling lists. Dynamic arrays become lists of nodes keyed by
 * `key` or index. Components become nested nodes, so a component is a unit
 * of both identity and patching.
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
import type { Dyn, Node } from "./wire.ts"
import { fingerprint, makeList, toHtml } from "./wire.ts"

interface RenderContext {
  readonly session: Session
  readonly handlers: Map<string, Events.Handler<any>>
  readonly seen: Set<string>
}

interface Builder {
  readonly s: Array<string>
  readonly d: Array<Dyn>
}

const newBuilder = (): Builder => ({ s: [""], d: [] })

const pushStatic = (b: Builder, text: string): void => {
  b.s[b.s.length - 1] += text
}

const pushSlot = (b: Builder, dyn: Dyn): void => {
  b.d.push(dyn)
  b.s.push("")
}

const finish = (b: Builder): Node => ({ f: fingerprint(b.s), s: b.s, d: b.d })

export const rootPath = "r"

const childPath = (path: string, index: number, key: string | undefined) =>
  key === undefined ? `${path}.${index}` : `${path}.k${key}`

const keyOf = (child: Child): string | undefined => isVNode(child) && child._tag !== "Raw" ? child.key : undefined

/**
 * Renders the children of a node at `path`. A single child gets index 0, so
 * a child never shares its parent's path. A literal list of siblings
 * (`jsxs`) is inlined child by child; a dynamic array becomes a keyed list.
 */
const renderChildren = (
  ctx: RenderContext,
  b: Builder,
  children: Child,
  path: string,
  staticChildren: boolean
): Effect.Effect<void, unknown> => {
  if (!Array.isArray(children)) return renderChild(ctx, b, children, childPath(path, 0, keyOf(children)))
  if (!staticChildren) return renderList(ctx, b, children, path)
  return Effect.forEach(
    children as ReadonlyArray<Child>,
    (child, index) => renderChild(ctx, b, child, childPath(path, index, keyOf(child))),
    { discard: true }
  )
}

const renderChild = (ctx: RenderContext, b: Builder, child: Child, path: string): Effect.Effect<void, unknown> =>
  Effect.suspend(() => {
    if (child === null || child === undefined || typeof child === "boolean") {
      pushSlot(b, "")
      return Effect.void
    }
    if (typeof child === "string") {
      pushSlot(b, escapeText(child))
      return Effect.void
    }
    if (typeof child === "number") {
      pushSlot(b, String(child))
      return Effect.void
    }
    if (Array.isArray(child)) return renderList(ctx, b, child, path)
    if (isVNode(child)) return renderVNode(ctx, b, child, path)
    return Effect.die(new TypeError(`effect-lsc: cannot render value of type ${typeof child}`))
  })

const renderList = (
  ctx: RenderContext,
  b: Builder,
  children: ReadonlyArray<Child>,
  path: string
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const keys: Array<string> = []
    const items = new Map<string, Node>()
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!
      const key = keyOf(child)
      let listKey = key ?? String(index)
      while (items.has(listKey)) listKey = `${listKey}#${index}`
      const itemPath = childPath(path, index, key)
      let item: Node
      if (isVNode(child) && child._tag === "Component") {
        // A component item is its own node: no wrapper around it.
        item = yield* buildComponent(ctx, child, itemPath)
      } else {
        const builder = newBuilder()
        yield* renderChild(ctx, builder, child, itemPath)
        item = finish(builder)
      }
      keys.push(listKey)
      items.set(listKey, item)
    }
    pushSlot(b, makeList(keys, items))
  })

const renderVNode = (ctx: RenderContext, b: Builder, node: VNode, path: string): Effect.Effect<void, unknown> => {
  switch (node._tag) {
    case "Raw": {
      pushSlot(b, node.html)
      return Effect.void
    }
    case "Fragment":
      return renderChildren(ctx, b, node.children, path, node.staticChildren)
    case "Element":
      return renderElement(ctx, b, node, path)
    case "Component":
      return Effect.map(buildComponent(ctx, node, path), (own) => {
        pushSlot(b, own)
      })
  }
}

const renderElement = (
  ctx: RenderContext,
  b: Builder,
  node: Extract<VNode, { _tag: "Element" }>,
  path: string
): Effect.Effect<void, unknown> => {
  pushStatic(b, `<${node.type}`)
  for (const name of Object.keys(node.props)) {
    if (name === "children" || name === "key") continue
    const value = node.props[name]
    if (name.startsWith("on") && typeof value === "function") {
      const event = name.slice(2).toLowerCase()
      ctx.handlers.set(handlerKey(event, path), value as Events.Handler<any>)
      pushSlot(b, ` data-lsc-${event}="${escapeAttribute(path)}"`)
      continue
    }
    // The attribute is a slot even when omitted, so toggling it keeps the shape.
    pushSlot(b, renderAttribute(name, value) ?? "")
  }
  pushStatic(b, ">")
  if (voidElements.has(node.type)) return Effect.void
  return Effect.map(renderChildren(ctx, b, node.props.children, path, node.staticChildren), () => {
    pushStatic(b, `</${node.type}>`)
  })
}

/**
 * Renders a component at `path` into its own node, creating or reusing the
 * instance that lives there.
 */
const buildComponent = (
  ctx: RenderContext,
  node: Extract<VNode, { _tag: "Component" }>,
  path: string
): Effect.Effect<Node, unknown> =>
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
    const own = newBuilder()
    yield* renderChildren(ctx, own, output, path, false)
    return finish(own)
  })

/**
 * Renders `child` for `session` into a wire node. Replaces the session's
 * handler table and disposes component instances that left the tree.
 */
export const renderTree = (session: Session, child: Child): Effect.Effect<Node, unknown> =>
  Effect.gen(function*() {
    const ctx: RenderContext = { session, handlers: new Map(), seen: new Set() }
    const root = newBuilder()
    yield* renderChild(ctx, root, child, rootPath)
    session.handlers = ctx.handlers
    for (const [path, instance] of session.instances) {
      if (ctx.seen.has(path)) continue
      session.instances.delete(path)
      yield* instance.close
    }
    return finish(root)
  })

/**
 * Renders `child` for `session` to an HTML string.
 */
export const render = (session: Session, child: Child): Effect.Effect<string, unknown> =>
  Effect.map(renderTree(session, child), toHtml)
