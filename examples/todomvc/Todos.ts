import { Context, Effect, Layer, SubscriptionRef } from "effect"

export interface Todo {
  readonly id: number
  readonly title: string
  readonly completed: boolean
}

/**
 * Shared application state: one list for the whole process, so every
 * connected browser sees the same todos and every change is pushed to all
 * of them. Components depend on it through `View.watch(todos.ref)`.
 */
export class Todos extends Context.Service<Todos, {
  readonly ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<Todo>>
  readonly add: (title: string) => Effect.Effect<void>
  readonly toggle: (id: number) => Effect.Effect<void>
  readonly toggleAll: (completed: boolean) => Effect.Effect<void>
  readonly edit: (id: number, title: string) => Effect.Effect<void>
  readonly remove: (id: number) => Effect.Effect<void>
  readonly clearCompleted: Effect.Effect<void>
}>()("todomvc/Todos") {
  static readonly layer = Layer.effect(
    Todos,
    Effect.gen(function*() {
      const ref = yield* SubscriptionRef.make<ReadonlyArray<Todo>>([])
      let nextId = 1
      const update = (f: (todos: ReadonlyArray<Todo>) => ReadonlyArray<Todo>) => SubscriptionRef.update(ref, f)
      const patch = (id: number, f: (todo: Todo) => Todo) =>
        update((todos) => todos.map((todo) => todo.id === id ? f(todo) : todo))
      return Todos.of({
        ref,
        add: (title) => update((todos) => [...todos, { id: nextId++, title, completed: false }]),
        toggle: (id) => patch(id, (todo) => ({ ...todo, completed: !todo.completed })),
        toggleAll: (completed) => update((todos) => todos.map((todo) => ({ ...todo, completed }))),
        edit: (id, title) => patch(id, (todo) => ({ ...todo, title })),
        remove: (id) => update((todos) => todos.filter((todo) => todo.id !== id)),
        clearCompleted: update((todos) => todos.filter((todo) => !todo.completed))
      })
    })
  )
}
