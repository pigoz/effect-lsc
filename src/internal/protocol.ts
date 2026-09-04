/**
 * The wire protocol between the browser runtime and the server session.
 * Untrusted input (browser → server) is validated with `Schema`.
 */
import * as Schema from "effect/Schema"

export const ClientEvent = Schema.Struct({
  t: Schema.Literal("event"),
  type: Schema.String,
  id: Schema.String,
  value: Schema.optional(Schema.String),
  checked: Schema.optional(Schema.Boolean),
  key: Schema.optional(Schema.String),
  form: Schema.optional(Schema.Record(Schema.String, Schema.String))
})
export type ClientEvent = typeof ClientEvent.Type

export const ClientMessage = Schema.Union([ClientEvent])
export type ClientMessage = typeof ClientMessage.Type

export const decodeClientMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientMessage))

export type ServerMessage = { readonly t: "render"; readonly html: string }

export const encodeServerMessage = (message: ServerMessage): string => JSON.stringify(message)
