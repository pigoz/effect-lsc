/**
 * HTML serialization helpers: escaping and attribute rendering.
 */

const textEscapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" }
const attributeEscapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }

export const escapeText = (value: string): string => value.replace(/[&<>]/g, (c) => textEscapes[c]!)

export const escapeAttribute = (value: string): string => value.replace(/[&<>"]/g, (c) => attributeEscapes[c]!)

export const voidElements: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
])

/**
 * Attributes whose presence is the value. `true` renders the bare attribute,
 * `false` / `null` / `undefined` omit it.
 */
export const booleanAttributes: ReadonlySet<string> = new Set([
  "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer", "disabled",
  "formnovalidate", "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate",
  "open", "playsinline", "readonly", "required", "reversed", "selected"
])

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

const renderStyle = (style: Record<string, unknown>): string => {
  const parts: Array<string> = []
  for (const key of Object.keys(style)) {
    const value = style[key]
    if (value === null || value === undefined || value === false) continue
    parts.push(`${kebab(key)}:${String(value)}`)
  }
  return parts.join(";")
}

const renderClass = (value: ReadonlyArray<unknown>): string =>
  value.filter((c) => typeof c === "string" && c.length > 0).join(" ")

/**
 * Renders a single attribute (with a leading space), or `undefined` when the
 * attribute should be omitted.
 */
export const renderAttribute = (name: string, value: unknown): string | undefined => {
  if (value === null || value === undefined || value === false) return undefined
  if (booleanAttributes.has(name)) {
    return value === true || value === "" || value === name ? ` ${name}` : value ? ` ${name}` : undefined
  }
  if (value === true) return ` ${name}=""`
  if (name === "style" && typeof value === "object") {
    const css = renderStyle(value as Record<string, unknown>)
    return css.length === 0 ? undefined : ` style="${escapeAttribute(css)}"`
  }
  if (name === "class" && Array.isArray(value)) {
    const classes = renderClass(value)
    return classes.length === 0 ? undefined : ` class="${escapeAttribute(classes)}"`
  }
  switch (typeof value) {
    case "string":
      return ` ${name}="${escapeAttribute(value)}"`
    case "number":
    case "bigint":
      return ` ${name}="${String(value)}"`
    default:
      return undefined
  }
}
