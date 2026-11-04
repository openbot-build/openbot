import { Execution } from "@openbot-build/domain"
import { Cause, Context, Effect, Option, type Ref, Schema } from "effect"
import { AiError } from "effect/ai"

export type ModelReadFailureReason =
	"socket_reset" | "body_timeout" | "gateway_timeout"

/** Kept only in the model step that observed the failure, never in the event log. */
export interface ModelReadRequest {
	readonly url: string
	readonly body: string
}
export const CurrentModelReadFailure = Context.Reference<
	| ((
			reason: ModelReadFailureReason,
			request: ModelReadRequest,
	  ) => Effect.Effect<void>)
	| undefined
>("@openbot-build/openbot/models/CurrentModelReadFailure", {
	defaultValue: () => undefined,
})
export const FinalModelRead = Context.Reference<
	| {
			readonly request: ModelReadRequest
			readonly failure: Execution.Failure
			readonly sent: Ref.Ref<boolean>
	  }
	| undefined
>("@openbot-build/openbot/models/FinalModelRead", {
	defaultValue: () => undefined,
})

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
