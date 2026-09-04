/**
 * The wire model: what a render produces, and how two renders are diffed.
 *
 * A render is not a string but a tree of *nodes*. A node is a list of static
 * strings (tags, attribute names, structure) interleaved with *slots* (text,
 * attribute values, handler ids, nested nodes, lists). The statics are
 * identified by a fingerprint. This is LiveView's statics/dynamics split,
 * derived from the VNode tree at runtime instead of by a template compiler.
 *
 * Between renders only slots whose value changed travel, statics travel once
 * per fingerprint per session, lists are diffed by key, and a nested node
 * whose fingerprint changed is sent in full. The browser keeps the same tree,
 * merges patches into it, regenerates the HTML and morphs it into the DOM.
 */

export interface Node {
  readonly f: string
  readonly s: ReadonlyArray<string>
  readonly d: ReadonlyArray<Dyn>
}

export interface List {
  readonly keys: ReadonlyArray<string>
  readonly items: ReadonlyMap<string, Node>
}

export type Dyn = string | Node | List

export const isNode = (dyn: Dyn | undefined): dyn is Node => typeof dyn === "object" && dyn !== null && "f" in dyn

export const isList = (dyn: Dyn | undefined): dyn is List => typeof dyn === "object" && dyn !== null && "keys" in dyn

// FNV-1a, run twice with different offsets, for a 64-bit-ish fingerprint.
const fnv = (input: string, offset: number): string => {
  let hash = offset
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export const fingerprint = (statics: ReadonlyArray<string>): string => {
  const joined = statics.join("")
  return fnv(joined, 0x811c9dc5) + fnv(joined, 0x9747b28c)
}

/**
 * The full HTML of a node, as the browser would regenerate it.
 */
export const toHtml = (dyn: Dyn): string => {
  if (typeof dyn === "string") return dyn
  if (isList(dyn)) {
    let out = ""
    for (const key of dyn.keys) out += toHtml(dyn.items.get(key)!)
    return out
  }
  let out = dyn.s[0]!
  for (let i = 0; i < dyn.d.length; i++) out += toHtml(dyn.d[i]!) + dyn.s[i + 1]!
  return out
}

/**
 * Patch encoding, JSON friendly:
 * - a string is a slot's new value
 * - `{ f, s?, 0: …, 1: … }` is a node: `s` only the first time the session
 *   sends this fingerprint; only changed slots when patching a node the
 *   browser already has with the same fingerprint, all slots otherwise
 * - `{ k?, i? }` is a list: `k` is the new key order when it changed, `i`
 *   holds patches for changed or new items by key
 */
export type Patch = string | NodePatch | ListPatch

export interface NodePatch {
  readonly f: string
  readonly s?: ReadonlyArray<string>
  readonly [slot: number]: Patch
}

export interface ListPatch {
  readonly k?: ReadonlyArray<string>
  readonly i?: Readonly<Record<string, Patch>>
}

const fullNode = (node: Node, sent: Set<string>): NodePatch => {
  const patch: { f: string; s?: ReadonlyArray<string>; [slot: number]: Patch } = { f: node.f }
  if (!sent.has(node.f)) {
    sent.add(node.f)
    patch.s = node.s
  }
  node.d.forEach((dyn, i) => {
    patch[i] = fullDyn(dyn, sent)
  })
  return patch
}

const fullDyn = (dyn: Dyn, sent: Set<string>): Patch => {
  if (typeof dyn === "string") return dyn
  if (isList(dyn)) return diffList(undefined, dyn, sent)!
  return fullNode(dyn, sent)
}

const sameKeys = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((key, i) => key === b[i])

const diffList = (prev: List | undefined, next: List, sent: Set<string>): ListPatch | undefined => {
  const items: Record<string, Patch> = {}
  let changed = false
  for (const key of next.keys) {
    const patch = diffNode(prev?.items.get(key), next.items.get(key)!, sent)
    if (patch !== undefined) {
      items[key] = patch
      changed = true
    }
  }
  const keysChanged = prev === undefined || !sameKeys(prev.keys, next.keys)
  if (!keysChanged && !changed) return undefined
  return { ...(keysChanged ? { k: next.keys } : {}), ...(changed ? { i: items } : {}) }
}

const diffDyn = (prev: Dyn | undefined, next: Dyn, sent: Set<string>): Patch | undefined => {
  if (typeof next === "string") return prev === next ? undefined : next
  if (isList(next)) return diffList(isList(prev) ? prev : undefined, next, sent)
  return diffNode(isNode(prev) ? prev : undefined, next, sent)
}

/**
 * The patch that turns `prev` into `next`, or `undefined` when nothing
 * changed. `sent` remembers which statics the browser already has.
 */
export const diffNode = (prev: Node | undefined, next: Node, sent: Set<string>): NodePatch | undefined => {
  if (prev === undefined || prev.f !== next.f) return fullNode(next, sent)
  const patch: { f: string; [slot: number]: Patch } = { f: next.f }
  let changed = false
  next.d.forEach((dyn, i) => {
    const slot = diffDyn(prev.d[i], dyn, sent)
    if (slot !== undefined) {
      patch[i] = slot
      changed = true
    }
  })
  return changed ? patch : undefined
}
