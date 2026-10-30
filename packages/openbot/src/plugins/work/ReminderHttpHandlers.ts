import { OpenBotApi } from "@openbot-build/api"
import { Identity } from "@openbot-build/domain"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as HttpErrors from "../../execution/HttpErrors.ts"
import * as Queries from "./ReminderQueries.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "reminders", (handlers) =>
	Effect.gen(function* () {
		const reminders = yield* Queries.make
		const safe = yield* HttpErrors.make
		return handlers
			.handle("listReminders", ({ query }) =>
				Effect.flatMap(Identity, (caller) =>
					reminders.list(caller, query),
				).pipe(safe),
			)
			.handle("getReminder", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					reminders.get(caller, params.reminderId),
				).pipe(safe),
			)
			.handle("cancelReminder", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					reminders.cancel(caller, params.reminderId, payload.commandKey),
				).pipe(safe),
			)
	}),
)
