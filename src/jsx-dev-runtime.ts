/**
 * Development JSX runtime. Bun and TypeScript use `jsxDEV` in development
 * mode; it is the same factory with extra (ignored) debug arguments.
 */
import type * as VNode from "./internal/vnode.ts"
import { jsx as jsx_ } from "./internal/vnode.ts"
import type { ElementType } from "./jsx-runtime.ts"

export * from "./jsx-runtime.ts"

export const jsxDEV = <C extends ElementType>(
  type: C & VNode.TagCheck<C>,
  props: VNode.Props,
  key?: unknown,
  isStaticChildren?: unknown,
  _source?: unknown,
  _self?: unknown
): VNode.VNode => jsx_(type, props, key, isStaticChildren === true)
