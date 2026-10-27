import { Execution } from "@openbot-build/domain"
import { Cause, Option, Schema } from "effect"
import { AiError } from "effect/ai"

/** Only an adapter that proved no request was sent may set this outcome. */
const Metadata = Schema.Struct({
	openbotOutcome: Schema.Literal("not_sent"),
	openbot: Execution.Failure,
})
export const notSent = (failure: Execution.Failure) =>
	AiError.make({
		module: "OpenBot",
		method: "send",
		reason: AiError.UnknownError.make({
			description: "The model call was not sent.",
			metadata: { openbotOutcome: "not_sent", openbot: failure },
		}),
	})
export const fromCause = (
	cause: Cause.Cause<unknown>,
): Option.Option<Execution.Failure> => {
	const reason = cause.reasons[0]
	if (
		cause.reasons.length !== 1 ||
		reason?._tag !== "Fail" ||
		!Schema.is(AiError.AiError)(reason.error) ||
		reason.error.reason._tag !== "UnknownError" ||
		!Schema.is(Metadata)(reason.error.reason.metadata)
	)
		return Option.none()
	return Option.some(reason.error.reason.metadata.openbot)
}
