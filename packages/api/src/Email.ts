import { Schema } from "effect"

/**
 * An email address. It has at most 320 characters, one `@`, and no spaces.
 */
export const Email = Schema.String.check(
	Schema.isMaxLength(320),
	Schema.isPattern(/^[^@\s]+@[^@\s]+$/),
)
export type Email = typeof Email.Type
