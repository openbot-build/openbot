import {
	type McpUiHostContext,
	type McpUiMessageRequest,
	type McpUiMessageResult,
	type McpUiOpenLinkRequest,
	type McpUiOpenLinkResult,
	type McpUiRequestDisplayModeRequest,
	type McpUiRequestDisplayModeResult,
	type McpUiSizeChangedNotification,
	type McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import { type CallToolResult } from "@modelcontextprotocol/client"
import { Context, Effect, type Option, Schema } from "effect"
import type * as Store from "../connections/Store.ts"
import * as Ui from "./Ui.ts"

export class HostActionDenied extends Schema.TaggedError<HostActionDenied>()(
	"HostActionDenied",
	{
		action: Schema.String,
	},
) {}

export interface Source {
	readonly key: Store.ConnectionKey
	readonly tool: string
}

export class HostActions extends Context.Service<
	HostActions,
	{
		readonly contentTypes?: {
			readonly text?: {}
			readonly image?: {}
			readonly audio?: {}
			readonly resource?: {}
		}
		readonly message?: (
			source: Source,
			params: McpUiMessageRequest["params"],
		) => Effect.Effect<McpUiMessageResult, HostActionDenied>
		readonly openLink?: (
			source: Source,
			params: McpUiOpenLinkRequest["params"],
		) => Effect.Effect<McpUiOpenLinkResult, HostActionDenied>
		readonly updateModelContext?: (
			source: Source,
			params: McpUiUpdateModelContextRequest["params"],
		) => Effect.Effect<void, HostActionDenied>
		readonly displayMode?: (
			source: Source,
			params: McpUiRequestDisplayModeRequest["params"],
		) => Effect.Effect<McpUiRequestDisplayModeResult, HostActionDenied>
		readonly size?: (
			source: Source,
			params: McpUiSizeChangedNotification["params"],
		) => Effect.Effect<void, HostActionDenied>
	}
>()("@openbot-build/protocol/apps/Apps/HostActions") {}

export const State = Schema.TaggedUnion({
	Loading: {},
	Initializing: {},
	Ready: {},
	Failed: {
		reason: Schema.String,
		issue: Schema.String,
	},
	Closed: {},
})

export type State = typeof State.Type

export interface Session {
	readonly state: Effect.Effect<State>
	readonly ready: Effect.Effect<void, Ui.UiError>
	readonly result: Effect.Effect<Option.Option<CallToolResult>>
	readonly inputPartial: (
		args: Schema.JsonObject,
	) => Effect.Effect<void, Ui.UiError>
	readonly input: (args: Schema.JsonObject) => Effect.Effect<void, Ui.UiError>
	readonly toolResult: (
		result: CallToolResult,
	) => Effect.Effect<void, Ui.UiError>
	readonly cancel: (reason: string) => Effect.Effect<void, Ui.UiError>
	readonly hostContext: (
		context: McpUiHostContext,
	) => Effect.Effect<void, Ui.UiError>
	readonly reload: Effect.Effect<void, Ui.UiError>
	readonly close: Effect.Effect<void>
}
