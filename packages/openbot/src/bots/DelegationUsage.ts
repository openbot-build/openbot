import { Chat } from "@openbot-build/core"
import { Delegations as Domain, Execution } from "@openbot-build/domain"
import { and, eq, inArray, isNull, sql as query } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Effect,
	HashMap,
	HashSet,
	Option,
	Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import * as ChatHost from "../chats/ChatHost.ts"
import * as Db from "../database/Database.ts"
import { delegationPeriods } from "../database/ExecutionSchema.ts"
import { usageEvents } from "../database/Schema.ts"
import { Store, storage, type Key } from "../execution/Store.ts"

const Task = Schema.Struct({ chat: Chat.Id, host: ChatHost.ChatHostState })
type Owned = {
	readonly namespace: string
	readonly id: string
	readonly owner: string | null
	readonly kind: string
	readonly workflow: string
	readonly resource: string
	readonly status: Execution.Status
	readonly sequence: number
}
type Period = {
	readonly namespace: string
	readonly sequence: number
	readonly status: Execution.Status
	readonly id: string
	readonly start: number | null
	readonly end: number | null
}

/** Usage belongs to one execution round. A later round can reuse the same Chat. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const snapshot = Effect.fn("DelegationUsage.snapshot")(function* (
		key: Key,
		asOf?: number,
		stepCall?: Execution.CallId,
	) {
		const now = asOf ?? (yield* Clock.currentTimeMillis)
		const root = yield* store.loadMember(key)
		if (root.record.resource.kind !== "Delegation")
			return yield* Execution.Forbidden.make({})
		const organization = root.identity.owner.organizationId
		const owned = yield* sql<Owned>`
   with recursive work as (
    select namespace, id, owner_execution_id as owner, resource_kind as kind, workflow, resource_id as resource, status, sequence::float8
    from openbot_executions where namespace = ${key.namespace} and id = ${key.id}
    union
    select e.namespace, e.id, e.owner_execution_id, e.resource_kind, e.workflow, e.resource_id, e.status, e.sequence::float8
    from openbot_executions e join work w on e.owner_execution_id = w.id
    where e.organization_id = ${organization}
   ) select * from work`
		// One statement reads all periods. A parent pause cannot split this snapshot.
		const periods = yield* sql<Period>`
   with recursive owners as (
    select namespace, id, owner_execution_id as owner, resource_kind as kind, status, sequence::float8
    from openbot_executions where namespace = ${key.namespace} and id = ${key.id}
    union
    select e.namespace, e.id, e.owner_execution_id, e.resource_kind, e.status, e.sequence::float8
    from openbot_executions e join owners o on e.id = o.owner
    where e.organization_id = ${organization}
   ) select o.namespace, o.id, o.status, o.sequence, p.started_at::float8 as start, p.ended_at::float8 as end
   from owners o left join openbot_delegation_periods p on p.execution_id = o.id
   where o.kind = 'Delegation'`
		const delegations = HashSet.fromIterable(
			Arr.map(
				Arr.filter(owned, (row) => row.kind === "Delegation"),
				(row) => row.id,
			),
		)
		let chats = HashSet.empty<Chat.Id>()
		let ownChats = HashSet.empty<Chat.Id>()
		let tasks: ReadonlyArray<{ readonly key: Key; readonly turn: string }> = []
		for (const row of owned) {
			if (
				row.kind !== "Turn" ||
				row.workflow !== "openbot.chat-turn" ||
				row.owner === null ||
				!HashSet.has(delegations, row.owner)
			)
				continue
			const turn = yield* store.loadMember({
				namespace: row.namespace,
				id: Execution.Id.make(row.id),
			})
			const input = yield* Schema.decodeUnknownEffect(Task)(turn.input)
			if (input.host.kind !== "task") continue
			if (input.host.ownerExecutionId !== row.owner)
				return yield* Execution.Forbidden.make({})
			chats = HashSet.add(chats, input.chat)
			if (row.owner === key.id) {
				ownChats = HashSet.add(ownChats, input.chat)
				tasks = Arr.append(tasks, {
					key: { namespace: row.namespace, id: Execution.Id.make(row.id) },
					turn: row.resource,
				})
			}
		}
		if (HashSet.size(ownChats) > 1) return yield* Execution.Forbidden.make({})
		const own = Option.getOrNull(Arr.head(Arr.fromIterable(ownChats)))
		const usage =
			HashSet.size(chats) === 0
				? []
				: yield* db
						.select({
							steps: query<number>`count(*) filter (where ${usageEvents.source} = 'turn' and ${usageEvents.chatId} = ${own} and ${usageEvents.startedAt} is not null and (${stepCall ?? null}::text is null or ${usageEvents.id} <> ${stepCall ?? null}))::float8`,
							costMicros: query<number>`coalesce(sum(${usageEvents.costMicros}) filter (where ${usageEvents.status} = 'confirmed'), 0)::float8`,
						})
						.from(usageEvents)
						.where(
							and(
								eq(usageEvents.organizationId, organization),
								inArray(
									usageEvents.executionId,
									Arr.map(owned, (row) => row.id),
								),
								inArray(usageEvents.chatId, Arr.fromIterable(chats)),
							),
						)
		const forOwner = (id: string) =>
			Arr.flatMap(periods, (period) =>
				period.id === id && period.start !== null
					? [{ start: period.start, end: period.end }]
					: [],
			)
		const ancestors = HashSet.remove(
			HashSet.fromIterable(Arr.map(periods, (row) => row.id)),
			key.id,
		)
		const value = Domain.DelegationUsage.make({
			steps: Option.match(Arr.head(usage), {
				onNone: () => 0,
				onSome: (value) => value.steps,
			}),
			costMicros: Option.match(Arr.head(usage), {
				onNone: () => 0,
				onSome: (value) => value.costMicros,
			}),
			timeMs: Domain.runningTime(
				forOwner(key.id),
				Arr.map(Arr.fromIterable(ancestors), forOwner),
				now,
			),
		})
		const watch = Arr.fromIterable(
			HashMap.values(
				HashMap.fromIterable(
					Arr.map(
						Arr.filter(
							[...periods, ...owned],
							(row) => !Execution.isTerminal(row.status),
						),
						(row) =>
							[
								row.id,
								{
									key: {
										namespace: row.namespace,
										id: Execution.Id.make(row.id),
									},
									sequence: row.sequence,
								},
							] as const,
					),
				),
			),
		)
		return {
			usage: value,
			tasks,
			watch,
			at: now,
			activeWork: Arr.some(
				owned,
				(row) => row.id !== key.id && !Execution.isTerminal(row.status),
			),
			running: Arr.every(
				Arr.fromIterable(HashSet.add(ancestors, key.id)),
				(id) =>
					Arr.some(
						periods,
						(period) =>
							period.id === id && period.start !== null && period.end === null,
					),
			),
		}
	}, storage)
	// The caller holds the execution fence and commits the domain state in this transaction.
	const begin = (key: Key, epoch: number, now: number) =>
		db
			.insert(delegationPeriods)
			.values({
				namespace: key.namespace,
				executionId: key.id,
				epoch,
				startedAt: now,
			})
			.pipe(storage)
	const close = (key: Key, now: number) =>
		db
			.update(delegationPeriods)
			.set({ endedAt: now })
			.where(
				and(
					eq(delegationPeriods.namespace, key.namespace),
					eq(delegationPeriods.executionId, key.id),
					isNull(delegationPeriods.endedAt),
				),
			)
			.pipe(storage)
	return {
		snapshot,
		read: (key: Key, asOf?: number) =>
			Effect.map(snapshot(key, asOf), (value) => value.usage),
		/** A committed reservation retry is the same step, not a new model call. */
		beforeCall: (key: Key, call: Execution.CallId) =>
			Effect.map(snapshot(key, undefined, call), (value) => value.usage),
		begin,
		close,
	}
})
