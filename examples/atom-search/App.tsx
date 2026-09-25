// Search as you type, with Effect atoms. The query is local to each tab
// (View.State); results are atoms shared by every tab of the server: two
// tabs typing the same query share one backend call, and a result stays
// cached for 30 seconds after the last tab stops showing it.
import { Context, Data, Effect, Layer } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import { View } from "effect-lsc/view"

const fruits = ["apple", "apricot", "banana", "blueberry", "cherry", "grape", "mango", "orange", "papaya", "pear"]

export class TooShort extends Data.TaggedError("TooShort")<{ readonly query: string }> {}

/** Application state shared by every tab. keepAlive: it stays even when nobody watches it. */
export const backendCalls = Atom.make(0).pipe(Atom.keepAlive)
export const saved = Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive)

/** The backend needs two letters, and Save keeps only such queries. */
const searchable = (query: string) => query.length >= 2

/** A slow backend, as an ordinary Effect service. */
export class Catalog extends Context.Service<Catalog, {
  readonly search: (query: string) => Effect.Effect<ReadonlyArray<string>, TooShort>
}>()("atom-search/Catalog") {
  static readonly layer = Layer.effect(
    Catalog,
    Effect.gen(function*() {
      const registry = yield* AtomRegistry.AtomRegistry
      return Catalog.of({
        search: (query) =>
          !searchable(query)
            ? Effect.fail(new TooShort({ query }))
            : Effect.sleep("300 millis").pipe(
              // Counted after the first async step: a write before it would
              // land inside the render that starts the search.
              Effect.tap(() => Effect.sync(() => registry.update(backendCalls, (n) => n + 1))),
              Effect.as(fruits.filter((fruit) => fruit.includes(query)))
            )
      })
    })
  )
}

// Effectful atoms get their services from an atom runtime, built once per registry.
const runtime = Atom.runtime(Catalog.layer).pipe(Atom.keepAlive)

/**
 * One atom per query. Its Effect starts when a tab first watches it and runs
 * to completion, and the result stays cached for 30 s after the last tab
 * stops watching it. There is no debounce: every prefix of two or more
 * letters calls the backend.
 */
export const results = Atom.family((query: string) =>
  runtime.atom(Effect.gen(function*() {
    const catalog = yield* Catalog
    return yield* catalog.search(query)
  })).pipe(Atom.setIdleTTL("30 seconds"))
)

const Results = View.Component(function*(props: { readonly query: string }) {
  // A different query is a different atom: the watch slot follows it.
  const result = yield* View.watch(results(props.query))
  return AsyncResult.builder(result)
    .onInitial(() => <p>Searching…</p>)
    .onErrorTag("TooShort", () => <p>Type at least two letters.</p>)
    .onDefect(() => <p>Search failed.</p>)
    .onInterrupt(() => <p>Search cancelled.</p>)
    .onSuccess((items) =>
      items.length === 0 ? <p>No fruit.</p> : <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    )
    .exhaustive()
})

export const Search = View.Component(function*() {
  // Handlers cannot require services: take the registry here, write through it there.
  const registry = yield* AtomRegistry.AtomRegistry
  const query = yield* View.State("")
  const favourites = yield* View.watch(saved)
  const calls = yield* View.watch(backendCalls)
  // Results needs AtomRegistry, so it is brought in with View.use.
  const Found = yield* View.use(Results)

  const save = () =>
    registry.update(saved, (all) => !searchable(query.value) || all.includes(query.value) ? all : [...all, query.value])

  return (
    <main>
      <input
        value={query.value}
        onInput={(e) => query.set(e.value.trim().toLowerCase())}
        placeholder="Search fruit"
        autofocus
      />
      <button id="save" onClick={save}>Save search</button>
      <Found query={query.value} />
      <p id="saved">
        Saved by every tab: {favourites.map((q) => <button key={q} onClick={() => query.set(q)}>{q}</button>)}
      </p>
      <p id="calls">Backend calls: {calls}</p>
    </main>
  )
})
