/**
 * Events as they arrive on the server. The browser runtime extracts a small,
 * generic payload from the DOM event (`value`, `checked`, `key`, form fields)
 * and sends it together with the handler id.
 */
import type * as Effect from "effect/Effect"

export interface EventBase {
  readonly type: string
  /** `element.value`, when the target element has a string value. */
  readonly value?: string | undefined
  /** `element.checked`, for checkboxes and radios. */
  readonly checked?: boolean | undefined
  /** `event.key`, for keyboard events. */
  readonly key?: string | undefined
  /** Form fields (string values only), for submit events. */
  readonly form?: Readonly<Record<string, string>> | undefined
}

export interface MouseEvent extends EventBase {
  readonly type: "click" | "dblclick"
}

export interface InputEvent extends EventBase {
  readonly type: "input" | "change"
  readonly value: string
}

export interface KeyboardEvent extends EventBase {
  readonly type: "keydown" | "keyup"
  readonly key: string
}

export interface SubmitEvent extends EventBase {
  readonly type: "submit"
  readonly form: Readonly<Record<string, string>>
}

export interface FocusEvent extends EventBase {
  readonly type: "focus" | "blur"
}

export type ViewEvent = MouseEvent | InputEvent | KeyboardEvent | SubmitEvent | FocusEvent

/**
 * A server-side event handler. It may return an `Effect`, which the session
 * runs, or nothing.
 *
 * Handlers cannot require services (`R` is `never`): acquire what you need in
 * the component body with `yield*` and close over it. That keeps the set of
 * services a page needs visible in the component's type.
 */
export type Handler<E extends EventBase = EventBase> = (event: E) => Effect.Effect<unknown, unknown, never> | void
