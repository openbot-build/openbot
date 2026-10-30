import { Execution, Reminders as Domain } from "@openbot-build/domain"
import type { RemindersApi } from "@openbot-build/api"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

export const list = (
	query: RemindersApi.Query = {},
): Effect.Effect<Domain.Page, ClientError, Client> =>
	Effect.flatMap(Client, ({ api }) => api.reminders.listReminders({ query }))
export const get = (
	reminderId: string,
): Effect.Effect<Domain.Reminder, ClientError, Client> =>
	Effect.flatMap(Client, ({ api }) =>
		api.reminders.getReminder({ params: { reminderId } }),
	)
/** Keep the command key if the cancel reply is lost. */
export const cancel = Effect.fn("Reminders.cancel")(function* (
	reminderId: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.reminders.cancelReminder({
				params: { reminderId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})
