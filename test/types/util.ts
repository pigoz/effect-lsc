import { Context, Data, Effect } from "effect"

/** Exact type equality. */
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
export const check = <_ extends true>(): void => {}
/** A component's type without `Pipeable`, for exact comparisons. */
export type Fn<C> = C extends (...args: infer A) => infer O ? (...args: A) => O : never

export class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
export class Denied extends Data.TaggedError("Denied")<{ readonly user: string }> {}
export class Db extends Context.Service<Db, { readonly load: (id: string) => Effect.Effect<string, NotFound> }>()("t/Db") {}
export class Auth extends Context.Service<Auth, { readonly check: Effect.Effect<string, Denied> }>()("t/Auth") {}
