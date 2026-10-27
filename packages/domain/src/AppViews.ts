import { Chat, Item, Turn } from "@openbot-build/core"
import { Array as Arr, Schema } from "effect"
import { Source, AppOperationId } from "./AppCalls.ts"
import { ConnectionId } from "./ConnectionId.ts"
import * as Execution from "./Execution.ts"

export const AppViewId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/AppViewId"))
export type AppViewId = typeof AppViewId.Type

export const Interaction = Schema.Struct({
	revision: Schema.Natural,
	context: Schema.NullOr(Schema.JsonObject),
})
export type Interaction = typeof Interaction.Type
export const Binding = Schema.Struct({
	id: AppViewId,
	operationId: AppOperationId,
	readOnly: Schema.Boolean,
	chat: Chat.Id,
	turn: Turn.Id,
	item: Item.Id,
	source: Source,
	interaction: Interaction,
})
export type Binding = typeof Binding.Type
export const ActionRequest = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("tool"),
		commandKey: Execution.CommandKey,
		name: Schema.NonEmptyString,
		arguments: Schema.JsonObject,
	}),
	Schema.Struct({
		kind: Schema.Literal("resource"),
		commandKey: Execution.CommandKey,
		uri: Schema.NonEmptyString,
	}),
])
export type ActionRequest = typeof ActionRequest.Type
/** The kind of an action that an App view asks for. It comes from `ActionRequest`. */
export const ActionKind = Schema.Literals(
	Arr.map(ActionRequest.members, (member) => member.fields.kind.literal),
)
export type ActionKind = typeof ActionKind.Type
export const ActionSource = Schema.TaggedStruct("AppUiAction", {
	viewId: AppViewId,
	requestId: Schema.String,
	connectionId: ConnectionId,
	revision: Schema.Natural,
	kind: ActionKind,
	target: Schema.String,
})
export type ActionSource = typeof ActionSource.Type
/** The list methods that an App view may call. A view cannot list prompts. */
export const ViewReadAction = Schema.Literals([
	"tools/list",
	"resources/list",
	"resources/templates/list",
])
export type ViewReadAction = typeof ViewReadAction.Type
export const ActionTicket = Schema.Struct({
	...Execution.Receipt.fields,
	chat: Chat.Id,
	turn: Turn.Id,
})
export type ActionTicket = typeof ActionTicket.Type
export class AppViewUnavailable extends Schema.TaggedError<
	AppViewUnavailable,
	{ readonly brand: unique symbol }
>()("AppViewUnavailable", {
	reason: Schema.Literals([
		"Declaration",
		"Resource",
		"ConnectionChanged",
		"Closed",
		"Unsupported",
		"Protocol",
	]),
	message: Schema.String,
}) {}
