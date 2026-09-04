/**
 * A component instance: the server-side identity of one component at one
 * position in the rendered tree. It owns a `Scope` and a list of slots.
 *
 * Slots are what make `View.State` persist across renders: the first render
 * creates the slot, later renders reuse it in call order. This is the same
 * contract as hooks (call `View.State` unconditionally, in the same order).
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"

export interface InstanceShape {
  /** Closed when the component leaves the tree or the session ends. */
  readonly scope: Scope.Scope
  /** Returns the slot at the current cursor, creating it on the first render. */
  readonly slot: <A>(create: Effect.Effect<A, never, Scope.Scope>) => Effect.Effect<A>
  /** Requests a re-render of the session this instance belongs to. */
  readonly invalidate: Effect.Effect<void>
}

export class Instance extends Context.Service<Instance, InstanceShape>()("effect-lsc/View/Instance") {}

export interface InstanceHandle extends InstanceShape {
  /** The component function this instance was created for. */
  readonly type: unknown
  /** Resets the slot cursor. Called before every render of the instance. */
  readonly reset: () => void
  readonly close: Effect.Effect<void>
}

export const makeInstance = (
  type: unknown,
  scope: Scope.Closeable,
  invalidate: Effect.Effect<void>
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
  return {
    type,
    scope,
    slot,
    invalidate,
    reset: () => {
      cursor = 0
    },
    close: Scope.close(scope, Exit.void)
  }
}
