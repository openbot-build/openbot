import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { ExecutionView, AppOperationId } from "./AppExecution.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { chatParams } from "./ChatsApi.ts"
import { Required, own } from "./Authorization.ts"

import { Execution } from "@openbot-build/domain"
import { errors as executionErrors } from "./ExecutionsApi.ts"
const errors = [...ExperienceErrors, ...executionErrors]
export const AppOperationsApi = HttpApiGroup.make("appOperations").add(
	HttpApiEndpoint.get("get", "/v1/app-operations/:id", {
		params: { id: AppOperationId },
		success: ExecutionView,
		error: errors,
	}),
	HttpApiEndpoint.get("list", "/v1/chats/:chatId/app-operations", {
		params: chatParams,
		success: Schema.Array(ExecutionView),
		error: errors,
	}).annotate(Required, [own("read", "Chat", "chatId")]),
	HttpApiEndpoint.post("respond", "/v1/app-operations/:id/inputs", {
		params: { id: AppOperationId },
		payload: Schema.Struct({
			commandKey: Execution.CommandKey,
			round: Schema.Natural,
			responses: Schema.JsonObject,
		}),
		success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
		error: errors,
	}),
)
