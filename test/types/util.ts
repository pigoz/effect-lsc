/** Exact type equality. */
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
export const check = <_ extends true>(): void => {}
