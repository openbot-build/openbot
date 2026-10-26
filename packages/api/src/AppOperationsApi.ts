import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Invocation, AppOperationId } from "./AppExecution.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { ChatConflict, chatParams } from "./ChatsApi.ts"
import { Required, own } from "./Authorization.ts"

const errors = [
	...ExperienceErrors,
	ChatConflict.pipe(HttpApiSchema.status(409)),
]
export const AppOperationsApi = HttpApiGroup.make("appOperations").add(
	HttpApiEndpoint.get("get", "/v1/app-operations/:id", {
		params: { id: AppOperationId },
		success: Invocation,
		error: errors,
	}),
	HttpApiEndpoint.get("list", "/v1/chats/:chatId/app-operations", {
		params: chatParams,
		success: Schema.Array(Invocation),
		error: errors,
	}).annotate(Required, [own("read", "Chat", "chatId")]),
	HttpApiEndpoint.post("respond", "/v1/app-operations/:id/inputs", {
		params: { id: AppOperationId },
		payload: Schema.Struct({
			round: Schema.Natural,
			responses: Schema.JsonObject,
		}),
		success: Invocation,
		error: errors,
	}),
)
