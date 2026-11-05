import type { Chat } from "@openbot-build/core"
import { Bots as Domain } from "@openbot-build/domain"
import { Array as Arr, Effect, HashSet } from "effect"
import { SqlClient } from "effect/sql"
import { Requests } from "../conversation-contract/capabilities/Requests.ts"
import * as Imported from "@openbot-build/server-execution/imported/Executions"
import * as Failures from "@openbot-build/server-kernel/errors/Failures"
import { Reminders } from "../conversation-contract/work/Reminders.ts"
import { Delegations } from "../conversation-contract/bots/Delegations.ts"
import { isOpen } from "./Delegations.ts"

/** The Chat count and the model prompt read the same work that can still return. */
export const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const delegations = yield* Delegations
	const requests = yield* Requests
	const reminders = yield* Reminders
	const read = Effect.fn("ChatWork.read")(function* (
		organizationId: string,
		chat: Chat.Id,
	) {
		const history = yield* sql<{
			resource_kind: string
			resource_id: string
		}>`select resource_kind, resource_id from openbot_executions where organization_id = ${organizationId} and workflow = ${Imported.workflowName} and context_kind = 'Chat' and context_id = ${chat} and resource_kind in ('Delegation', 'Request')`.pipe(
			Failures.replace("The Chat work could not be read.", () =>
				Domain.BotStorageUnavailable.make({}),
			),
		)
		const oldDelegations = HashSet.fromIterable(
			Arr.flatMap(history, (row) =>
				row.resource_kind === "Delegation" ? [row.resource_id] : [],
			),
		)
		const oldRequests = HashSet.fromIterable(
			Arr.flatMap(history, (row) =>
				row.resource_kind === "Request" ? [row.resource_id] : [],
			),
		)
		return yield* Effect.all({
			delegations: delegations
				.forChat(organizationId, chat)
				.pipe(
					Effect.map(
						Arr.filter(
							(stored) =>
								isOpen(stored) &&
								!HashSet.has(oldDelegations, stored.delegation.id),
						),
					),
				),
			requests: requests
				.forChat(organizationId, chat)
				.pipe(
					Effect.map(
						Arr.filter(
							(stored) =>
								stored.request.status === "pending" &&
								!HashSet.has(oldRequests, stored.request.id),
						),
					),
				),
			reminders: reminders.forChat(organizationId, chat),
		})
	})
	return { read }
})
