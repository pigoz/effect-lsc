# Shared counter on Cloudflare

From the repository root, run `bun install`, then `bun run shared-counter-cloudflare`.
Or run `bunx wrangler dev` from this directory. Open http://localhost:8787
in two tabs: the total is shared, while each tab has its own click count.

`src/index.tsx` contains the component, state service, Durable Object and
Worker handler. `wrangler.toml` defines the binding. Dependencies and the
base TypeScript configuration come from the repository.

All visitors use one Durable Object named `global`. State is held in memory
and can be lost when the object restarts; no durable storage is used.
