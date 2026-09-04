/**
 * JSX runtime for `effect-lsc`.
 *
 * Set `"jsx": "react-jsx"` and `"jsxImportSource": "effect-lsc"` in
 * `tsconfig.json`; TypeScript, Bun and Vite will then compile JSX to calls
 * into this module. No compiler plugin is required.
 */
import type * as VNode from "./internal/vnode.ts"
import { Fragment as Fragment_, jsx as jsx_ } from "./internal/vnode.ts"
import type * as Events from "./internal/events.ts"

export const jsx = (type: unknown, props: VNode.Props, key?: unknown): VNode.VNode => jsx_(type, props, key, false)
/** Emitted for a literal list of sibling children: their shape is static. */
export const jsxs = (type: unknown, props: VNode.Props, key?: unknown): VNode.VNode => jsx_(type, props, key, true)
export const Fragment: VNode.Fragment = Fragment_

type Booleanish = boolean | "true" | "false"

/**
 * Attributes shared by every intrinsic element. Attribute names are the
 * real HTML names (`class`, `for`), not React's.
 */
export interface HTMLAttributes {
  readonly key?: string | number | undefined
  readonly children?: VNode.Child
  readonly id?: string | undefined
  readonly class?: string | ReadonlyArray<string | false | null | undefined> | undefined
  readonly style?: string | Readonly<Record<string, string | number | false | null | undefined>> | undefined
  readonly title?: string | undefined
  readonly lang?: string | undefined
  readonly dir?: "ltr" | "rtl" | "auto" | undefined
  readonly hidden?: boolean | undefined
  readonly inert?: boolean | undefined
  readonly tabindex?: number | undefined
  readonly role?: string | undefined
  readonly draggable?: Booleanish | undefined
  readonly contenteditable?: Booleanish | "plaintext-only" | undefined
  readonly autofocus?: boolean | undefined
  readonly accesskey?: string | undefined
  readonly slot?: string | undefined
  readonly [data: `data-${string}`]: string | number | boolean | undefined
  readonly [aria: `aria-${string}`]: string | number | boolean | undefined

  // Events. Handlers run on the server; only an opaque id reaches the browser.
  readonly onClick?: Events.Handler<Events.MouseEvent> | undefined
  readonly onDblClick?: Events.Handler<Events.MouseEvent> | undefined
  readonly onInput?: Events.Handler<Events.InputEvent> | undefined
  readonly onChange?: Events.Handler<Events.InputEvent> | undefined
  readonly onSubmit?: Events.Handler<Events.SubmitEvent> | undefined
  readonly onKeyDown?: Events.Handler<Events.KeyboardEvent> | undefined
  readonly onKeyUp?: Events.Handler<Events.KeyboardEvent> | undefined
  readonly onFocus?: Events.Handler<Events.FocusEvent> | undefined
  readonly onBlur?: Events.Handler<Events.FocusEvent> | undefined
}

export interface AnchorAttributes extends HTMLAttributes {
  readonly href?: string | undefined
  readonly target?: string | undefined
  readonly rel?: string | undefined
  readonly download?: string | boolean | undefined
}

export interface FormAttributes extends HTMLAttributes {
  readonly action?: string | undefined
  readonly method?: string | undefined
  readonly enctype?: string | undefined
  readonly autocomplete?: string | undefined
  readonly novalidate?: boolean | undefined
}

export interface InputAttributes extends HTMLAttributes {
  readonly type?: string | undefined
  readonly name?: string | undefined
  readonly value?: string | number | undefined
  readonly checked?: boolean | undefined
  readonly placeholder?: string | undefined
  readonly disabled?: boolean | undefined
  readonly readonly?: boolean | undefined
  readonly required?: boolean | undefined
  readonly autocomplete?: string | undefined
  readonly min?: string | number | undefined
  readonly max?: string | number | undefined
  readonly step?: string | number | undefined
  readonly minlength?: number | undefined
  readonly maxlength?: number | undefined
  readonly pattern?: string | undefined
  readonly list?: string | undefined
  readonly multiple?: boolean | undefined
  readonly accept?: string | undefined
  readonly form?: string | undefined
}

export interface ButtonAttributes extends HTMLAttributes {
  readonly type?: "button" | "submit" | "reset" | undefined
  readonly name?: string | undefined
  readonly value?: string | undefined
  readonly disabled?: boolean | undefined
  readonly form?: string | undefined
}

export interface LabelAttributes extends HTMLAttributes {
  readonly for?: string | undefined
}

export interface SelectAttributes extends HTMLAttributes {
  readonly name?: string | undefined
  readonly value?: string | undefined
  readonly disabled?: boolean | undefined
  readonly multiple?: boolean | undefined
  readonly required?: boolean | undefined
}

export interface OptionAttributes extends HTMLAttributes {
  readonly value?: string | undefined
  readonly selected?: boolean | undefined
  readonly disabled?: boolean | undefined
}

export interface TextareaAttributes extends HTMLAttributes {
  readonly name?: string | undefined
  readonly placeholder?: string | undefined
  readonly rows?: number | undefined
  readonly cols?: number | undefined
  readonly disabled?: boolean | undefined
  readonly readonly?: boolean | undefined
  readonly required?: boolean | undefined
}

export interface ImgAttributes extends HTMLAttributes {
  readonly src?: string | undefined
  readonly alt?: string | undefined
  readonly width?: number | string | undefined
  readonly height?: number | string | undefined
  readonly loading?: "lazy" | "eager" | undefined
}

export interface LinkAttributes extends HTMLAttributes {
  readonly rel?: string | undefined
  readonly href?: string | undefined
  readonly type?: string | undefined
  readonly media?: string | undefined
  readonly crossorigin?: string | undefined
}

export interface MetaAttributes extends HTMLAttributes {
  readonly charset?: string | undefined
  readonly name?: string | undefined
  readonly content?: string | undefined
  readonly "http-equiv"?: string | undefined
}

export interface ScriptAttributes extends HTMLAttributes {
  readonly src?: string | undefined
  readonly type?: string | undefined
  readonly async?: boolean | undefined
  readonly defer?: boolean | undefined
  readonly crossorigin?: string | undefined
}

export interface TableCellAttributes extends HTMLAttributes {
  readonly colspan?: number | undefined
  readonly rowspan?: number | undefined
  readonly scope?: string | undefined
}

export interface DetailsAttributes extends HTMLAttributes {
  readonly open?: boolean | undefined
}

export interface DialogAttributes extends HTMLAttributes {
  readonly open?: boolean | undefined
}

export interface ProgressAttributes extends HTMLAttributes {
  readonly value?: number | undefined
  readonly max?: number | undefined
}

export declare namespace JSX {
  export type Element = VNode.VNode
  export type ElementType = string | VNode.ComponentFn<any, any, any>
  export interface ElementChildrenAttribute {
    readonly children: {}
  }
  export interface IntrinsicAttributes {
    readonly key?: string | number | undefined
  }
  export interface IntrinsicElements {
    // document
    readonly html: HTMLAttributes
    readonly head: HTMLAttributes
    readonly body: HTMLAttributes
    readonly title: HTMLAttributes
    readonly meta: MetaAttributes
    readonly link: LinkAttributes
    readonly script: ScriptAttributes
    readonly style: HTMLAttributes
    readonly base: LinkAttributes
    // sections
    readonly main: HTMLAttributes
    readonly header: HTMLAttributes
    readonly footer: HTMLAttributes
    readonly nav: HTMLAttributes
    readonly section: HTMLAttributes
    readonly article: HTMLAttributes
    readonly aside: HTMLAttributes
    readonly h1: HTMLAttributes
    readonly h2: HTMLAttributes
    readonly h3: HTMLAttributes
    readonly h4: HTMLAttributes
    readonly h5: HTMLAttributes
    readonly h6: HTMLAttributes
    readonly address: HTMLAttributes
    // grouping
    readonly div: HTMLAttributes
    readonly p: HTMLAttributes
    readonly pre: HTMLAttributes
    readonly blockquote: HTMLAttributes
    readonly ul: HTMLAttributes
    readonly ol: HTMLAttributes
    readonly li: HTMLAttributes
    readonly dl: HTMLAttributes
    readonly dt: HTMLAttributes
    readonly dd: HTMLAttributes
    readonly figure: HTMLAttributes
    readonly figcaption: HTMLAttributes
    readonly hr: HTMLAttributes
    readonly br: HTMLAttributes
    readonly wbr: HTMLAttributes
    // text
    readonly a: AnchorAttributes
    readonly span: HTMLAttributes
    readonly strong: HTMLAttributes
    readonly em: HTMLAttributes
    readonly b: HTMLAttributes
    readonly i: HTMLAttributes
    readonly u: HTMLAttributes
    readonly s: HTMLAttributes
    readonly small: HTMLAttributes
    readonly code: HTMLAttributes
    readonly kbd: HTMLAttributes
    readonly samp: HTMLAttributes
    readonly var: HTMLAttributes
    readonly abbr: HTMLAttributes
    readonly cite: HTMLAttributes
    readonly q: HTMLAttributes
    readonly mark: HTMLAttributes
    readonly sub: HTMLAttributes
    readonly sup: HTMLAttributes
    readonly time: HTMLAttributes
    readonly label: LabelAttributes
    // media & embedded
    readonly img: ImgAttributes
    readonly picture: HTMLAttributes
    readonly source: HTMLAttributes
    readonly video: HTMLAttributes
    readonly audio: HTMLAttributes
    readonly canvas: HTMLAttributes
    readonly svg: HTMLAttributes
    readonly iframe: HTMLAttributes
    // tables
    readonly table: HTMLAttributes
    readonly thead: HTMLAttributes
    readonly tbody: HTMLAttributes
    readonly tfoot: HTMLAttributes
    readonly tr: HTMLAttributes
    readonly th: TableCellAttributes
    readonly td: TableCellAttributes
    readonly caption: HTMLAttributes
    readonly colgroup: HTMLAttributes
    readonly col: HTMLAttributes
    // forms
    readonly form: FormAttributes
    readonly input: InputAttributes
    readonly button: ButtonAttributes
    readonly select: SelectAttributes
    readonly option: OptionAttributes
    readonly optgroup: HTMLAttributes
    readonly textarea: TextareaAttributes
    readonly fieldset: HTMLAttributes
    readonly legend: HTMLAttributes
    readonly datalist: HTMLAttributes
    readonly output: HTMLAttributes
    readonly progress: ProgressAttributes
    readonly meter: HTMLAttributes
    // interactive
    readonly details: DetailsAttributes
    readonly summary: HTMLAttributes
    readonly dialog: DialogAttributes
    readonly menu: HTMLAttributes
    readonly template: HTMLAttributes
    readonly slot: HTMLAttributes
  }
}
