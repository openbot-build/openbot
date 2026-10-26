import { Schema } from "effect"

/** A secret goes in, but it never comes out. The hint shows its last characters. */
export const SecretInput = Schema.RedactedFromValue(
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
)
/** A secret shown once. Its JSON form is a string. */
export const SecretOutput = Schema.RedactedFromValue(Schema.String)
