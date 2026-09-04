import { Context, Effect, Layer } from "effect"
import { View } from "effect-lsc/view"

export interface Todo {
  readonly id: number
  readonly title: string
  readonly completed: boolean
}

/**
 * Shared application state: one list for the whole process, so every
 * connected browser sees the same todos and every change is pushed to all
 * of them. Components depend on it through `View.watch(todos.all)`.
 */
export class Todos extends Context.Service<Todos, {
  readonly all: View.SharedState<ReadonlyArray<Todo>>
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
      const all = yield* View.SharedState<ReadonlyArray<Todo>>([])
      let nextId = 1
      const patch = (id: number, f: (todo: Todo) => Todo) =>
        all.update((todos) => todos.map((todo) => todo.id === id ? f(todo) : todo))
      return Todos.of({
        all,
        add: (title) => all.update((todos) => [...todos, { id: nextId++, title, completed: false }]),
        toggle: (id) => patch(id, (todo) => ({ ...todo, completed: !todo.completed })),
        toggleAll: (completed) => all.update((todos) => todos.map((todo) => ({ ...todo, completed }))),
        edit: (id, title) => patch(id, (todo) => ({ ...todo, title })),
        remove: (id) => all.update((todos) => todos.filter((todo) => todo.id !== id)),
        clearCompleted: all.update((todos) => todos.filter((todo) => !todo.completed))
      })
    })
  )
}
