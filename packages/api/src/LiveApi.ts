import { BotAuth } from "./AuthApi.ts"
import { Authorize, Required, own } from "./Authorization.ts"
import { BotErrors, BotId } from "./BotsApi.ts"
import {
	ChatExecutionUnavailable,
	ChatOperationErrors,
	ChatView,
	chatParams,
} from "./ChatsApi.ts"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import {
	CreateLiveChatRequest,
	LiveQuery,
	LiveUnavailable,
} from "@openbot-build/domain/Live"
// Explicit names keep namespace exports in the generated declaration files.
export {
	AudioFormat,
	AudioFormatText,
	Capabilities,
	CreateLiveChatRequest,
	LiveClientMessage,
	LiveErrorCode,
	LiveQuery,
	LiveServerMessage,
	LiveUnavailable,
} from "@openbot-build/domain/Live"

export class LiveApi extends HttpApiGroup.make("live")
	.add(
		HttpApiEndpoint.post("createLiveChat", "/v1/bots/:botId/live", {
			params: { botId: BotId },
			payload: CreateLiveChatRequest,
			success: ChatView.pipe(HttpApiSchema.status(201)),
			error: [
				...ChatOperationErrors,
				...BotErrors,
				LiveUnavailable.pipe(HttpApiSchema.status(409)),
			],
		})
			.annotate(Required, [own("run", "Chat"), own("write", "Chat")])
			.annotate(
				OpenApi.Description,
				"Makes a new live Chat of yours with this Bot. Then open its Live WebSocket. You need `bots.delegate` on the Bot and `models.use` on the Live model.",
			),
		HttpApiEndpoint.get("connectLive", "/v1/chats/:chatId/live", {
			params: chatParams,
			query: LiveQuery,
			success: HttpApiSchema.NoContent,
			error: [
				...ChatOperationErrors,
				ChatExecutionUnavailable.pipe(HttpApiSchema.status(503)),
				LiveUnavailable.pipe(HttpApiSchema.status(409)),
			],
		})
			.annotate(Required, [
				own("run", "Chat", "chatId"),
				own("read", "Chat", "chatId"),
			])
			.annotate(
				OpenApi.Description,
				"Opens the Live WebSocket of a live Chat. Each thing the person says starts a Turn, and the Bot answers with sound and text. Turns use the shared execution engine. Sound stays on the open connection. A browser must connect from the public origin.",
			),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.middleware(Authorize)
	.middleware(BotAuth) {}
