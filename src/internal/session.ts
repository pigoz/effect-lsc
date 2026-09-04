/**
 * A session is one live page: the set of component instances rendered for a
 * connection, the handlers registered by the latest render, the tree the
 * browser currently holds, and a "dirty" signal that requests a re-render.
 *
 * The dirty signal is a sliding queue of capacity 1, so any number of state
 * changes between two renders collapse into a single re-render.
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import type * as Events from "./events.ts"
import type { InstanceHandle, Owner } from "./instance.ts"
import type { ClientEvent } from "./protocol.ts"
import type { Node } from "./wire.ts"

export interface Session {
  readonly scope: Scope.Scope
  /** `true` for a live session over a socket, `false` for the HTTP render. */
  readonly connected: boolean
  readonly dirty: Queue.Queue<void>
  readonly instances: Map<string, InstanceHandle>
  /** Handlers by `event:path`, maintained incrementally by the renderer. */
  readonly handlers: Map<string, Events.Handler<any>>
  /** Owner of elements and instances outside any component. */
  readonly root: Owner
  /** The tree the browser has, `undefined` before the first render. */
  tree: Node | undefined
  /** Fingerprints whose statics the browser already has. */
  readonly sentStatics: Set<string>
}

export const makeSession = (connected: boolean = true): Effect.Effect<Session, never, Scope.Scope> => Effect.gen(function*() {
  const scope = yield* Effect.scope
  const dirty = yield* Queue.sliding<void>(1)
  const instances = new Map<string, InstanceHandle>()
  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() => Effect.forEach(instances.values(), (instance) => instance.close, { discard: true }))
  )
  return {
    scope,
    connected,
    dirty,
    instances,
    handlers: new Map(),
    root: { handlerKeys: new Set(), children: new Set() },
    tree: undefined,
    sentStatics: new Set()
  }
})

export const handlerKey = (event: string, id: string): string => `${event}:${id}`

/**
 * Runs the handler registered for a client event. Unknown ids are ignored:
 * they usually belong to a DOM that has since been re-rendered. A failing
 * handler (typed error or defect) is logged and passed to `report`; the
 * session goes on. State it changed before failing stays changed.
 */
export const dispatch = (
  session: Session,
  event: ClientEvent,
  report: (cause: Cause.Cause<unknown>) => Effect.Effect<void> = () => Effect.void
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const handler = session.handlers.get(handlerKey(event.type, event.id))
    if (handler === undefined) {
      return Effect.logDebug(`effect-lsc: no handler for ${event.type} at ${event.id}`)
    }
    const { id: _id, t: _t, ...payload } = event
    return Effect.suspend(() => {
      const result = handler(payload)
      return Effect.isEffect(result) ? result : Effect.void
    }).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? Effect.andThen(
            Effect.logError(`effect-lsc: ${event.type} handler at ${event.id} failed`, exit.cause),
            report(exit.cause)
          )
          : Effect.void
      )
    )
  })
