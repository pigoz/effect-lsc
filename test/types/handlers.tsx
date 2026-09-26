// Type tests: what an event handler may return. Like a root, a handler
// leaves no typed error unhandled (E = never); defects are still allowed.
// Checked by `bun run check`; every @ts-expect-error must hide a real error.
import { Effect } from "effect"
import { View } from "effect-lsc/view"
import type { Denied, NotFound } from "./util.ts"

declare const load: (id: string) => Effect.Effect<string, NotFound>
declare const save: (form: Readonly<Record<string, string>>) => Effect.Effect<void, NotFound | Denied>

// nothing, or an Effect that cannot fail
export const Accepted = View.Component(function*() {
  const n = yield* View.State(0)
  return (
    <main>
      <button onClick={() => {}}>void</button>
      <button onClick={() => n.update((x) => x + 1)}>state</button>
      <button onClick={() => Effect.log("clicked")}>log</button>
      <button onClick={() => Effect.die("bug")}>defect</button>
      <input onInput={(e) => e.value === "" ? undefined : n.set(e.value.length)} />
    </main>
  )
})

// a typed error is rejected; the same handler, handled, is accepted
// @ts-expect-error NotFound is not handled
export const fails = <button onClick={() => load("1")}>x</button>
export const caught = <button onClick={() => load("1").pipe(Effect.catchTag("NotFound", () => Effect.void))}>x</button>
export const caughtAll = <button onClick={() => load("1").pipe(Effect.catch(() => Effect.void))}>x</button>
export const dies = <button onClick={() => Effect.orDie(load("1"))}>x</button>
// @ts-expect-error NotFound is not handled
export const failsGen = <button onClick={() => Effect.gen(function*() { yield* load("1") })}>x</button>
export const caughtGen = <button onClick={() => Effect.gen(function*() { yield* load("1") }).pipe(Effect.orDie)}>x</button>
// @ts-expect-error Denied is still not handled
export const partly = <form onSubmit={(e) => save(e.form).pipe(Effect.catchTag("NotFound", () => Effect.void))} />
export const both = <form onSubmit={(e) => save(e.form).pipe(Effect.catchTag(["NotFound", "Denied"], () => Effect.void))} />
export const tags = <form onSubmit={(e) => save(e.form).pipe(Effect.catchTags({ NotFound: () => Effect.void, Denied: () => Effect.void }))} />

// every event prop has the same rule
const failing = () => load("1")
const handled = () => Effect.orDie(load("1"))
export const props = (
  <main>
    {/* @ts-expect-error onClick */}
    <p onClick={failing} />
    {/* @ts-expect-error onDblClick */}
    <p onDblClick={failing} />
    {/* @ts-expect-error onInput */}
    <input onInput={failing} />
    {/* @ts-expect-error onChange */}
    <input onChange={failing} />
    {/* @ts-expect-error onSubmit */}
    <form onSubmit={failing} />
    {/* @ts-expect-error onKeyDown */}
    <input onKeyDown={failing} />
    {/* @ts-expect-error onKeyUp */}
    <input onKeyUp={failing} />
    {/* @ts-expect-error onFocus */}
    <input onFocus={failing} />
    {/* @ts-expect-error onBlur */}
    <input onBlur={failing} />
    <p onClick={handled} onDblClick={handled} />
    <input onInput={handled} onChange={handled} onKeyDown={handled} onKeyUp={handled} onFocus={handled} onBlur={handled} />
    <form onSubmit={handled} />
  </main>
)

// a component's own handler props: typed as View.Handler the rule reaches the
// caller; typed as `() => void` any result is accepted, a failing Effect too
const Save = (props: { readonly onSave: View.Handler<View.SubmitEvent> }) => <form onSubmit={props.onSave} />
const Loose = (props: { readonly onPress: () => void }) => <button onClick={props.onPress} />
export const handlerProps = (
  <main>
    {/* @ts-expect-error a failing handler passed to a View.Handler prop */}
    <Save onSave={() => load("1")} />
    <Save onSave={() => Effect.orDie(load("1"))} />
    <Loose onPress={() => load("1")} />
  </main>
)
