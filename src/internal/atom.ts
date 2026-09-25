/**
 * Effect Atom integration: the only module that imports
 * `effect/unstable/reactivity` at runtime (view.ts imports its types).
 *
 * Atoms live in an `AtomRegistry` taken from the Effect context, like any
 * other service: a component that watches an atom has `AtomRegistry` in its
 * requirements, and the application provides `AtomRegistry.layer` (one
 * registry per server process, or per Durable Object).
 */
import * as Effect from "effect/Effect"
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import { follow, Instance } from "./instance.ts"

export const isAtom: (u: unknown) => u is Atom.Atom<any> = Atom.isAtom

/**
 * Subscribes the current instance to `atom` in `registry` for as long as the
 * instance lives. The node is built before subscribing: `subscribe` alone
 * does not build a lazy node (its dependencies would not be tracked, so it
 * would never notify), and building it after subscribing would notify the
 * new listener and schedule a useless re-render.
 */
const track = <A>(atom: Atom.Atom<A>): Effect.Effect<AtomRegistry.AtomRegistry, never, Instance | AtomRegistry.AtomRegistry> =>
  Effect.gen(function*() {
    const instance = yield* Instance
    const registry = yield* AtomRegistry.AtomRegistry
    yield* follow(
      instance,
      [registry, atom],
      Effect.sync(() => {
        registry.get(atom)
        const unsubscribe = registry.subscribe(atom, instance.invalidateUnsafe)
        return Effect.sync(unsubscribe)
      })
    )
    return registry
  })

export const watchAtom = <A>(atom: Atom.Atom<A>): Effect.Effect<A, never, Instance | AtomRegistry.AtomRegistry> =>
  Effect.map(track(atom), (registry) => registry.get(atom))

export const result = <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: { readonly suspendOnWaiting?: boolean | undefined }
): Effect.Effect<A, E, Instance | AtomRegistry.AtomRegistry> =>
  Effect.flatMap(track(atom), (registry) => AtomRegistry.getResult(registry, atom, options))
