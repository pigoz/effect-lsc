import { Effect } from "effect"
import { View } from "effect-lsc/view"
import { type Todo, Todos } from "./Todos.ts"

type Filter = "all" | "active" | "completed"

const filters: ReadonlyArray<{ readonly id: Filter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" }
]

export const App = View.Component(function*() {
  const todos = yield* Todos
  // Shared state: re-renders this session whenever the list changes,
  // no matter which session (browser tab) changed it.
  const all = yield* View.watch(todos.ref)
  // Component-local state: each browser tab has its own filter.
  const filter = yield* View.State<Filter>("all")

  // Derived state is just computation: the body re-runs on every change.
  const remaining = all.filter((todo) => !todo.completed).length
  const visible = all.filter((todo) =>
    filter.value === "all" ? true : filter.value === "active" ? !todo.completed : todo.completed
  )

  return (
    <section class="todoapp">
      <NewTodo />
      {all.length > 0 && (
        <>
          <main class="main">
            <div class="toggle-all-container">
              <input
                id="toggle-all"
                class="toggle-all"
                type="checkbox"
                checked={remaining === 0}
                onChange={(e) => todos.toggleAll(e.checked === true)}
              />
              <label for="toggle-all">Mark all as complete</label>
            </div>
            <ul class="todo-list">
              {visible.map((todo) => <TodoItem key={todo.id} todo={todo} />)}
            </ul>
          </main>
          <Footer remaining={remaining} completed={all.length - remaining} filter={filter} />
        </>
      )}
    </section>
  )
})

const NewTodo = View.Component(function*() {
  const todos = yield* Todos
  return (
    <header class="header">
      <h1>todos</h1>
      <form
        onSubmit={(e) => {
          const title = (e.form.title ?? "").trim()
          return title.length > 0 ? todos.add(title) : undefined
        }}
      >
        <input class="new-todo" name="title" placeholder="What needs to be done?" autofocus autocomplete="off" />
      </form>
    </header>
  )
})

const TodoItem = View.Component(function*(props: { readonly todo: Todo }) {
  const todos = yield* Todos
  const editing = yield* View.State(false)
  const { todo } = props

  const commit = (title: string) =>
    Effect.gen(function*() {
      const trimmed = title.trim()
      yield* trimmed.length === 0 ? todos.remove(todo.id) : todos.edit(todo.id, trimmed)
      yield* editing.set(false)
    })

  return (
    <li class={[todo.completed && "completed", editing.value && "editing"]}>
      <div class="view">
        <input class="toggle" type="checkbox" checked={todo.completed} onChange={() => todos.toggle(todo.id)} />
        <label onDblClick={() => editing.set(true)}>{todo.title}</label>
        <button class="destroy" onClick={() => todos.remove(todo.id)}></button>
      </div>
      {editing.value && (
        <input
          class="edit"
          value={todo.title}
          autofocus
          onKeyDown={(e) =>
            e.key === "Enter" ? commit(e.value ?? "") : e.key === "Escape" ? editing.set(false) : undefined}
          onBlur={(e) => editing.value ? commit(e.value ?? "") : undefined}
        />
      )}
    </li>
  )
})

const Footer = View.Component(function*(props: {
  readonly remaining: number
  readonly completed: number
  readonly filter: View.State<Filter>
}) {
  const todos = yield* Todos
  return (
    <footer class="footer">
      <span class="todo-count">
        <strong>{props.remaining}</strong> {props.remaining === 1 ? "item" : "items"} left
      </span>
      <ul class="filters">
        {filters.map((f) => (
          <li key={f.id}>
            <a
              class={props.filter.value === f.id ? "selected" : undefined}
              href={`#/${f.id}`}
              onClick={() => props.filter.set(f.id)}
            >
              {f.label}
            </a>
          </li>
        ))}
      </ul>
      {props.completed > 0 && (
        <button class="clear-completed" onClick={() => todos.clearCompleted}>Clear completed</button>
      )}
    </footer>
  )
})
