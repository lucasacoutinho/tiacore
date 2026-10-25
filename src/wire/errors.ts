import * as Schema from 'effect/Schema'

// The closed set of failures tiacore reports. `message` carries the text 1.x
// printed, so the CLI and the Promise API keep their observable errors.

/** Bad input: configuration, protocol data, CLI usage. */
export class TiaInvalid extends Schema.TaggedError<
  TiaInvalid,
  { readonly brand: unique symbol }
>()('TiaInvalid', {
  message: Schema.String,
}) {}

/** A file system, git or process operation failed. */
export class TiaIo extends Schema.TaggedError<
  TiaIo,
  { readonly brand: unique symbol }
>()('TiaIo', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/** An artifact failed its trust policy. */
export class TiaUntrusted extends Schema.TaggedError<
  TiaUntrusted,
  { readonly brand: unique symbol }
>()('TiaUntrusted', { message: Schema.String }) {}

/**
 * A verification, certification or workspace receipt reports failure. When
 * `silent` is set the receipt already says why, so the CLI exits 1 without a
 * message, as 1.x did.
 */
export class TiaFailed extends Schema.TaggedError<
  TiaFailed,
  { readonly brand: unique symbol }
>()('TiaFailed', {
  message: Schema.String,
  silent: Schema.optionalKey(Schema.Boolean),
}) {}

export type TiaError = TiaFailed | TiaInvalid | TiaIo | TiaUntrusted
