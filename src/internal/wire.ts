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

/**
 * A keyed list of nodes. `f` is the fingerprint most items share (the
 * "comprehension" statics); `""` when the list is empty.
 */
export interface List {
  readonly f: string
  readonly keys: ReadonlyArray<string>
  readonly items: ReadonlyMap<string, Node>
}

export type Dyn = string | Node | List

export const isNode = (dyn: Dyn | undefined): dyn is Node => typeof dyn === "object" && dyn !== null && "s" in dyn

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
  const joined = statics.join("")
  return fnv(joined, 0x811c9dc5) + fnv(joined, 0x9747b28c)
}

/**
 * Builds a list from its items in order, picking the most common item
 * fingerprint as the list's default.
 */
export const makeList = (keys: ReadonlyArray<string>, items: ReadonlyMap<string, Node>): List => {
  const counts = new Map<string, number>()
  let f = ""
  let best = 0
  for (const key of keys) {
    const itemF = items.get(key)!.f
    const count = (counts.get(itemF) ?? 0) + 1
    counts.set(itemF, count)
    if (count > best) {
      best = count
      f = itemF
    }
  }
  return { f, keys, items }
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
 * - `{ f, s?, d: […] }` is a node in full; `{ f?, 0: …, 3: … }` patches the
 *   node the browser already has, with only the changed slots. `s` travels
 *   the first time the session sends a fingerprint.
 * - `{ k?, f?, s?, i? }` is a list: `k` is the key order when it changed,
 *   `f` and `s` the default item fingerprint and its statics when they are
 *   new, `i` the changed or new items by key. An item with the default
 *   fingerprint is sent in full as a bare array of slots, and patched with a
 *   node patch without `f`.
 */
export type Patch = string | NodePatch | ListPatch | ReadonlyArray<Patch>

export interface NodePatch {
  readonly f?: string
  readonly s?: ReadonlyArray<string>
  readonly d?: ReadonlyArray<Patch>
  readonly [slot: number]: Patch
}

export interface ListPatch {
  readonly k?: ReadonlyArray<string>
  readonly f?: string
  readonly s?: ReadonlyArray<string>
  readonly i?: Readonly<Record<string, Patch>>
}

type MutableNodePatch = { f?: string; s?: ReadonlyArray<string>; d?: ReadonlyArray<Patch>; [slot: number]: Patch }
type MutableListPatch = { k?: ReadonlyArray<string>; f?: string; s?: ReadonlyArray<string>; i?: Record<string, Patch> }

/** The statics for `f`, the first time the session sends them. */
const staticsFor = (f: string, s: ReadonlyArray<string>, sent: Set<string>): ReadonlyArray<string> | undefined => {
  if (sent.has(f)) return undefined
  sent.add(f)
  return s
}

const fullSlots = (node: Node, sent: Set<string>): ReadonlyArray<Patch> => node.d.map((dyn) => fullDyn(dyn, sent))

const fullNode = (node: Node, sent: Set<string>): NodePatch => {
  const patch: MutableNodePatch = { f: node.f }
  const s = staticsFor(node.f, node.s, sent)
  if (s !== undefined) patch.s = s
  patch.d = fullSlots(node, sent)
  return patch
}

const fullDyn = (dyn: Dyn, sent: Set<string>): Patch => {
  if (typeof dyn === "string") return dyn
  if (isList(dyn)) return diffList(undefined, dyn, sent)!
  return fullNode(dyn, sent)
}

const sameKeys = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((key, i) => key === b[i])

/** Changed slots of `next` against `prev`, which has the same fingerprint. */
const changedSlots = (prev: Node, next: Node, sent: Set<string>): MutableNodePatch | undefined => {
  let patch: MutableNodePatch | undefined
  for (let i = 0; i < next.d.length; i++) {
    const slot = diffDyn(prev.d[i], next.d[i]!, sent)
    if (slot === undefined) continue
    patch ??= {}
    patch[i] = slot
  }
  return patch
}

const diffItem = (prev: Node | undefined, next: Node, defaultF: string, sent: Set<string>): Patch | undefined => {
  if (prev === undefined || prev.f !== next.f) {
    return next.f === defaultF ? fullSlots(next, sent) : fullNode(next, sent)
  }
  const patch = changedSlots(prev, next, sent)
  if (patch === undefined) return undefined
  if (next.f !== defaultF) patch.f = next.f
  return patch
}

const diffList = (prev: List | undefined, next: List, sent: Set<string>): ListPatch | undefined => {
  const patch: MutableListPatch = {}
  let changed = false
  if (next.f !== "" && (prev === undefined || prev.f !== next.f)) {
    patch.f = next.f
    const sample = next.items.get(next.keys.find((key) => next.items.get(key)!.f === next.f)!)!
    const s = staticsFor(next.f, sample.s, sent)
    if (s !== undefined) patch.s = s
    changed = true
  }
  if (prev === undefined || !sameKeys(prev.keys, next.keys)) {
    patch.k = next.keys
    changed = true
  }
  for (const key of next.keys) {
    const item = diffItem(prev?.items.get(key), next.items.get(key)!, next.f, sent)
    if (item === undefined) continue
    patch.i ??= {}
    patch.i[key] = item
    changed = true
  }
  return changed ? patch : undefined
}

const diffDyn = (prev: Dyn | undefined, next: Dyn, sent: Set<string>): Patch | undefined => {
  if (prev === next) return undefined
  if (typeof next === "string") return prev === next ? undefined : next
  if (isList(next)) return diffList(isList(prev) ? prev : undefined, next, sent)
  return diffNode(isNode(prev) ? prev : undefined, next, sent)
}

/**
 * The patch that turns `prev` into `next`, or `undefined` when nothing
 * changed. `sent` remembers which statics the browser already has.
 */
export const diffNode = (prev: Node | undefined, next: Node, sent: Set<string>): NodePatch | undefined => {
  if (prev === next) return undefined
  if (prev === undefined || prev.f !== next.f) return fullNode(next, sent)
  const patch = changedSlots(prev, next, sent)
  if (patch === undefined) return undefined
  patch.f = next.f
  return patch
}
