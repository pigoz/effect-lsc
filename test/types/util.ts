import { Context, Data, Effect } from "effect"

/** Exact type equality. */
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
export const check = <_ extends true>(): void => {}

export class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
export class Denied extends Data.TaggedError("Denied")<{ readonly user: string }> {}
export class Db extends Context.Service<Db, { readonly load: (id: string) => Effect.Effect<string, NotFound> }>()("t/Db") {}
