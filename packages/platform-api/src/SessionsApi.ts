import {
	Config,
	Item,
	Memory as CoreMemory,
	Session,
	SessionStore,
	Turn,
} from "@openbot-build/core"
import { Memory } from "@openbot-build/plugin-memory"
import { Schema } from "effect"
import { Sse } from "effect/encoding"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"

const TextInput = Schema.Struct({
	type: Schema.Literal("input_text"),
	text: Schema.NonEmptyString,
})
const InputMessage = Schema.Struct({
	type: Schema.optionalKey(Schema.Literal("message")),
	role: Schema.Literal("user"),
	content: Schema.Union([
		Schema.NonEmptyString,
		Schema.Array(TextInput).check(Schema.isMinLength(1)),
	]),
})

export const SettingsPatch = Schema.Struct({
	mode: Schema.optionalKey(Config.Mode),
	model: Schema.optionalKey(Config.Selection),
	memoryEnabled: Schema.optionalKey(Schema.Boolean),
	memoryGenerationEnabled: Schema.optionalKey(Schema.Boolean),
})
export const CreateSessionRequest = Schema.Struct({
	title: Schema.optionalKey(Schema.String),
	settings: Schema.optionalKey(SettingsPatch),
})
export type CreateSessionRequest = typeof CreateSessionRequest.Type

/** Text-only Responses input. The stream watches a background execution. */
export const StartTurnRequest = Schema.Struct({
	expected: Session.Revision,
	overrides: Schema.optionalKey(SettingsPatch),
	input: Schema.Union([
		Schema.NonEmptyString,
		Schema.Array(InputMessage).check(Schema.isMinLength(1)),
	]),
	background: Schema.optionalKey(Schema.Literal(true)),
	stream: Schema.optionalKey(Schema.Boolean),
})
export type StartTurnRequest = typeof StartTurnRequest.Type

const OutputText = Schema.Struct({
	type: Schema.Literal("output_text"),
	text: Schema.String,
	annotations: Schema.Tuple([]),
})
const OutputMessage = Schema.Struct({
	id: Item.Id,
	type: Schema.Literal("message"),
	role: Schema.Literal("assistant"),
	status: Schema.Literals(["in_progress", "completed", "incomplete"]),
	content: Schema.Array(OutputText),
})

export const ModelUsage = Schema.Struct({
	inputTokens: Schema.Struct({
		total: Schema.optionalKey(Schema.Int),
		uncached: Schema.optionalKey(Schema.Int),
		cacheRead: Schema.optionalKey(Schema.Int),
		cacheWrite: Schema.optionalKey(Schema.Int),
	}),
	outputTokens: Schema.Struct({
		total: Schema.optionalKey(Schema.Int),
		text: Schema.optionalKey(Schema.Int),
		reasoning: Schema.optionalKey(Schema.Int),
	}),
})
export const SessionResponse = Schema.Struct({
	usage: Schema.optionalKey(ModelUsage),
	id: Turn.Id,
	object: Schema.Literal("response"),
	created_at: Schema.Natural,
	session: Session.Id,
	version: CoreMemory.VersionId,
	background: Schema.Literal(true),
	status: Schema.Literals([
		"in_progress",
		"completed",
		"incomplete",
		"failed",
		"cancelled",
	]),
	output: Schema.Array(OutputMessage),
	error: Schema.NullOr(
		Schema.Struct({
			code: Schema.Literals(["model_error", "internal_error"]),
			message: Schema.String,
		}),
	),
	incomplete_details: Schema.NullOr(
		Schema.Struct({
			reason: Schema.Literals(["max_output_tokens", "content_filter", "other"]),
		}),
	),
})
export type SessionResponse = typeof SessionResponse.Type

const executionFields = {
	session: Session.Id,
	turn: Turn.Id,
	step: Schema.optionalKey(Schema.Natural),
}
const responseEvent = <const T extends string>(type: T) =>
	Schema.Struct({
		...executionFields,
		type: Schema.Literal(type),
		sequence_number: Schema.Natural,
		response: SessionResponse,
	})
const itemEvent = <const T extends string>(type: T) =>
	Schema.Struct({
		...executionFields,
		type: Schema.Literal(type),
		sequence_number: Schema.Natural,
		output_index: Schema.Natural,
		item: OutputMessage,
	})
const contentFields = {
	...executionFields,
	sequence_number: Schema.Natural,
	item_id: Item.Id,
	output_index: Schema.Natural,
	content_index: Schema.Natural,
}
const partEvent = <const T extends string>(type: T) =>
	Schema.Struct({
		type: Schema.Literal(type),
		...contentFields,
		part: OutputText,
	})

/** A subset of the Responses text events. response.cancelled is a platform extension. */
export const SessionResponseEvent = Schema.Union([
	responseEvent("response.created"),
	responseEvent("response.in_progress"),
	itemEvent("response.output_item.added"),
	partEvent("response.content_part.added"),
	Schema.Struct({
		type: Schema.Literal("response.output_text.delta"),
		...contentFields,
		delta: Schema.String,
		logprobs: Schema.Tuple([]),
	}),
	Schema.Struct({
		type: Schema.Literal("response.output_text.done"),
		...contentFields,
		text: Schema.String,
		logprobs: Schema.Tuple([]),
	}),
	partEvent("response.content_part.done"),
	itemEvent("response.output_item.done"),
	responseEvent("response.completed"),
	responseEvent("response.incomplete"),
	responseEvent("response.failed"),
	responseEvent("response.cancelled"),
])
export type SessionResponseEvent = typeof SessionResponseEvent.Type

/** Codec for the native SSE envelope. data is a JSON event, not an already encoded string. */
export const SessionResponseSseEvent = Schema.Struct({
	...Sse.EventEncoded.fields,
	event: Schema.Literals([
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.content_part.added",
		"response.output_text.delta",
		"response.output_text.done",
		"response.content_part.done",
		"response.output_item.done",
		"response.completed",
		"response.incomplete",
		"response.failed",
		"response.cancelled",
	]),
	data: Schema.fromJsonString(SessionResponseEvent),
}).check(
	Schema.makeFilter(
		({ event, data }) =>
			event === data.type || "SSE event must match data.type",
	),
)
export type SessionResponseSseEvent = typeof SessionResponseSseEvent.Type

/** The current core view, plus the latest message in the Responses format. */
export const SessionView = Schema.Struct({
	...Session.View({}).fields,
	response: Schema.NullOr(SessionResponse),
	activity: Schema.optionalKey(
		Schema.Literals(["active", "inactive", "historical"]),
	),
})
export type SessionView = typeof SessionView.Type

/** The list view. It leaves out state, message content and response output. */
export const SessionSummary = Schema.Struct({
	session: Session.Ref,
	status: Schema.Literals([
		"Idle",

		"Running",
		"WaitingApproval",
		"Completed",
		"Failed",
		"Interrupted",
	]),
	turn: Schema.NullOr(Turn.Id),
	response: Schema.NullOr(
		Schema.Struct({
			id: Turn.Id,
			created_at: Schema.Natural,
			status: SessionResponse.fields.status,
			version: CoreMemory.VersionId,
		}),
	),
	activity: Schema.Literals(["active", "inactive", "historical"]),
})
export type SessionSummary = typeof SessionSummary.Type

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
	"SessionNotFound",
	{ session: Session.Id },
) {}
export class SessionBusy extends Schema.TaggedError<SessionBusy>()(
	"SessionBusy",
	{
		session: Session.Id,
	},
) {}
export class SessionExecutionUnavailable extends Schema.TaggedError<SessionExecutionUnavailable>()(
	"SessionExecutionUnavailable",
	{ session: Session.Id },
) {}

export class SessionConflict extends Schema.TaggedError<SessionConflict>()(
	"SessionConflict",
	{ message: Schema.String },
) {}
export class SessionInvalidRecord extends Schema.TaggedError<SessionInvalidRecord>()(
	"SessionInvalidRecord",
	{ message: Schema.String },
) {}
export class SessionStorageUnavailable extends Schema.TaggedError<SessionStorageUnavailable>()(
	"SessionStorageUnavailable",
	{},
) {}
export class SessionModelInvalid extends Schema.TaggedError<SessionModelInvalid>()(
	"SessionModelInvalid",
	{
		reason: Schema.Literals([
			"provider-not-found",
			"model-not-found",
			"unsupported-option",
		]),
		message: Schema.String,
	},
) {}

export const SessionOperationErrors = [
	SessionNotFound.pipe(HttpApiSchema.status(404)),
	SessionBusy.pipe(HttpApiSchema.status(409)),
	SessionConflict.pipe(HttpApiSchema.status(409)),
	SessionInvalidRecord.pipe(HttpApiSchema.status(400)),
	SessionStorageUnavailable.pipe(HttpApiSchema.status(503)),
	SessionModelInvalid.pipe(HttpApiSchema.status(400)),
] as const
const sessionParams = { sessionId: Session.Id.check(Schema.isMinLength(1)) }
export const SessionModels = Schema.Struct({
	selected: Schema.optionalKey(Config.Selection),
	providers: Schema.Array(Config.Provider),
	models: Schema.Array(Config.Model),
})
export type SessionModels = typeof SessionModels.Type

export const SelectSessionModelRequest = Schema.Struct({
	expected: Session.Revision,
	selection: Config.Selection,
})
export type SelectSessionModelRequest = typeof SelectSessionModelRequest.Type

export const UpdateSessionRequest = Schema.Struct({
	expected: Session.Revision,
	title: Schema.optionalKey(Schema.String),
	archived: Schema.optionalKey(Schema.Boolean),
})
export const ForkSessionRequest = Schema.Struct({
	version: Schema.optionalKey(CoreMemory.VersionId),
	title: Schema.optionalKey(Schema.String),
	settings: Schema.optionalKey(SettingsPatch),
})
export const RestoreSessionRequest = Schema.Struct({
	record: SessionStore.Record,
	expected: Schema.NullOr(Session.Ref),
})
export const UpdateMemoryRequest = Schema.Struct({
	expected: CoreMemory.VersionId,
	revision: Session.Revision,
	command: Memory.Command,
})
export type UpdateMemoryRequest = typeof UpdateMemoryRequest.Type

export type UpdateSessionRequest = typeof UpdateSessionRequest.Type

export type ForkSessionRequest = typeof ForkSessionRequest.Type

export type RestoreSessionRequest = typeof RestoreSessionRequest.Type

export const SessionsApi = HttpApiGroup.make("sessions")
	.add(
		HttpApiEndpoint.get("sessionVersions", "/v1/sessions/:sessionId/versions", {
			params: { sessionId: Session.Id.check(Schema.isMinLength(1)) },
			success: Schema.Array(CoreMemory.Version),
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.post("createSession", "/v1/sessions", {
			payload: CreateSessionRequest,
			success: SessionView.pipe(HttpApiSchema.status(201)),
			error: SessionOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Creates an idle Session without calling a model. The latest response is null.",
		),
		HttpApiEndpoint.post("startTurn", "/v1/sessions/:sessionId/turns", {
			params: { sessionId: Session.Id.check(Schema.isMinLength(1)) },
			payload: StartTurnRequest,
			success: [
				SessionResponse.pipe(HttpApiSchema.status(202)),
				HttpApiSchema.StreamSse({ events: SessionResponseSseEvent }).pipe(
					HttpApiSchema.status(200),
				),
			],
			error: [
				...SessionOperationErrors,
				SessionExecutionUnavailable.pipe(HttpApiSchema.status(503)),
			],
		}).annotate(
			OpenApi.Description,
			"Accepts text input and returns an in_progress response. The host scope owns the execution. Read the Session's response for results. Unsupported fields or input types return 400.",
		),
		HttpApiEndpoint.get("getSession", "/v1/sessions/:sessionId", {
			params: { sessionId: Session.Id.check(Schema.isMinLength(1)) },
			success: SessionView,
			error: SessionOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Returns the current core view and the latest response, with its status, output and error. Reading never starts execution.",
		),
	)
	.add(
		HttpApiEndpoint.put("selectSessionMode", "/v1/sessions/:sessionId/mode", {
			params: sessionParams,
			payload: Schema.Struct({
				expected: Session.Revision,
				mode: Config.Mode,
			}),
			success: SessionView,
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.get("sessionModels", "/v1/sessions/:sessionId/models", {
			params: sessionParams,
			success: SessionModels,
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.put("selectSessionModel", "/v1/sessions/:sessionId/model", {
			params: sessionParams,
			payload: SelectSessionModelRequest,
			success: SessionView,
			error: [
				...SessionOperationErrors,
				SessionExecutionUnavailable.pipe(HttpApiSchema.status(503)),
			],
		}).annotate(
			OpenApi.Description,
			"Checks and saves the Session model selection. The Session revision guards against concurrent changes.",
		),
		HttpApiEndpoint.get("sessionMemory", "/v1/sessions/:sessionId/memory", {
			params: sessionParams,
			success: Memory.State,
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.post(
			"updateSessionMemory",
			"/v1/sessions/:sessionId/memory",
			{
				params: sessionParams,
				payload: UpdateMemoryRequest,
				success: SessionView,
				error: SessionOperationErrors,
			},
		),
		HttpApiEndpoint.get("listSessions", "/v1/sessions", {
			query: {
				archived: Schema.optionalKey(Schema.Literals(["true", "false"])),
			},
			success: Schema.Array(SessionSummary),
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.patch("updateSession", "/v1/sessions/:sessionId", {
			params: sessionParams,
			payload: UpdateSessionRequest,
			success: SessionView,
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.delete("deleteSession", "/v1/sessions/:sessionId", {
			params: sessionParams,
			success: HttpApiSchema.NoContent,
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.post("forkSession", "/v1/sessions/:sessionId/fork", {
			params: sessionParams,
			payload: ForkSessionRequest,
			success: SessionView.pipe(HttpApiSchema.status(201)),
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.get("sessionHistory", "/v1/sessions/:sessionId/history", {
			params: sessionParams,
			query: { version: Schema.optionalKey(CoreMemory.VersionId) },
			success: CoreMemory.State({}),
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.get("exportSession", "/v1/sessions/:sessionId/record", {
			params: sessionParams,
			success: SessionStore.Record,
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.put("restoreSession", "/v1/sessions/:sessionId/record", {
			params: sessionParams,
			payload: RestoreSessionRequest,
			success: SessionView,
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.get("waitSession", "/v1/sessions/:sessionId/wait", {
			params: sessionParams,
			query: {
				after: Schema.FiniteFromString.pipe(Schema.decodeTo(Session.Revision)),
				afterActivity: Schema.optionalKey(
					Schema.Literals(["active", "inactive", "historical"]),
				),
				timeoutMs: Schema.optionalKey(
					Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0)),
				),
			},
			success: SessionView,
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.post("resumeSession", "/v1/sessions/:sessionId/resume", {
			params: sessionParams,
			success: SessionView,
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.put(
			"updateSessionSettings",
			"/v1/sessions/:sessionId/settings",
			{
				params: sessionParams,
				payload: Schema.Struct({
					expected: Session.Revision,
					settings: Turn.Settings,
				}),
				success: SessionView,
				error: [
					...SessionOperationErrors,
					SessionModelInvalid.pipe(HttpApiSchema.status(400)),
				],
			},
		),
		HttpApiEndpoint.get("sessionTurns", "/v1/sessions/:sessionId/turns", {
			params: sessionParams,
			query: {
				after: Schema.optionalKey(Turn.Id),
				limit: Schema.optionalKey(Schema.FiniteFromString),
			},
			success: Schema.Struct({
				items: Schema.Array(Turn.Record),
				next: Schema.NullOr(Turn.Id),
			}),
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.get("getTurn", "/v1/sessions/:sessionId/turns/:turnId", {
			params: { ...sessionParams, turnId: Turn.Id },
			success: Schema.Struct({ turn: Turn.Record, response: SessionResponse }),
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.get(
			"turnItems",
			"/v1/sessions/:sessionId/turns/:turnId/items",
			{
				params: { ...sessionParams, turnId: Turn.Id },
				query: {
					after: Schema.optionalKey(Item.Id),
					limit: Schema.optionalKey(Schema.FiniteFromString),
				},
				success: Schema.Struct({
					items: Schema.Array(Item.Record),
					next: Schema.NullOr(Item.Id),
				}),
				error: SessionOperationErrors,
			},
		),
		HttpApiEndpoint.post(
			"steerTurn",
			"/v1/sessions/:sessionId/turns/:turnId/steer",
			{
				params: { ...sessionParams, turnId: Turn.Id },
				payload: Schema.Struct({ input: StartTurnRequest.fields.input }),
				success: Schema.Struct({
					session: Session.Id,
					turn: Turn.Id,
					item: Item.Id,
					revision: Session.Revision,
					version: CoreMemory.VersionId,
				}).pipe(HttpApiSchema.status(202)),
				error: SessionOperationErrors,
			},
		),
		HttpApiEndpoint.post("enqueueMessage", "/v1/sessions/:sessionId/queue", {
			params: sessionParams,
			payload: Schema.Struct({
				input: StartTurnRequest.fields.input,
				expected: Schema.optionalKey(Session.Revision),
			}),
			success: Schema.Struct({
				session: Session.Id,
				item: Item.Id,
				revision: Session.Revision,
			}).pipe(HttpApiSchema.status(202)),
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.post(
			"interruptTurn",
			"/v1/sessions/:sessionId/turns/:turnId/interrupt",
			{
				params: { ...sessionParams, turnId: Turn.Id },
				payload: Schema.Struct({}),
				success: SessionView,
				error: SessionOperationErrors,
			},
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
