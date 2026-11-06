import { Identity } from "@openbot-build/domain/Identity"
import { OpenBotApi } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as HttpErrors from "@openbot-build/server-execution/HttpErrors"
import * as ChatErrors from "@openbot-build/conversation-contract/chats/ChatErrors"
import * as ToolQueries from "@openbot-build/conversation-contract/chats/ToolQueries"

export const layer = HttpApiBuilder.group(OpenBotApi, "toolCalls", (handlers) =>
	Effect.gen(function* () {
		const queries = yield* ToolQueries.make
		const safe = yield* HttpErrors.make
		return handlers
			.handle("list", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					queries.list(caller, params.chatId),
				).pipe(ChatErrors.map, safe),
			)
			.handle("get", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					queries.read(caller, params.chatId, params.id),
				).pipe(ChatErrors.map, safe),
			)
	}),
)
