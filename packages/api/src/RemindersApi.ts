import { Bots, Execution, Reminders as Domain } from "@openbot-build/domain"
import { Chat } from "@openbot-build/core"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { BotAuth } from "./AuthApi.ts"
import {
	Authorize,
	AuthorizationErrors,
	GroupRequired,
} from "./Authorization.ts"
import { errors as executionErrors } from "./ExecutionsApi.ts"

export const Query = Schema.Struct({
	chatId: Schema.optionalKey(Chat.Id),
	status: Schema.optionalKey(Domain.Status),
	after: Schema.optionalKey(Domain.Id),
	limit: Schema.optionalKey(
		Schema.FiniteFromString.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: 100 }),
		),
	),
})
export type Query = typeof Query.Type
const errors = [
	...AuthorizationErrors,
	...executionErrors,
	Domain.NotFound.pipe(HttpApiSchema.status(404)),
	Domain.Conflict.pipe(HttpApiSchema.status(409)),
	Bots.BotStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const
export class RemindersApi extends HttpApiGroup.make("reminders")
	.add(
		HttpApiEndpoint.get("listReminders", "/v1/reminders", {
			query: Query,
			success: Domain.Page,
			error: errors,
		}),
		HttpApiEndpoint.get("getReminder", "/v1/reminders/:reminderId", {
			params: { reminderId: Domain.Id },
			success: Domain.Reminder,
			error: errors,
		}),
		HttpApiEndpoint.post("cancelReminder", "/v1/reminders/:reminderId/cancel", {
			params: { reminderId: Domain.Id },
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt,
			error: errors,
		}),
	)
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(BotAuth) {}
