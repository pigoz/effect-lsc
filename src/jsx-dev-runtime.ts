/**
 * Development JSX runtime. Bun and TypeScript use `jsxDEV` in development
 * mode; it is the same factory with extra (ignored) debug arguments.
 */
import type * as VNode from "./internal/vnode.ts"
import { jsx } from "./jsx-runtime.ts"

export * from "./jsx-runtime.ts"

export const jsxDEV = (
  type: unknown,
  props: VNode.Props,
  key?: unknown,
  _isStatic?: unknown,
  _source?: unknown,
  _self?: unknown
): VNode.VNode => jsx(type, props, key)
