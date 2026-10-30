import { BotId } from "./BotId.ts"
import { FileId } from "./Files.ts"
import { Chat, Config, Item, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import { PlanApproval } from "./PlanApproval.ts"
import { ChatTodos, todoProblem } from "./Todos.ts"
import { DelegationId } from "./DelegationId.ts"

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
	"conversation",
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

/** The selected model cannot serve this Chat. */
export class ChatModelInvalid extends Schema.TaggedError<
	ChatModelInvalid,
	{ readonly brand: unique symbol }
>()("ChatModelInvalid", {
	reason: Config.SelectionReason,
	message: Schema.String,
}) {}

/** Whether one Chat may read and add to the memory of its Bot. */
export const ChatMemory = Schema.Struct({
	read: Schema.Boolean,
	write: Schema.Boolean,
})
export type ChatMemory = typeof ChatMemory.Type
export const defaultChatMemory: ChatMemory = { read: true, write: true }
export const ChatBranch = Schema.Struct({
	chat: Chat.Id,
	revision: Chat.Revision,
	throughSeq: Item.Seq,
	root: Chat.Id,
	reason: Schema.Literals(["fork", "regenerate"]),
})
export type ChatBranch = typeof ChatBranch.Type
export const ChatRequestId = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9_-]{1,96}$/),
)

/** Attaches an existing file to an idle Chat without starting a Turn. */
export const AttachChatFileRequest = Schema.Struct({
	fileId: FileId,
	requestId: ChatRequestId,
	expected: Chat.Revision,
})
export type AttachChatFileRequest = typeof AttachChatFileRequest.Type

export const CreateConversationRequest = Schema.Struct({
	botId: BotId,
	requestId: ChatRequestId,
	memory: Schema.optionalKey(ChatMemory),
})
export type CreateConversationRequest = typeof CreateConversationRequest.Type
export const ForkChatRequest = Schema.Struct({
	expected: Chat.Revision,
	requestId: ChatRequestId,
	through: Schema.optionalKey(
		Schema.Struct({
			turnId: Turn.Id,
			edge: Schema.Literals(["before", "after"]),
		}),
	),
	reason: Schema.Literals(["fork", "regenerate"]),
})
export type ForkChatRequest = typeof ForkChatRequest.Type

/** A settings change is guarded by the saved Chat revision. */
export const ChatSettingsChange = Schema.Struct({
	expected: Chat.Revision,
	memory: Schema.optionalKey(ChatMemory),
	mode: Schema.optionalKey(Config.Mode),
	model: Schema.optionalKey(Schema.NullOr(Config.Selection)),
	planApproval: Schema.optionalKey(Schema.NullOr(PlanApproval)),
})
export type ChatSettingsChange = typeof ChatSettingsChange.Type

export const ChatTodoChange = Schema.Struct({
	revision: Chat.Revision,
	items: ChatTodos.fields.items.check(Schema.makeFilter(todoProblem)),
})
export type ChatTodoChange = typeof ChatTodoChange.Type

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
 * can have text and uploaded files.
 */
export const MessageInput = Schema.Union([
	Schema.NonEmptyString,
	Schema.Array(InputMessage).check(Schema.isMinLength(1)),
])
export type MessageInput = typeof MessageInput.Type

export class ChatConflict extends Schema.TaggedError<
	ChatConflict,
	{ readonly brand: unique symbol }
>()("ChatConflict", { message: Schema.String }) {}

/** Work of a Chat that has not ended yet. It comes back as new input. */
export const OpenWork = Schema.Struct({
	delegations: Schema.Natural,
	requests: Schema.Natural,
	reminders: Schema.Natural,
})
export type OpenWork = typeof OpenWork.Type

export class ChatNotFound extends Schema.TaggedError<
	ChatNotFound,
	{ readonly brand: unique symbol }
>()("ChatNotFound", { chat: Chat.Id }) {}

export class ChatStorageUnavailable extends Schema.TaggedError<
	ChatStorageUnavailable,
	{ readonly brand: unique symbol }
>()("ChatStorageUnavailable", {}) {}
