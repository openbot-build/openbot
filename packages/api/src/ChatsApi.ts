import {
	ChatConflict,
	ChatNotFound,
	ChatStorageUnavailable,
} from "@openbot-build/domain"
import {
	InputPart as DomainInputPart,
	MessageInput as DomainMessageInput,
} from "@openbot-build/domain"
import { errors as ExecutionErrors } from "./ExecutionsApi.ts"
import {
	ChatSettingsChange as UpdateChatRequest,
	ChatTodoChange as UpdateTodosRequest,
} from "@openbot-build/domain"
import { Execution, ChatModelInvalid } from "@openbot-build/domain"
import { BotAuth } from "./AuthApi.ts"
import { Chat, Config, Item, Turn } from "@openbot-build/core"
import * as BotMemory from "./BotMemory.ts"
import { Authorize, GroupRequired, Required, own } from "./Authorization.ts"
import { BotErrors, BotId } from "./BotsApi.ts"
import { Delegation, DelegationErrors } from "./DelegationsApi.ts"
import { FileInvalid } from "./FilesApi.ts"
import { PlanApproval } from "./PlanApproval.ts"
import { Schema } from "effect"
import { ChatTodos } from "@openbot-build/domain"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"

export const InputPart = DomainInputPart
export type InputPart = typeof InputPart.Type
export const MessageInput = DomainMessageInput
export type MessageInput = typeof MessageInput.Type

/** One message command. Network retries use the same key and body. */
export const ChatCommandRequest = Schema.Struct({
	commandKey: Execution.CommandKey,
	input: MessageInput,
	queue: Schema.optionalKey(Schema.Boolean),
})
export type ChatCommandRequest = typeof ChatCommandRequest.Type
export const ChatCommandReceipt = Schema.Struct({
	...Execution.Receipt.fields,
	chat: Chat.Id,
	turn: Turn.Id,
})
export type ChatCommandReceipt = typeof ChatCommandReceipt.Type

const OutputText = Schema.Struct({
	type: Schema.Literal("output_text"),
	text: Schema.String,
	annotations: Schema.Tuple([]),
})
/** The saved status of one response. */
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

import { ChatKind, ChatParent, OpenWork } from "@openbot-build/domain/Chats"
export { ChatKind, ChatParent, OpenWork } from "@openbot-build/domain/Chats"

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

/** Public Turn data. Saved execution input and unfinished results stay private. */
export const TurnInfo = Schema.Struct({
	id: Turn.Id,
	chat: Chat.Id,
	settings: Turn.Settings,
	action: Schema.optionalKey(Turn.Action),
	author: Schema.optionalKey(Turn.Author),
	activeAction: Turn.Record.fields.activeAction,
	status: Turn.StatusSchema,
	steps: Schema.Natural,
	usage: Turn.Record.fields.usage,
	input: Schema.Array(Item.Id),
	items: Schema.Array(Item.Id),
	startedAt: Schema.Finite,
	completedAt: Schema.optionalKey(Schema.Finite),
})
export type TurnInfo = typeof TurnInfo.Type

/** One Chat, its current Turn and its latest response. It holds no history. */
export const ChatView = Schema.Struct({
	chat: ChatInfo,
	status: ChatStatus,
	turn: Schema.NullOr(TurnInfo),
	response: Schema.NullOr(ChatResponse),
	executionId: Schema.NullOr(Execution.Id),
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
	executionId: Schema.NullOr(Execution.Id),
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

export class ChatExecutionUnavailable extends Schema.TaggedError<
	ChatExecutionUnavailable,
	{ readonly brand: unique symbol }
>()("ChatExecutionUnavailable", { chat: Chat.Id }) {}
export {
	ChatConflict,
	ChatNotFound,
	ChatStorageUnavailable,
} from "@openbot-build/domain"
export { ChatModelInvalid } from "@openbot-build/domain"

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

export { ChatSettingsChange as UpdateChatRequest } from "@openbot-build/domain"

export const InterruptChatRequest = Schema.Struct({
	commandKey: Execution.CommandKey,
	/** Also cancel the work that this Chat gave to Bots. */
	delegations: Schema.optionalKey(Schema.Boolean),
})
export type InterruptChatRequest = typeof InterruptChatRequest.Type

export { TodoStatus, Todo, ChatTodos, todoProblem } from "@openbot-build/domain"

/** Replaces the whole list. `revision` guards against concurrent changes. */
export { ChatTodoChange as UpdateTodosRequest } from "@openbot-build/domain"

const sendSuccess = ChatCommandReceipt.pipe(HttpApiSchema.status(202))
const sendErrors = [
	...ExecutionErrors,
	...ChatOperationErrors,
	FileInvalid.pipe(HttpApiSchema.status(400)),
	ChatExecutionUnavailable.pipe(HttpApiSchema.status(503)),
] as const

export class ChatsApi extends HttpApiGroup.make("chats")
	.add(
		HttpApiEndpoint.post("sendBotMessage", "/v1/bots/:botId/messages", {
			params: { botId: BotId },
			payload: ChatCommandRequest,
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
			payload: ChatCommandRequest,
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
			.annotate(Required, [])
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
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [...ChatOperationErrors, ...ExecutionErrors],
		}).annotate(
			OpenApi.Description,
			"Deletes the history of a direct Chat, a channel Chat or a live Chat. It stops the running Turn and cancels the work that the Chat gave away first. The next message starts an empty Chat.",
		),
		HttpApiEndpoint.get("chatModels", "/v1/chats/:chatId/models", {
			params: chatParams,
			success: ChatModels,
			error: ChatOperationErrors,
		}),
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
				items: Schema.Array(TurnInfo),
				next: Schema.NullOr(Turn.Id),
			}),
			error: ChatOperationErrors,
		}),
		HttpApiEndpoint.get("getTurn", "/v1/chats/:chatId/turns/:turnId", {
			params: { ...chatParams, turnId: Turn.Id },
			success: Schema.Struct({ turn: TurnInfo, response: ChatResponse }),
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
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [...ChatOperationErrors, ...ExecutionErrors],
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
			error: [...ChatOperationErrors, ...DelegationErrors],
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
