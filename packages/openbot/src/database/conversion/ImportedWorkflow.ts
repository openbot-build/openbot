import {
	Authorization,
	ConnectionId,
	Execution,
	type Caller,
} from "@openbot-build/domain"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Check from "../../authorization/Check.ts"
import { botResource } from "../../authorization/Resources.ts"
import { ownerKey } from "../../apps/StoredConnections.ts"
import * as DeveloperAccess from "../../apps/DeveloperAccess.ts"
import { IndexNamespace } from "../../apps/IndexNamespace.ts"
import { Bots } from "../../bots/Bots.ts"
import * as Engine from "../../execution/Engine.ts"
import { Store, storage, type Key } from "../../execution/Store.ts"
import * as Imported from "./Executions.ts"

export const workflow = Engine.define(Imported.workflowName)

/** Imported history can be read or stopped. It cannot gain a new caller. */
export const make = Effect.gen(function* () {
	const store = yield* Store
	const sql = yield* SqlClient.SqlClient
	const checks = yield* Check.make
	const bots = yield* Bots
	const developerAccess = yield* DeveloperAccess.authorization
	const indexNamespace = yield* IndexNamespace
	const load = Effect.fn("ImportedWorkflow.load")(function* (key: Key) {
		const saved = yield* store.loadService(key, Imported.serviceId)
		const input = yield* Schema.decodeUnknownEffect(Imported.Input)(saved.input)
		if (
			saved.workflow !== Imported.workflowName ||
			saved.identity.owner.kind !== "organization" ||
			saved.identity.owner.organizationId !== input.owner.organizationId ||
			key.namespace !== ownerKey(input.owner)
		)
			return yield* Execution.Forbidden.make({})
		return { saved, input }
	}, storage)
	const authorize: Engine.Authorize = (key, actor, access) =>
		Effect.gen(function* () {
			if (access !== "read" && access !== "decide")
				return yield* Execution.Forbidden.make({})
			const { saved, input } = yield* load(key)
			const { organizationId, userId: ownerUserId } = input.owner
			if (actor.organizationId !== organizationId)
				return yield* Execution.Forbidden.make({})
			const resource = saved.context ?? saved.record.resource
			const id = resource.id
			const check = (
				resource:
					| Authorization.Chat
					| Authorization.Connection
					| Authorization.File
					| Authorization.Channel
					| Authorization.Trigger
					| Authorization.Computer
					| Authorization.Bot,
			) =>
				Effect.gen(function* () {
					yield* checks.check(actor, { action: "read", resource })
					if (access === "decide")
						yield* checks.check(actor, { action: "write", resource })
				})
			// These checks load the current member, token, and platform policy.
			// A saved owner or missing original caller never grants a new right.
			switch (resource.kind) {
				case "File": {
					const rows =
						yield* sql`select id from openbot_files where organization_id = ${organizationId} and user_id = ${ownerUserId} and id = ${id} and cleanup_execution_id = ${key.id}`
					if (rows.length !== 1) return yield* Execution.Forbidden.make({})
					yield* check(
						Authorization.File.make({ organizationId, ownerUserId, id }),
					)
					break
				}
				case "IndexRequest": {
					if (ownerKey(actor) !== key.namespace)
						return yield* Execution.Forbidden.make({})
					const [row] = yield* sql<{
						card_url: string
					}>`select card_url from openbot_developer_index_requests where namespace = ${indexNamespace} and owner = ${key.namespace} and id = ${id} and execution_id = ${key.id}`
					if (row === undefined) return yield* Execution.Forbidden.make({})
					yield* checks.check(actor, {
						action: "publish",
						resource: Authorization.App.make({ organizationId, ownerUserId }),
					})
					yield* developerAccess.authorize(
						key.namespace,
						row.card_url,
						access === "decide",
					)
					break
				}
				case "Chat": {
					const rows =
						yield* sql`select id from openbot_chats where namespace = ${key.namespace} and id = ${id}`
					if (rows.length !== 1) return yield* Execution.Forbidden.make({})
					yield* check(
						Authorization.Chat.make({ organizationId, ownerUserId, id }),
					)
					break
				}
				case "Connection": {
					const rows =
						yield* sql`select id from openbot_app_connections where owner = ${key.namespace} and id = ${id}`
					if (rows.length !== 1) return yield* Execution.Forbidden.make({})
					yield* check(
						Authorization.Connection.make({
							organizationId,
							ownerUserId,
							id: ConnectionId.make(id),
						}),
					)
					break
				}
				case "DeveloperTest": {
					const rows =
						yield* sql`select id from openbot_developer_tests where owner = ${key.namespace} and id = ${id}`
					if (rows.length !== 1) return yield* Execution.Forbidden.make({})
					yield* checks.check(actor, {
						action: "publish",
						resource: Authorization.App.make({ organizationId, ownerUserId }),
					})
					break
				}
				case "Channel": {
					const rows =
						yield* sql`select id from openbot_channels where organization_id = ${organizationId} and id = ${id}`
					if (rows.length !== 1) return yield* Execution.Forbidden.make({})
					yield* check(Authorization.Channel.make({ organizationId, id }))
					break
				}
				case "Trigger": {
					const [row] = yield* sql<{
						owner_user_id: string | null
					}>`select owner_user_id from openbot_triggers where organization_id = ${organizationId} and id = ${id}`
					if (row === undefined) return yield* Execution.Forbidden.make({})
					yield* check(
						Authorization.Trigger.make({
							organizationId,
							ownerUserId: row.owner_user_id,
							id,
						}),
					)
					break
				}
				case "Computer": {
					const [row] = yield* sql<{
						owner_user_id: string | null
					}>`select owner_user_id from openbot_computers where organization_id = ${organizationId} and id = ${id}`
					if (row === undefined) return yield* Execution.Forbidden.make({})
					yield* check(
						Authorization.Computer.make({
							organizationId,
							ownerUserId: row.owner_user_id,
							id,
						}),
					)
					break
				}
				case "Bot": {
					const bot = yield* bots.find(organizationId, id)
					if (Option.isNone(bot)) return yield* Execution.Forbidden.make({})
					yield* check(botResource({ ...bot.value, organizationId }))
					break
				}
				default:
					return yield* Execution.Forbidden.make({})
			}
		}).pipe(
			Effect.catchTags({
				Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
				Pending: () => Effect.fail(Execution.Forbidden.make({})),
				DeveloperForbidden: () => Effect.fail(Execution.Forbidden.make({})),
				DeveloperNotFound: () => Effect.fail(Execution.Forbidden.make({})),
			}),
			storage,
		)
	const decide: Engine.Decide = (key, actor, command) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					yield* authorize(key, actor, "decide")
					if (command.answer !== "stop")
						return yield* Execution.Conflict.make({ id: key.id })
					const receipt = yield* store.decide(
						key,
						command.commandKey,
						command.decisionId,
						command.answer,
						actor,
					)
					// Waiting for a command or row lock can outlive a caller's rights.
					yield* authorize(key, actor, "decide")
					const { saved } = yield* load(key)
					// The saved receipt remains valid after the final stop made the record terminal.
					if (Execution.isTerminal(saved.record.status)) return receipt
					if (saved.record.status !== "outcome_unknown")
						return yield* Execution.Conflict.make({ id: key.id })
					const calls = Arr.filter(
						yield* store.calls(key),
						(call) => call.status === "outcome_unknown",
					)
					if (calls.length === 0 || saved.record.failure === null)
						return yield* Execution.Conflict.make({ id: key.id })
					for (const call of calls) {
						const decision = yield* store.decision(key, call.id)
						if (Option.isNone(decision))
							return yield* Execution.Conflict.make({ id: key.id })
						if (decision.value.answer?.answer !== "stop") return receipt
					}
					// The decision, final state, and their events share this transaction.
					// Keep unknown call results unknown. No model or outside action is replayed.
					yield* store.transition(
						{ ...key, generation: saved.generation },
						"interrupted",
						{
							...saved.record.failure,
							category: "interrupted",
						},
					)
					return receipt
				}),
			)
			.pipe(storage)
	/** Feature history readers use the same current policy as the public execution API. */
	const read = (key: Key, actor: Caller) =>
		authorize(key, actor, "read").pipe(Effect.andThen(load(key)))
	return { authorize, decide, read }
})

export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const registry = yield* Engine.Registry
		const commands = yield* make
		return workflow
			.toLayer(() => Effect.void)
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(
						registry.registerService(
							workflow,
							Imported.serviceId,
							() => Effect.fail(Execution.Forbidden.make({})),
							undefined,
							commands.authorize,
							commands,
						),
					),
				),
			)
	}),
)
