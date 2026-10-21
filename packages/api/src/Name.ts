import { Schema } from "effect"

/**
 * A name that people read, such as the name of an Agent or the title of a Session.
 * Decoding removes spaces at the start and at the end. The rest must have 1 to 100 characters.
 */
export const Name = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(100),
)
export type Name = typeof Name.Type
