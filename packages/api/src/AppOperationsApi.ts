import { Chat } from "@openbot-build/core"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Invocation } from "./AppExecution.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { ChatConflict } from "./ChatsApi.ts"
import { Required, requires } from "./Permissions.ts"

const errors = [
	...ExperienceErrors,
	ChatConflict.pipe(HttpApiSchema.status(409)),
]
export const AppOperationsApi = HttpApiGroup.make("appOperations").add(
	HttpApiEndpoint.get("get", "/v1/app-operations/:id", {
		params: { id: Schema.String },
		success: Invocation,
		error: errors,
	}),
	HttpApiEndpoint.get("list", "/v1/chats/:chatId/app-operations", {
		params: { chatId: Chat.Id },
		success: Schema.Array(Invocation),
		error: errors,
	}).annotate(Required, [requires("chats.read").on("chat", "chatId")]),
	HttpApiEndpoint.post("respond", "/v1/app-operations/:id/inputs", {
		params: { id: Schema.String },
		payload: Schema.Struct({
			round: Schema.Natural,
			responses: Schema.JsonObject,
		}),
		success: Invocation,
		error: errors,
	}),
)
