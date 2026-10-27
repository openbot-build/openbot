import { Schema } from "effect"

/** A public hint states whether a secret is set, without exposing the secret. */
export const SecretState = Schema.Struct({
	set: Schema.Boolean,
	hint: Schema.NullOr(Schema.String),
})
export type SecretState = typeof SecretState.Type

/** A secret goes in, but it never comes out. The hint shows its last characters. */
export const SecretInput = Schema.RedactedFromValue(
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
)
/** A secret shown once. Its JSON form is a string. */
export const SecretOutput = Schema.RedactedFromValue(Schema.String)
