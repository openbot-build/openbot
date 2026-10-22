import { AgentAuth } from "./AuthApi.ts"
import {
	Config,
	Item,
	Timeline,
	Session,
	SessionStore,
	Turn,
} from "@openbot-build/core"
import * as Memory from "./Memory.ts"
import { Authorize, GroupRequired, Required, requires } from "./Permissions.ts"
import { AgentErrors, AgentId, Delegation } from "./AgentsApi.ts"
import { Name } from "./Name.ts"
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
})
export const CreateSessionRequest = Schema.Struct({
	/** The Agent that works in the Session. Without it, the Main Agent of the caller works. */
	agent: Schema.optionalKey(AgentId),
	title: Schema.optionalKey(Name),
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
/** The status of a response. response.cancelled is an OpenBot extension. */
export const ResponseStatus = Schema.Literals([
	"in_progress",
	"completed",
	"incomplete",
	"failed",
	"cancelled",
])
export type ResponseStatus = typeof ResponseStatus.Type
const OutputMessage = Schema.Struct({
	id: Item.Id,
	type: Schema.Literal("message"),
	role: Schema.Literal("assistant"),
	status: ResponseStatus.pick(["in_progress", "completed", "incomplete"]),
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
	version: Timeline.VersionId,
	background: Schema.Literal(true),
	status: ResponseStatus,
	output: Schema.Array(OutputMessage),
	error: Schema.NullOr(
		Schema.Struct({
			code: Turn.FailureCode,
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

/** A subset of the Responses text events. response.cancelled is an OpenBot extension. */
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
/** The `type` of each Responses event, such as `response.created`. */
export const SessionResponseEventType = Schema.Literals(
	SessionResponseEvent.members.map((member) => member.fields.type.literal),
)
export type SessionResponseEventType = typeof SessionResponseEventType.Type

/** Codec for the native SSE envelope. data is a JSON event, not an already encoded string. */
const SseEventSchema = Schema.Struct({
	...Sse.EventEncoded.fields,
	event: SessionResponseEventType,
	data: Schema.fromJsonString(SessionResponseEvent),
}).check(
	Schema.makeFilter(
		({ event, data }) =>
			event === data.type || "SSE event must match data.type",
	),
)
export type SessionResponseSseEvent = typeof SseEventSchema.Type
/**
 * The explicit type keeps the declared type of the whole contract small enough
 * for the TypeScript declaration emitter. It refers to the alias above by name.
 */
export const SessionResponseSseEvent: Schema.Codec<
	SessionResponseSseEvent,
	typeof SseEventSchema.Encoded
> = SseEventSchema

/**
 * Why a Session exists. A direct Session is work that a client started.
 * A delegated Session is work that another Agent gave. A review Session decides one request.
 */
export const SessionKind = Schema.Literals(["direct", "delegated", "review"])
export type SessionKind = typeof SessionKind.Type
/** The tool call in another Session that started this Session. */
export const SessionParent = Schema.Struct({
	session: Session.Id,
	turn: Turn.Id,
	toolCallId: Schema.String,
})
export type SessionParent = typeof SessionParent.Type

/**
 * Whether a Session runs work now. `historical` means that the Session says it
 * runs, but no process runs it.
 */
export const SessionActivity = Schema.Literals([
	"active",
	"inactive",
	"historical",
])
export type SessionActivity = typeof SessionActivity.Type

/** The current core view, plus the latest message in the Responses format. */
export const SessionView = Schema.Struct({
	...Session.View({}).fields,
	agent: AgentId,
	kind: SessionKind,
	parent: Schema.NullOr(SessionParent),
	response: Schema.NullOr(SessionResponse),
	activity: Schema.optionalKey(SessionActivity),
})
export type SessionView = typeof SessionView.Type

/** The list view. It leaves out state, message content and response output. */
export const SessionSummary = Schema.Struct({
	session: Session.Ref,
	agent: AgentId,
	kind: SessionKind,
	parent: Schema.NullOr(SessionParent),
	status: Schema.Literals(["Idle", ...Turn.StatusTag.literals]),
	turn: Schema.NullOr(Turn.Id),
	response: Schema.NullOr(
		Schema.Struct({
			id: Turn.Id,
			created_at: Schema.Natural,
			status: SessionResponse.fields.status,
			version: Timeline.VersionId,
		}),
	),
	activity: SessionActivity,
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
		reason: Config.SelectionReason,
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
	/** A new title. `null` removes the title. */
	title: Schema.optionalKey(Schema.NullOr(Name)),
	archived: Schema.optionalKey(Schema.Boolean),
})
export const ForkSessionRequest = Schema.Struct({
	version: Schema.optionalKey(Timeline.VersionId),
	/** The title of the Fork. Without it, the Fork keeps the title of its source. */
	title: Schema.optionalKey(Name),
	settings: Schema.optionalKey(SettingsPatch),
})
export const RestoreSessionRequest = Schema.Struct({
	record: SessionStore.Record,
	expected: Schema.NullOr(Session.Ref),
})
/** The memory switches that one Session sets. A missing switch follows the server default. */
export const MemoryOverrides = Schema.Struct({
	use: Schema.optionalKey(Schema.Boolean),
	generate: Schema.optionalKey(Schema.Boolean),
})
export type MemoryOverrides = typeof MemoryOverrides.Type
/** Learned memory, the switches in use, and the switches that this Session sets. */
export const SessionMemory = Schema.Struct({
	...Memory.State.fields,
	settings: Memory.Settings,
	overrides: MemoryOverrides,
})
export type SessionMemory = typeof SessionMemory.Type
/**
 * Remember and Forget edit one entry. Configure sets the switches of this Session:
 * a boolean sets a switch, null makes it follow the server default, and a missing field keeps it.
 * Refresh learns from the history now.
 */
export const MemoryCommand = Schema.Union([
	Memory.Edit,
	Schema.TaggedStruct("Configure", {
		use: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
		generate: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	}),
	Schema.TaggedStruct("Refresh", {}),
])
export type MemoryCommand = typeof MemoryCommand.Type
export const UpdateMemoryRequest = Schema.Struct({
	expected: Timeline.VersionId,
	revision: Session.Revision,
	command: MemoryCommand,
})
export type UpdateMemoryRequest = typeof UpdateMemoryRequest.Type

export type UpdateSessionRequest = typeof UpdateSessionRequest.Type

export type ForkSessionRequest = typeof ForkSessionRequest.Type

export type RestoreSessionRequest = typeof RestoreSessionRequest.Type

/** Work that calls a model needs its own permission. */
const run = [requires("responses.run").on("session", "sessionId")]

export class SessionsApi extends HttpApiGroup.make("sessions")
	.add(
		HttpApiEndpoint.get("sessionVersions", "/v1/sessions/:sessionId/versions", {
			params: { sessionId: Session.Id.check(Schema.isMinLength(1)) },
			success: Schema.Array(Timeline.Version),
			error: SessionOperationErrors,
		}),
		HttpApiEndpoint.post("createSession", "/v1/sessions", {
			payload: CreateSessionRequest,
			success: SessionView.pipe(HttpApiSchema.status(201)),
			error: [...SessionOperationErrors, ...AgentErrors],
		}).annotate(
			OpenApi.Description,
			"Creates an idle Session for an Agent without calling a model. Without `agent`, the Main Agent of the caller works in it. The latest response is null.",
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
		})
			.annotate(Required, run)
			.annotate(
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
		})
			.annotate(Required, [
				requires("sessions.write").on("session", "sessionId"),
				requires("models.use").on("model"),
			])
			.annotate(
				OpenApi.Description,
				"Checks and saves the Session model selection. The Session revision guards against concurrent changes.",
			),
		HttpApiEndpoint.get("sessionMemory", "/v1/sessions/:sessionId/memory", {
			params: sessionParams,
			success: SessionMemory,
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
				agent: Schema.optionalKey(AgentId),
				kind: Schema.optionalKey(SessionKind),
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
			query: { version: Schema.optionalKey(Timeline.VersionId) },
			success: Timeline.State({}),
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
				afterActivity: Schema.optionalKey(SessionActivity),
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
		}).annotate(Required, run),
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
					version: Timeline.VersionId,
				}).pipe(HttpApiSchema.status(202)),
				error: SessionOperationErrors,
			},
		).annotate(Required, run),
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
		}).annotate(Required, run),
		HttpApiEndpoint.get(
			"sessionDelegations",
			"/v1/sessions/:sessionId/delegations",
			{
				params: sessionParams,
				success: Schema.Array(Delegation),
				error: SessionOperationErrors,
			},
		).annotate(
			OpenApi.Description,
			"Lists the work that this Session gave to other Agents, with its status and result.",
		),
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
	.annotate(GroupRequired, {
		read: [requires("sessions.read").on("session", "sessionId")],
		write: [requires("sessions.write").on("session", "sessionId")],
	})
	.middleware(Authorize)
	.middleware(AgentAuth) {}
