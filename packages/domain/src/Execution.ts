import { Schema, String as Str } from "effect"
import { ArtifactId, SourceId, SourceReference, Version } from "./Artifacts.ts"

export const Id = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/ExecutionId"))
export type Id = typeof Id.Type

/** One key names one command. A retry must use the same key and input. */
export const CommandKey = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/CommandKey"))
export type CommandKey = typeof CommandKey.Type

export const CallId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/CallId"))
export type CallId = typeof CallId.Type

/** A model call and the path of a call made inside it. The saved step fixes its occurrence. */
export const CallSite = Schema.Struct({
	main: Schema.String,
	path: Schema.Array(Schema.String),
})
export type CallSite = typeof CallSite.Type
export const mainCall = (main: string): CallSite => ({ main, path: [] })

export const ErrorId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/ErrorId"))
export type ErrorId = typeof ErrorId.Type

export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const Status = Schema.Literals([
	"queued",
	"running",
	"waiting",
	"cancelling",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
	"outcome_unknown",
])
export type Status = typeof Status.Type

export const isTerminal = (status: Status): boolean =>
	status === "completed" ||
	status === "failed" ||
	status === "cancelled" ||
	status === "interrupted"

/** A cancel request is not proof that an outside action has stopped. */
export const canTransition = (from: Status, to: Status): boolean => {
	if (isTerminal(from) || from === to) return false
	switch (from) {
		case "queued":
			return to === "running" || to === "cancelling" || to === "interrupted"
		case "running":
			return (
				to === "waiting" ||
				to === "cancelling" ||
				to === "completed" ||
				to === "failed" ||
				to === "outcome_unknown" ||
				to === "interrupted"
			)
		case "waiting":
			return (
				to === "running" ||
				to === "cancelling" ||
				to === "failed" ||
				to === "interrupted"
			)
		case "outcome_unknown":
			return (
				to === "running" ||
				to === "cancelling" ||
				to === "failed" ||
				to === "interrupted"
			)
		case "cancelling":
			return (
				to === "cancelled" || to === "outcome_unknown" || to === "interrupted"
			)
		default:
			return false
	}
}

/** Public failures carry no provider text, input, or stored cause. */
export const Failure = Schema.Struct({
	errorId: ErrorId,
	category: Schema.Literals([
		"invalid",
		"forbidden",
		"not_found",
		"conflict",
		"unavailable",
		"external",
		"outcome_unknown",
		"interrupted",
	]),
})
export type Failure = typeof Failure.Type

export const Resource = Schema.Struct({
	kind: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
})
export type Resource = typeof Resource.Type

export const Record = Schema.Struct({
	id: Id,
	resource: Resource,
	status: Status,
	sequence: Sequence,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
	failure: Schema.NullOr(Failure),
})
export type Record = typeof Record.Type

export const Receipt = Schema.Struct({
	executionId: Id,
	commandKey: CommandKey,
	sequence: Sequence,
})
export type Receipt = typeof Receipt.Type

export const DecisionId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
)
export const Answer = Schema.Literals(["allow", "deny", "retry", "stop"])
export type Answer = typeof Answer.Type

/** A new cancel closes old choices. Restarts keep the same choice ID. */
export const callDecisionId = (
	callId: CallId,
	cancelEpoch: number = 0,
): string => (cancelEpoch === 0 ? callId : `${callId}:cancel:${cancelEpoch}`)
/** Call IDs come from the execution store, not from decision input. */
export const isCallDecision = (id: string, callId: CallId): boolean =>
	id === callId || Str.startsWith(`${callId}:cancel:`)(id)
export const Decision = Schema.Struct({
	id: DecisionId,
	choices: Schema.NonEmptyArray(Answer),
	answer: Schema.NullOr(Answer),
})
export type Decision = typeof Decision.Type

/** Each model retry starts a new attempt. Text never crosses attempts. */
export const EventBody = Schema.TaggedUnion({
	SourceCaptured: { chatId: Schema.String, sourceId: SourceId },
	ArtifactPublished: {
		chatId: Schema.String,
		artifactId: ArtifactId,
		version: Version,
	},
	CitationRecorded: {
		chatId: Schema.String,
		itemId: Schema.String,
		citations: Schema.Array(SourceReference),
	},
	Wake: { key: Schema.String },
	State: { status: Status, failure: Schema.NullOr(Failure) },
	StepStarted: { step: Schema.String, attempt: Schema.Natural },
	Text: { step: Schema.String, attempt: Schema.Natural, text: Schema.String },
	ToolOutput: {
		step: Schema.String,
		attempt: Schema.Natural,
		output: Schema.Json,
	},
	StepCompleted: { step: Schema.String, attempt: Schema.Natural },
	/** A late result is saved. This closes any pending choice for this call. */
	CallRecorded: {
		callId: CallId,
		step: Schema.String,
		attempt: Schema.Natural,
	},
	DecisionNeeded: {
		decisionId: DecisionId,
		choices: Schema.NonEmptyArray(Answer),
	},
	DecisionMade: { decisionId: DecisionId, answer: Answer },
	Result: { resource: Resource },
	InputMoved: { executionId: Id, items: Schema.Array(Schema.String) },
	/** Follow this execution with its own cursor, steps, and attempts. */
	ChildExecution: { executionId: Id, step: Schema.String },
	Checkpoint: {
		resource: Resource,
		revision: Schema.Natural,
		/** A message command keeps this input ID when the client retries it. */
		inputId: Schema.optionalKey(Schema.String),
	},
})
export type EventBody = typeof EventBody.Type

export const Event = Schema.Struct({
	executionId: Id,
	sequence: Sequence,
	createdAt: Schema.Finite,
	body: EventBody,
})
export type Event = typeof Event.Type

export const CallStatus = Schema.Literals([
	"intended",
	"sending",
	"completed",
	"outcome_unknown",
])
export type CallStatus = typeof CallStatus.Type
/** Local steps use only pure work and fenced database writes. Outside calls have their own records. */
export const Retry = Schema.Literals([
	"local",
	"read_only",
	"idempotent",
	"never",
])
export type Retry = typeof Retry.Type
export const Call = Schema.Struct({
	id: CallId,
	executionId: Id,
	step: Schema.String,
	attempt: Schema.Natural,
	status: CallStatus,
	retry: Retry,
	input: Schema.Json,
	result: Schema.NullOr(Schema.Json),
})
export type Call = typeof Call.Type

/** A lost response is not a reason to repeat a write without an idempotency key. */
export const maySend = (status: CallStatus, retry: Retry): boolean =>
	status === "intended" || (status === "sending" && retry !== "never")

export class NotFound extends Schema.TaggedError<
	NotFound,
	{ readonly brand: unique symbol }
>()("ExecutionNotFound", { id: Id }) {}
export class Conflict extends Schema.TaggedError<
	Conflict,
	{ readonly brand: unique symbol }
>()("ExecutionConflict", { id: Id }) {}
export class KeyConflict extends Schema.TaggedError<
	KeyConflict,
	{ readonly brand: unique symbol }
>()("ExecutionKeyConflict", {}) {}
export class StorageError extends Schema.TaggedError<
	StorageError,
	{ readonly brand: unique symbol }
>()("ExecutionStorageError", { cause: Schema.Defect() }) {}

export class Forbidden extends Schema.TaggedError<
	Forbidden,
	{ readonly brand: unique symbol }
>()("ExecutionForbidden", {}) {}

/** The workflow must settle this call before it can make more progress. */
export class OutcomeUnknown extends Schema.TaggedError<
	OutcomeUnknown,
	{ readonly brand: unique symbol }
>()("ExecutionOutcomeUnknown", { callId: CallId }) {}
