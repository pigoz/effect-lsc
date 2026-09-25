/**
 * Renders a `Child` tree into a wire `Node` for a session.
 *
 * Every node has a path (`r.0.2.k42.1`): array indices, `k<key>` for keyed
 * children, and `f` before the fallback of a boundary. Paths are stable
 * across renders for the same tree position, and are used for two things:
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
import { Instance, type InstanceHandle, makeInstance, type Owner, shallowEqualProps } from "./instance.ts"
import type { Session } from "./session.ts"
import { handlerKey } from "./session.ts"
import type { Child, VNode } from "./vnode.ts"
import { boundaryOf, isBoundary, isVNode } from "./vnode.ts"
import type { Dyn, Node } from "./wire.ts"
import { fingerprint, makeList, toHtml } from "./wire.ts"

interface RenderContext {
  readonly session: Session
  readonly seen: Set<string>
  /** Instances taken off the session during this render, closed at its end. */
  readonly removed: Array<readonly [path: string, instance: InstanceHandle]>
  /** The instance (or the session root) whose output is being built. */
  current: Owner
  /** Handler changes, applied to the session's table when the render ends. */
  readonly added: Map<string, Events.Handler<any>>
  readonly dropped: Set<string>
}

const registerHandler = (ctx: RenderContext, key: string, handler: Events.Handler<any>): void => {
  ctx.added.set(key, handler)
  ctx.current.handlerKeys.add(key)
}

/**
 * Forgets the handlers an owner registered in its previous render. They
 * stay in the session's table until the render ends, and a handler that
 * another owner registers at the same key in this render replaces them.
 */
const forgetHandlers = (ctx: RenderContext, owner: Owner): void => {
  for (const key of owner.handlerKeys) ctx.dropped.add(key)
  owner.handlerKeys.clear()
}

/**
 * Forgets what a failed render attempt of `owner` left behind: the handlers
 * it registered, and the memoized nodes of the instances it rendered, which
 * are no longer on the page. The instances and their state stay, for the
 * next attempt.
 *
 * Without a node, those instances render again on the next attempt anyway,
 * so they are marked clean: the failed ones were left dirty, and a change
 * in one of them must still reach the boundary above, which is clean after
 * rendering its fallback.
 */
const discardAttempt = (ctx: RenderContext, owner: InstanceHandle): void => {
  for (const key of owner.handlerKeys) ctx.added.delete(key)
  forgetHandlers(ctx, owner)
  for (const path of owner.children) {
    const child = ctx.session.instances.get(path)
    if (child === undefined) continue
    child.node = undefined
    child.dirty = false
    discardAttempt(ctx, child)
  }
}

/** A reused instance keeps its subtree: mark every nested instance as seen. */
const markSeen = (ctx: RenderContext, owner: Owner): void => {
  for (const path of owner.children) {
    ctx.seen.add(path)
    const child = ctx.session.instances.get(path)
    if (child !== undefined) markSeen(ctx, child)
  }
}

/**
 * Takes an instance off the session: its handlers are forgotten and its
 * path is free for another. Its scope is closed at the end of the render.
 */
const removeInstance = (ctx: RenderContext, path: string, instance: InstanceHandle): void => {
  forgetHandlers(ctx, instance)
  ctx.session.instances.delete(path)
  ctx.removed.push([path, instance])
}

/**
 * Takes an instance off the session with everything nested inside it, as
 * of its last render. A component replaced by one of another type, or under
 * another parent, remounts its whole subtree: the instances below point to
 * it as their parent, and may hold what it provided.
 */
const removeSubtree = (ctx: RenderContext, path: string, instance: InstanceHandle): void => {
  for (const childPath of instance.children) {
    const child = ctx.session.instances.get(childPath)
    if (child !== undefined) removeSubtree(ctx, childPath, child)
  }
  removeInstance(ctx, path, instance)
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

const finish = (b: Builder, e: boolean): Node => ({ f: fingerprint(b.s), s: b.s, d: b.d, e })

const isElement = (child: Child): boolean => isVNode(child) && child._tag === "Element"

export const rootPath = "r"

const childPath = (path: string, index: number, key: string | undefined) =>
  key === undefined ? `${path}.${index}` : `${path}.k${key}`

/** Where a boundary renders its fallback: beside its children, never at their paths. */
const fallbackPath = (path: string) => `${path}.f`

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
        item = finish(builder, isElement(child))
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
      registerHandler(ctx, handlerKey(event, path), value as Events.Handler<any>)
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
 * A boundary replaced by another wrapper of the same component remounts,
 * losing its state. The renderer cannot tell two module-level wrappers
 * swapped at one path from a helper applied during a render
 * (`View.use(View.orDie(Item))` in a body), which creates a new component
 * on every render and remounts it every time. The warning fits both.
 */
const warnRemount = (previous: unknown, next: unknown, path: string): Effect.Effect<void> =>
  isBoundary(previous) && isBoundary(next) && boundaryOf(previous).render === boundaryOf(next).render
    ? Effect.logWarning(
      `effect-lsc: the component at ${path} was replaced by another wrapper of the same component ` +
        "and remounted, losing its state; if the wrapper is created during a render, define it at module level"
    )
    : Effect.void

/**
 * Renders a component at `path` into its own node, creating or reusing the
 * instance that lives there. An instance that is not dirty and receives the
 * same props returns the node of its previous render, subtree and handlers
 * included.
 */
const buildComponent = (
  ctx: RenderContext,
  node: Extract<VNode, { _tag: "Component" }>,
  path: string
): Effect.Effect<Node, unknown> =>
  Effect.gen(function*() {
    const parent = ctx.current === ctx.session.root ? undefined : ctx.current as InstanceHandle
    let instance = ctx.session.instances.get(path)
    // Another type remounts, and so does the same type under another parent
    // (`q ? <Q /> : <div><C /></div>`, where Q renders `<C />`): a reused C
    // would still invalidate its old parent, and hold what that provided.
    if (instance !== undefined && (instance.type !== node.type || instance.parent !== parent)) {
      if (instance.type !== node.type) yield* warnRemount(instance.type, node.type, path)
      removeSubtree(ctx, path, instance)
      instance = undefined
    }
    if (instance === undefined) {
      const scope = yield* Scope.fork(ctx.session.scope)
      const dirty = ctx.session.dirty
      const wake = () => {
        Queue.offerUnsafe(dirty, undefined)
      }
      instance = makeInstance(node.type, scope, parent, ctx.session.connected, wake)
      ctx.session.instances.set(path, instance)
    }
    ctx.current.children.add(path)
    ctx.seen.add(path)
    if (!instance.dirty && instance.node !== undefined && shallowEqualProps(instance.props, node.props)) {
      markSeen(ctx, instance)
      return instance.node
    }
    forgetHandlers(ctx, instance)
    instance.children.clear()
    instance.dirty = false
    instance.props = node.props
    instance.reset()
    const owner = ctx.current
    ctx.current = instance
    const current = instance
    const boundary = isBoundary(node.type) ? boundaryOf(node.type) : undefined
    const body = Effect.gen(function*() {
      const result = boundary !== undefined ? boundary.render(node.props) : node.type(node.props)
      const output: Child = Effect.isEffect(result)
        ? yield* Effect.provideService(result as Effect.Effect<Child, unknown, Instance>, Instance, current)
        : result
      const own = newBuilder()
      yield* renderChildren(ctx, own, output, path, false)
      return finish(own, isElement(output))
    })
    const recover = boundary?.recover
    const guarded = recover === undefined ? body : Effect.catchCause(body, (cause) =>
      Effect.gen(function*() {
        // The subtree failed: forget what the failed attempt registered and
        // render the fallback in its place. The instances it reached are
        // kept; the boundary re-renders (and retries) when its subtree
        // changes. The fallback has paths of its own, so its components
        // never replace them. A failing recovery passes the failure to the
        // next boundary up.
        discardAttempt(ctx, current)
        const recovered = recover(cause, node.props)
        const fallback: Child = Effect.isEffect(recovered) ? yield* (recovered as Effect.Effect<Child, unknown>) : recovered
        const own = newBuilder()
        yield* renderChildren(ctx, own, fallback, fallbackPath(path), false)
        return finish(own, isElement(fallback))
      }))
    // `wrap` runs the whole render, recovery included, with the boundary's
    // Instance, so its slots are the boundary's and what it provides
    // (View.provide) reaches the whole subtree.
    const wrap = boundary?.wrap
    const rendered = wrap === undefined ? guarded : Effect.provideService(wrap(guarded, node.props), Instance, current)
    return yield* rendered.pipe(
      Effect.tapCause(() =>
        Effect.sync(() => {
          // A failed render must not be memoized: forget the node and stay
          // dirty, so the next render runs the body again.
          current.dirty = true
          current.node = undefined
        })
      ),
      Effect.ensuring(Effect.sync(() => {
        ctx.current = owner
      })),
      Effect.map((own) => {
        current.node = own
        return own
      })
    )
  })

/**
 * Renders `child` for `session` into a wire node. Updates the session's
 * handler table when the render ends, failed or not, and disposes component
 * instances that left the tree.
 */
export const renderTree = (session: Session, child: Child): Effect.Effect<Node, unknown> =>
  Effect.gen(function*() {
    const ctx: RenderContext = {
      session,
      seen: new Set(),
      removed: [],
      current: session.root,
      added: new Map(),
      dropped: new Set()
    }
    forgetHandlers(ctx, session.root)
    session.root.children.clear()
    const root = newBuilder()
    // Events are handled on another fiber, and a render can wait (View.result)
    // or yield. Until it ends, events find the handlers of the previous
    // render, which match the page the browser has. Dropped keys go first,
    // so a key that a removed owner shares with a new one keeps the new one.
    const commit = Effect.sync(() => {
      for (const key of ctx.dropped) session.handlers.delete(key)
      for (const [key, handler] of ctx.added) session.handlers.set(key, handler)
    })
    yield* renderChild(ctx, root, child, rootPath).pipe(
      Effect.andThen(Effect.sync(() => {
        for (const [path, instance] of session.instances) {
          if (!ctx.seen.has(path)) removeInstance(ctx, path, instance)
        }
      })),
      Effect.ensuring(commit)
    )
    // Deepest first: a descendant's path extends its ancestor's, and its
    // finalizers may still use what the ancestor provides (View.provide).
    // The page no longer has them, so a failing finalizer is only logged.
    ctx.removed.sort((a, b) => b[0].length - a[0].length)
    yield* Effect.forEach(
      ctx.removed,
      ([path, instance]) =>
        Effect.catchCause(
          instance.close,
          (cause) => Effect.logError(`effect-lsc: a finalizer of the component at ${path} failed`, cause)
        ),
      { discard: true }
    )
    return finish(root, false)
  })

/**
 * Renders `child` for `session` to an HTML string.
 */
export const render = (session: Session, child: Child): Effect.Effect<string, unknown> =>
  Effect.map(renderTree(session, child), toHtml)
