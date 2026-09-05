import { Effect } from "effect"
import { View } from "effect-lsc/view"
import { type Todo, Todos } from "./Todos.ts"

export const TodoItem = View.Component(function*(props: { readonly todo: Todo }) {
  const todos = yield* Todos
  const editing = yield* View.State(false)
  const { todo } = props

  const commit = (title: string) =>
    Effect.gen(function*() {
      const trimmed = title.trim()
      if (trimmed.length === 0) {
        yield* todos.remove(todo.id)
      } else {
        yield* todos.edit(todo.id, trimmed)
      }
      yield* editing.set(false)
    })

  return (
    <li class={[todo.completed && "completed", editing.value && "editing"]}>
      <div class="view">
        <input class="toggle" type="checkbox" checked={todo.completed} onChange={() => todos.toggle(todo.id)} />
        <label onDblClick={() => editing.set(true)}>{todo.title}</label>
        <button class="destroy" aria-label={`Delete ${todo.title}`} onClick={() => todos.remove(todo.id)}></button>
      </div>
      {editing.value && (
        <input
          class="edit"
          value={todo.title}
          autofocus
          onKeyDown={(event) => {
            if (event.key === "Enter") return commit(event.value ?? "")
            if (event.key === "Escape") return editing.set(false)
          }}
          onBlur={(e) => editing.value ? commit(e.value ?? "") : undefined}
        />
      )}
    </li>
  )
})
