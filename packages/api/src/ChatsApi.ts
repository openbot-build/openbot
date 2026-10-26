import { BotAuth } from "./AuthApi.ts"
import { Chat, Config, Item, Turn } from "@openbot-build/core"
import * as BotMemory from "./BotMemory.ts"
import { Authorize, GroupRequired, Required, own } from "./Authorization.ts"
import { BotErrors, BotId } from "./BotsApi.ts"
import { Delegation, DelegationId } from "./DelegationsApi.ts"
import { FileId, FileInvalid } from "./FilesApi.ts"
import { PlanApproval } from "./PlanApproval.ts"
import { Array as Arr, HashSet, Schema } from "effect"
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
/** An image file that you uploaded. Its media type must start with `image/`. */
const ImageInput = Schema.Struct({
	type: Schema.Literal("input_image"),
	file_id: FileId,
})
/** A file that you uploaded, such as a PDF. */
const FileInput = Schema.Struct({
	type: Schema.Literal("input_file"),
	file_id: FileId,
})
export const InputPart = Schema.Union([TextInput, ImageInput, FileInput])
export type InputPart = typeof InputPart.Type
const InputMessage = Schema.Struct({
	type: Schema.optionalKey(Schema.Literal("message")),
	role: Schema.Literal("user"),
	content: Schema.Union([
		Schema.NonEmptyString,
		Schema.Array(InputPart).check(Schema.isMinLength(1)),
	]),
})
/**
 * These forms are the same: a string, or a list of user messages. A message
 * can have text, and files from `POST /v1/files`.
 */
export const MessageInput = Schema.Union([
	Schema.NonEmptyString,
	Schema.Array(InputMessage).check(Schema.isMinLength(1)),
])
export type MessageInput = typeof MessageInput.Type

/** A message for a Bot. There is no revision: a message is always taken. */
export const SendMessageRequest = Schema.Struct({
	input: MessageInput,
	/** Send live events when the message starts a new Turn. */
	stream: Schema.optionalKey(Schema.Boolean),
	/** Every Turn runs in the background. Only `true` is allowed. */
	background: Schema.optionalKey(Schema.Literal(true)),
})
export type SendMessageRequest = typeof SendMessageRequest.Type

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
/** One Turn in the Responses format. The conversation is the Chat. */
export const ChatResponse = Schema.Struct({
	usage: Schema.optionalKey(ModelUsage),
	id: Turn.Id,
	object: Schema.Literal("response"),
	created_at: Schema.Natural,
	chat: Chat.Id,
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
export type ChatResponse = typeof ChatResponse.Type

const executionFields = {
	chat: Chat.Id,
	turn: Turn.Id,
	step: Schema.optionalKey(Schema.Natural),
}
const responseEvent = <const T extends string>(type: T) =>
	Schema.Struct({
		...executionFields,
		type: Schema.Literal(type),
		sequence_number: Schema.Natural,
		response: ChatResponse,
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
export const ChatResponseEvent = Schema.Union([
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
export type ChatResponseEvent = typeof ChatResponseEvent.Type
/** The `type` of each Responses event, such as `response.created`. */
export const ChatResponseEventType = Schema.Literals(
	Arr.map(ChatResponseEvent.members, (member) => member.fields.type.literal),
)
export type ChatResponseEventType = typeof ChatResponseEventType.Type

/** Codec for the native SSE envelope. data is a JSON event, not an already encoded string. */
const SseEventSchema = Schema.Struct({
	...Sse.EventEncoded.fields,
	event: ChatResponseEventType,
	data: Schema.fromJsonString(ChatResponseEvent),
}).check(
	Schema.makeFilter(
		({ event, data }) =>
			event === data.type || "SSE event must match data.type",
	),
)
export type ChatResponseSseEvent = typeof SseEventSchema.Type
/**
 * The explicit type keeps the declared type of the whole contract small enough
 * for the TypeScript declaration emitter. It refers to the alias above by name.
 */
export const ChatResponseSseEvent: Schema.Codec<
	ChatResponseSseEvent,
	typeof SseEventSchema.Encoded
> = SseEventSchema

/**
 * Why a Chat exists. OpenBot makes every Chat itself.
 * A direct Chat is the one Chat of a person with a Bot.
 * A channel Chat is one chat of a Channel, such as a Slack channel.
 * A task Chat does one piece of work that was given to a Bot.
 * A review Chat decides one request.
 * A live Chat is a talk with a Bot in real time, with sound. Its model is a Live model.
 */
export const ChatKind = Schema.Literals([
	"direct",
	"channel",
	"task",
	"review",
	"live",
])
export type ChatKind = typeof ChatKind.Type
/** The Chat that gave the work of a task Chat. */
export const ChatParent = Schema.Struct({
	chat: Chat.Id,
	delegation: DelegationId,
})
export type ChatParent = typeof ChatParent.Type

/**
 * Whether a Chat runs work now. `historical` means that the Chat says that it
 * runs, but no process runs it.
 */
export const ChatActivity = Schema.Literals([
	"active",
	"inactive",
	"historical",
])
export type ChatActivity = typeof ChatActivity.Type

/** Work of a Chat that has not ended yet. It comes back as new input. */
export const OpenWork = Schema.Struct({
	delegations: Schema.Natural,
	requests: Schema.Natural,
	reminders: Schema.Natural,
})
export type OpenWork = typeof OpenWork.Type

export const ChatStatus = Schema.Literals(["Idle", ...Turn.StatusTag.literals])
export type ChatStatus = typeof ChatStatus.Type

/** What a Chat is, without its history. */
export const ChatInfo = Schema.Struct({
	id: Chat.Id,
	revision: Chat.Revision,
	kind: ChatKind,
	bot: BotId,
	parent: Schema.NullOr(ChatParent),
	/** The name of the chat on the platform of a Channel. */
	title: Schema.optionalKey(Schema.String),
	settings: Turn.Settings,
	/** Only when this Chat sets how its plans are approved. */
	planApproval: Schema.optionalKey(PlanApproval),
	createdAt: Schema.Finite,
})
export type ChatInfo = typeof ChatInfo.Type

/** One Chat, its current Turn and its latest response. It holds no history. */
export const ChatView = Schema.Struct({
	chat: ChatInfo,
	status: ChatStatus,
	turn: Schema.NullOr(Turn.Record),
	response: Schema.NullOr(ChatResponse),
	activity: ChatActivity,
	/** The number of inputs that wait for a Turn. */
	inbox: Schema.Natural,
	open: OpenWork,
})
export type ChatView = typeof ChatView.Type

/** The list view. It leaves out the response output. */
export const ChatSummary = Schema.Struct({
	chat: ChatInfo,
	status: ChatStatus,
	turn: Schema.NullOr(Turn.Id),
	response: Schema.NullOr(
		Schema.Struct({
			id: Turn.Id,
			created_at: Schema.Natural,
			status: ResponseStatus,
		}),
	),
	activity: ChatActivity,
})
export type ChatSummary = typeof ChatSummary.Type

/**
 * What happened to a message. `started` began a new Turn. `steered` went into the
 * running Turn, so the Bot reads it at its next step. `queued` waits until the
 * running Turn of another person ends.
 */
export const MessageReceipt = Schema.Struct({
	delivery: Schema.Literals(["started", "steered", "queued"]),
	chat: Chat.Id,
	item: Item.Id,
	turn: Schema.NullOr(Turn.Id),
	response: Schema.NullOr(ChatResponse),
})
export type MessageReceipt = typeof MessageReceipt.Type

export class ChatNotFound extends Schema.TaggedError<
	ChatNotFound,
	{ readonly brand: unique symbol }
>()("ChatNotFound", { chat: Chat.Id }) {}
export class ChatExecutionUnavailable extends Schema.TaggedError<
	ChatExecutionUnavailable,
	{ readonly brand: unique symbol }
>()("ChatExecutionUnavailable", { chat: Chat.Id }) {}
export class ChatConflict extends Schema.TaggedError<
	ChatConflict,
	{ readonly brand: unique symbol }
>()("ChatConflict", { message: Schema.String }) {}
export class ChatStorageUnavailable extends Schema.TaggedError<
	ChatStorageUnavailable,
	{ readonly brand: unique symbol }
>()("ChatStorageUnavailable", {}) {}
export class ChatModelInvalid extends Schema.TaggedError<
	ChatModelInvalid,
	{ readonly brand: unique symbol }
>()("ChatModelInvalid", {
	reason: Config.SelectionReason,
	message: Schema.String,
}) {}

export const ChatOperationErrors = [
	ChatNotFound.pipe(HttpApiSchema.status(404)),
	ChatConflict.pipe(HttpApiSchema.status(409)),
	ChatStorageUnavailable.pipe(HttpApiSchema.status(503)),
	ChatModelInvalid.pipe(HttpApiSchema.status(400)),
] as const
export const chatParams = { chatId: Chat.Id.check(Schema.isMinLength(1)) }
export const ChatModels = Schema.Struct({
	selected: Schema.optionalKey(Config.Selection),
	providers: Schema.Array(Config.Provider),
	models: Schema.Array(Config.Model),
})
export type ChatModels = typeof ChatModels.Type

export const UpdateChatRequest = Schema.Struct({
	expected: Chat.Revision,
	mode: Schema.optionalKey(Config.Mode),
	/** `null` makes the Chat use the model of its Bot again. */
	model: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	/** `null` makes the Chat follow its Bot and the member again. */
	planApproval: Schema.optionalKey(Schema.NullOr(PlanApproval)),
})
export type UpdateChatRequest = typeof UpdateChatRequest.Type

export const InterruptChatRequest = Schema.Struct({
	/** Also cancel the work that this Chat gave to Bots. */
	delegations: Schema.optionalKey(Schema.Boolean),
})
export type InterruptChatRequest = typeof InterruptChatRequest.Type

/** Where one item of a todo list is. */
export const TodoStatus = Schema.Literals(["pending", "in_progress", "done"])
export type TodoStatus = typeof TodoStatus.Type
/** One step of the work in a Chat. */
export const Todo = Schema.Struct({
	id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
	status: TodoStatus,
})
export type Todo = typeof Todo.Type
/**
 * The todo list of a Chat. While an item is not done, the Bot goes on working.
 * When every item is done at the end of a Turn, the list becomes empty.
 */
export const ChatTodos = Schema.Struct({
	items: Schema.Array(Todo).check(Schema.isMaxLength(1000)),
})
export type ChatTodos = typeof ChatTodos.Type
/** Why a todo list is not valid, or undefined when it is valid. */
export const todoProblem = (items: ReadonlyArray<Todo>): string | undefined => {
	const ids = HashSet.fromIterable(Arr.map(items, (item) => item.id))
	if (HashSet.size(ids) !== items.length) return "Each todo needs its own id."
	if (Arr.filter(items, (item) => item.status === "in_progress").length > 1)
		return "Only one todo can be in progress at a time."
	return undefined
}

/** Replaces the whole list. `revision` guards against concurrent changes. */
export const UpdateTodosRequest = Schema.Struct({
	revision: Chat.Revision,
	items: ChatTodos.fields.items.check(Schema.makeFilter(todoProblem)),
})
export type UpdateTodosRequest = typeof UpdateTodosRequest.Type

const sendSuccess = [
	MessageReceipt.pipe(HttpApiSchema.status(202)),
	HttpApiSchema.StreamSse({ events: ChatResponseSseEvent }).pipe(
		HttpApiSchema.status(200),
	),
] as const
const sendErrors = [
	...ChatOperationErrors,
	FileInvalid.pipe(HttpApiSchema.status(400)),
	ChatExecutionUnavailable.pipe(HttpApiSchema.status(503)),
] as const

export class ChatsApi extends HttpApiGroup.make("chats")
	.add(
		HttpApiEndpoint.post("sendBotMessage", "/v1/bots/:botId/messages", {
			params: { botId: BotId },
			payload: SendMessageRequest,
			success: sendSuccess,
			error: [...sendErrors, ...BotErrors],
		})
			.annotate(Required, [own("run", "Chat"), own("write", "Chat")])
			.annotate(
				OpenApi.Description,
				"Sends a message to your Chat with this Bot. OpenBot makes the Chat the first time. When the Bot is free, the message starts a Turn at once. When the Bot works for you, it reads the message at its next step. You need `bots.delegate` on the Bot.",
			),
		HttpApiEndpoint.post("sendMessage", "/v1/chats/:chatId/messages", {
			params: chatParams,
			payload: SendMessageRequest,
			success: sendSuccess,
			error: sendErrors,
		})
			.annotate(Required, [own("run", "Chat", "chatId")])
			.annotate(
				OpenApi.Description,
				"Sends a message to a direct Chat, a task Chat or a live Chat. In a task Chat, the Bot reads it as a message from you. In a live Chat, the message waits until a Live session is open.",
			),
		HttpApiEndpoint.get("listChats", "/v1/chats", {
			query: {
				bot: Schema.optionalKey(BotId),
				kind: Schema.optionalKey(ChatKind),
			},
			success: Schema.Array(ChatSummary),
			error: ChatOperationErrors,
		})
			.annotate(Required, [own("read", "Chat")])
			.annotate(
				OpenApi.Description,
				"Lists your Chats. Without `kind`, it lists direct Chats, channel Chats and live Chats.",
			),
		HttpApiEndpoint.get("getChat", "/v1/chats/:chatId", {
			params: chatParams,
			success: ChatView,
			error: ChatOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Returns the Chat, its current Turn and its latest response. Reading never starts work.",
		),
		HttpApiEndpoint.patch("updateChat", "/v1/chats/:chatId", {
			params: chatParams,
			payload: UpdateChatRequest,
			success: ChatView,
			error: [
				...ChatOperationErrors,
				ChatExecutionUnavailable.pipe(HttpApiSchema.status(503)),
			],
		}).annotate(
			OpenApi.Description,
			"Changes the mode, the model or the plan approval of the Chat. A new model also needs `models.use`.",
		),
		HttpApiEndpoint.delete("deleteChat", "/v1/chats/:chatId", {
			params: chatParams,
			success: HttpApiSchema.NoContent,
			error: ChatOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Deletes the history of a direct Chat, a channel Chat or a live Chat. It stops the running Turn and cancels the work that the Chat gave away first. The next message starts an empty Chat.",
		),
		HttpApiEndpoint.get("chatModels", "/v1/chats/:chatId/models", {
			params: chatParams,
			success: ChatModels,
			error: ChatOperationErrors,
		}),
		HttpApiEndpoint.get("waitChat", "/v1/chats/:chatId/wait", {
			params: chatParams,
			query: {
				after: Schema.FiniteFromString.pipe(Schema.decodeTo(Chat.Revision)),
				afterActivity: Schema.optionalKey(ChatActivity),
				timeoutMs: Schema.optionalKey(
					Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0)),
				),
			},
			success: ChatView,
			error: ChatOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Answers when the revision of the Chat is no longer `after`, or when the timeout ends. The longest wait is 30 seconds.",
		),
		HttpApiEndpoint.get("chatItems", "/v1/chats/:chatId/items", {
			params: chatParams,
			query: {
				before: Schema.optionalKey(
					Schema.FiniteFromString.pipe(Schema.decodeTo(Item.Seq)),
				),
				limit: Schema.optionalKey(Schema.FiniteFromString),
			},
			success: Schema.Struct({
				items: Schema.Array(Item.Record),
				next: Schema.NullOr(Item.Seq),
			}),
			error: ChatOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Items of the Chat, newest first. Send `next` as `before` to read older Items.",
		),
		HttpApiEndpoint.get("chatTurns", "/v1/chats/:chatId/turns", {
			params: chatParams,
			query: {
				after: Schema.optionalKey(Turn.Id),
				limit: Schema.optionalKey(Schema.FiniteFromString),
			},
			success: Schema.Struct({
				items: Schema.Array(Turn.Record),
				next: Schema.NullOr(Turn.Id),
			}),
			error: ChatOperationErrors,
		}),
		HttpApiEndpoint.get("getTurn", "/v1/chats/:chatId/turns/:turnId", {
			params: { ...chatParams, turnId: Turn.Id },
			success: Schema.Struct({ turn: Turn.Record, response: ChatResponse }),
			error: ChatOperationErrors,
		}),
		HttpApiEndpoint.get("turnItems", "/v1/chats/:chatId/turns/:turnId/items", {
			params: { ...chatParams, turnId: Turn.Id },
			query: {
				after: Schema.optionalKey(Item.Id),
				limit: Schema.optionalKey(Schema.FiniteFromString),
			},
			success: Schema.Struct({
				items: Schema.Array(Item.Record),
				next: Schema.NullOr(Item.Id),
			}),
			error: ChatOperationErrors,
		}),
		HttpApiEndpoint.post("interruptChat", "/v1/chats/:chatId/interrupt", {
			params: chatParams,
			payload: InterruptChatRequest,
			success: ChatView,
			error: ChatOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Stops the running Turn. The work that the Chat gave to Bots goes on, unless `delegations` is true.",
		),
		HttpApiEndpoint.get("chatTodos", "/v1/chats/:chatId/todos", {
			params: chatParams,
			success: ChatTodos,
			error: ChatOperationErrors,
		}),
		HttpApiEndpoint.put("updateChatTodos", "/v1/chats/:chatId/todos", {
			params: chatParams,
			payload: UpdateTodosRequest,
			success: ChatView,
			error: ChatOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Replaces the todo list of the Chat. The Bot also changes it with its todo tool.",
		),
		HttpApiEndpoint.get("chatDelegations", "/v1/chats/:chatId/delegations", {
			params: chatParams,
			success: Schema.Array(Delegation),
			error: ChatOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the work that this Chat gave to Bots, with its status and result.",
		),
		HttpApiEndpoint.get("chatConfessions", "/v1/chats/:chatId/confessions", {
			params: chatParams,
			success: Schema.Array(BotMemory.Confession),
			error: ChatOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Lists what the Bot said with `confide` in this Chat, and the answers that it got. The Bot uses it to talk about how its work goes. See the client guide before you show it to people.",
		),
		HttpApiEndpoint.get("chatEnrichments", "/v1/chats/:chatId/enrichments", {
			params: chatParams,
			success: Schema.Array(BotMemory.Enrichment),
			error: ChatOperationErrors,
		}).annotate(
			OpenApi.Description,
			"Lists what the memory Bot added to the input of each Turn, and the Bot memory entries that it used.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.annotate(GroupRequired, {
		read: [own("read", "Chat", "chatId")],
		write: [own("write", "Chat", "chatId")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}
