import { Schema } from "effect"

/** Product discovery errors include input and network failures. */
export const FailureReason = Schema.Literals([
	"InvalidInput",
	"IncompatibleCard",
	"NoDeclaration",
	"NoUsableServices",
	"Document",
	"Http",
	"BlockedTarget",
	"Transport",
	"TooLarge",
	"Timeout",
	"Redirect",
	"Encoding",
])
export type FailureReason = typeof FailureReason.Type

export class Failed extends Schema.TaggedError<
	Failed,
	{ readonly brand: unique symbol }
>()("AppDiscoveryFailed", {
	reason: FailureReason,
	issues: Schema.Array(
		Schema.Struct({
			url: Schema.String,
			reason: Schema.String,
			fieldPath: Schema.optionalKey(Schema.String),
		}),
	),
}) {}
