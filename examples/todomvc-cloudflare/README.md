# TodoMVC on Cloudflare

From the repository root, install dependencies with `bun install`, then run:

```sh
bun run todomvc-cloudflare
```

Or run `bunx wrangler dev` from this directory. Open http://localhost:8787
in two tabs: adding, editing, completing and deleting todos updates both.
The filter and the item being edited are local to each tab.

All application code is here; there are no imports from other examples:

- `src/index.tsx` routes requests to one Durable Object and provides the service.
- `src/Todos.ts` holds the shared list and its operations.
- `src/App.tsx` renders the list, new-todo form and filters.
- `src/TodoItem.tsx` handles an individual todo and its editing state.
- `src/layout.tsx` provides the HTML document and TodoMVC styles.
- `wrangler.toml` configures the Worker and Durable Object binding.

Dependencies and the base TypeScript configuration come from the repository.
The styles load from the TodoMVC CDN stylesheets in `layout.tsx`.

`Todos.layer` is built once per Durable Object. All requests use the room
named `global`, so all visitors share one list. Data lives in memory: it can
be lost when the object restarts; this example does not use durable storage.
WebSocket sessions use the classic API and keep the object awake while connected.
