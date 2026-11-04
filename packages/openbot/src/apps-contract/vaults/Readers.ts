import { Schema } from "effect"

/**
 * The secret provider did not answer, refused the token, or has no such item or field.
 * Callers show the message. The cause stays inside OpenBot.
 */
export class VaultReadFailed extends Schema.TaggedError<
	VaultReadFailed,
	{ readonly brand: unique symbol }
>()("VaultReadFailed", {
	message: Schema.String,
	retry: Schema.Boolean,
	cause: Schema.optional(Schema.Defect()),
}) {}
