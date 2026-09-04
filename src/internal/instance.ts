/**
 * A component instance: the server-side identity of one component at one
 * position in the rendered tree. It owns a `Scope`, a list of slots, and
 * the memo of its last render.
 *
 * Slots are what make `View.State` persist across renders: the first render
 * creates the slot, later renders reuse it in call order. This is the same
 * contract as hooks (call `View.State` unconditionally, in the same order).
 *
 * An instance is re-rendered only when it is dirty (its state or a watched
 * ref changed, or a descendant's did) or when it receives different props;
 * otherwise its previous node is reused as is, handlers included.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import type { Props } from "./vnode.ts"
import type { Node } from "./wire.ts"

export interface InstanceShape {
  /** Closed when the component leaves the tree or the session ends. */
  readonly scope: Scope.Scope
  /** Returns the slot at the current cursor, creating it on the first render. */
  readonly slot: <A>(create: Effect.Effect<A, never, Scope.Scope>) => Effect.Effect<A>
  /** Marks the instance and its ancestors for re-render and wakes the session. */
  readonly invalidate: Effect.Effect<void>
}

export class Instance extends Context.Service<Instance, InstanceShape>()("effect-lsc/View/Instance") {}

/**
 * What a render owner tracks: the handlers registered by its own elements
 * and the instances nested directly inside it. The session root is an owner
 * too, for elements outside any component.
 */
export interface Owner {
  readonly handlerKeys: Set<string>
  readonly children: Set<string>
}

export interface InstanceHandle extends InstanceShape, Owner {
  /** The component function this instance was created for. */
  readonly type: unknown
  readonly parent: InstanceHandle | undefined
  dirty: boolean
  /** Props and node of the last render, for memoization. */
  props: Props | undefined
  node: Node | undefined
  /** Resets the slot cursor. Called before every render of the instance. */
  readonly reset: () => void
  readonly close: Effect.Effect<void>
}

export const makeInstance = (
  type: unknown,
  scope: Scope.Closeable,
  parent: InstanceHandle | undefined,
  wake: Effect.Effect<void>
): InstanceHandle => {
  const slots: Array<unknown> = []
  let cursor = 0
  const slot = <A>(create: Effect.Effect<A, never, Scope.Scope>): Effect.Effect<A> =>
    Effect.suspend(() => {
      const index = cursor++
      if (index < slots.length) return Effect.succeed(slots[index] as A)
      return Effect.map(Scope.provide(create, scope), (value) => {
        slots.push(value)
        return value
      })
    })
  const handle: InstanceHandle = {
    type,
    parent,
    scope,
    slot,
    dirty: true,
    props: undefined,
    node: undefined,
    handlerKeys: new Set(),
    children: new Set(),
    invalidate: Effect.suspend(() => {
      // dirty(instance) implies dirty(ancestors): stop at the first dirty one
      let current: InstanceHandle | undefined = handle
      while (current !== undefined && !current.dirty) {
        current.dirty = true
        current = current.parent
      }
      return wake
    }),
    reset: () => {
      cursor = 0
    },
    close: Scope.close(scope, Exit.void)
  }
  return handle
}

export const shallowEqualProps = (a: Props | undefined, b: Props): boolean => {
  if (a === undefined) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || a[key] !== b[key]) return false
  }
  return true
}
