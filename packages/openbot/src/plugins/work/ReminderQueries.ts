import {
	Authorization,
	type Caller,
	Execution,
	Reminders as Domain,
} from "@openbot-build/domain"
import { Array as Arr, Effect, Option } from "effect"
import type { RemindersApi } from "@openbot-build/api"
import * as Check from "../../authorization/Check.ts"
import { Commands } from "../../execution/Commands.ts"
import { Reminders, type Reminder } from "./Reminders.ts"

const view = (row: Reminder): Domain.Reminder => ({
	id: row.id,
	chatId: row.chat,
	turnId: row.turn,
	executionId: row.executionId ?? null,
	note: row.note,
	dueAt: row.dueAt,
	status: row.status,
})
export const make = Effect.gen(function* () {
	const reminders = yield* Reminders
	const checks = yield* Check.make
	const commands = yield* Commands
	const target = (caller: Caller, row: Reminder) => ({
		action: "read" as const,
		resource: Authorization.Chat.make({
			organizationId: caller.organizationId,
			ownerUserId: caller.userId,
			id: row.chat,
		}),
	})
	const get = (caller: Caller, id: string) =>
		Effect.gen(function* () {
			const row = yield* reminders.find(caller.organizationId, id)
			if (Option.isNone(row) || row.value.userId !== caller.userId)
				return yield* Domain.NotFound.make({ id })
			yield* checks.check(caller, target(caller, row.value))
			return view(row.value)
		})
	return {
		get,
		list: (caller: Caller, query: RemindersApi.Query) =>
			Effect.gen(function* () {
				const limit = query.limit ?? 50
				const rows = yield* reminders.list(caller.organizationId, {
					owner: caller.userId,
					limit: limit + 1,
					...(query.chatId === undefined ? {} : { scope: query.chatId }),
					...(query.status === undefined ? {} : { status: query.status }),
					...(query.after === undefined ? {} : { after: query.after }),
				})
				const page = Arr.take(rows, limit)
				const visible = yield* Effect.filter(page, (row) =>
					row.userId !== caller.userId
						? Effect.succeed(false)
						: checks.allows(caller, target(caller, row)),
				)
				return {
					items: Arr.map(visible, view),
					next: rows.length > limit ? page[page.length - 1]!.id : null,
				}
			}),
		cancel: (caller: Caller, id: string, commandKey: Execution.CommandKey) =>
			Effect.gen(function* () {
				const row = yield* get(caller, id)
				if (row.executionId === null) return yield* Domain.Conflict.make({ id })
				return yield* commands.cancel(row.executionId, caller, commandKey)
			}),
	}
})
