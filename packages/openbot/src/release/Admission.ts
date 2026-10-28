import { Execution } from "@openbot-build/domain"
import { Context, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

const lockId = 727124613

/** Only the runner sets this value. A browser cannot claim an accepted execution. */
export class Owner extends Context.Reference<{
	readonly namespace: string
	readonly id: Execution.Id
	readonly generation: number
} | null>("@openbot-build/openbot/release/Owner", {
	defaultValue: () => null,
}) {}

export class Closed extends Schema.TaggedError<
	Closed,
	{ readonly brand: unique symbol }
>()("ReleaseAdmissionClosed", {}) {}

export const Status = Schema.Struct({
	quiesced: Schema.Boolean,
	drained: Schema.Boolean,
	activeExecutions: Schema.Natural,
	activeLeases: Schema.Natural,
})

/** All reads and changes use the same transaction lock as command admission. */
export const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const paused = Effect.gen(function* () {
		const rows = yield* sql<{
			readonly quiesced: boolean
		}>`select quiesced from openbot_release_admission where id = 'platform'`
		return rows[0]?.quiesced === true
	})
	const admit = Effect.gen(function* () {
		// The caller holds this shared lock until its execution or lease commits.
		yield* sql`select pg_advisory_xact_lock_shared(${lockId})`
		if (!(yield* paused)) return
		const owner = yield* Owner
		if (owner !== null) {
			const rows = yield* sql`select id from openbot_executions
				where namespace = ${owner.namespace} and id = ${owner.id} and generation = ${owner.generation}
				and resource_kind not in ('TriggerSchedule', 'ChannelWatch', 'IndexWatch', 'ComputerMaintenance', 'FileRetention')
				and status in ('queued', 'running', 'waiting', 'cancelling') for share`
			if (rows.length === 1) return
		}
		// Native recovery retries only after the command transaction rolls back.
		// No provider call or new execution has been made at this point.
		return yield* Execution.StorageError.make({ cause: Closed.make({}) })
	})
	const admitCall = (key: {
		readonly namespace: string
		readonly id: Execution.Id
	}) =>
		Effect.gen(function* () {
			// Timers such as IndexWatch make calls in their own execution. Close their
			// send boundary with the same lock, before the call becomes Sending.
			yield* sql`select pg_advisory_xact_lock_shared(${lockId})`
			if (!(yield* paused)) return
			const rows = yield* sql`select id from openbot_executions
			where namespace = ${key.namespace} and id = ${key.id}
			and resource_kind in ('TriggerSchedule', 'ChannelWatch', 'IndexWatch', 'ComputerMaintenance', 'FileRetention')`
			if (rows.length !== 0)
				return yield* Execution.StorageError.make({ cause: Closed.make({}) })
		})
	const status = sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`select pg_advisory_xact_lock_shared(${lockId})`
			const quiesced = yield* paused
			const [counts] = yield* sql<{
				readonly executions: number
				readonly leases: number
			}>`select
			(select count(*)::float8 from openbot_executions e where
				(e.status not in ('completed', 'cancelled', 'interrupted', 'failed')
				 and not (((e.workflow = 'openbot.trigger-schedule' and e.resource_kind = 'TriggerSchedule')
					or (e.workflow = 'openbot.computer-maintenance' and e.resource_kind = 'ComputerMaintenance')
					or (e.workflow = 'openbot.file-retention' and e.resource_kind = 'FileRetention')
					or (e.workflow = 'openbot.index-watch' and e.resource_kind = 'IndexWatch'))
					and e.status in ('queued', 'running', 'waiting')))
				or exists (select 1 from openbot_execution_calls c
					where c.namespace = e.namespace and c.execution_id = e.id
					and c.status in ('sending', 'outcome_unknown'))
			) as executions,
			(select count(*)::float8 from openbot_resource_leases where
				result is null or result::jsonb ->> '_tag' is distinct from 'Closed') as leases`
			const activeExecutions = counts?.executions ?? 0
			const activeLeases = counts?.leases ?? 0
			return {
				quiesced,
				drained: quiesced && activeExecutions === 0 && activeLeases === 0,
				activeExecutions,
				activeLeases,
			}
		}),
	)
	const set = (quiesced: boolean) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					// This waits for all earlier admission transactions before closing the gate.
					yield* sql`select pg_advisory_xact_lock(${lockId})`
					yield* sql`insert into openbot_release_admission (id, quiesced) values ('platform', ${quiesced})
			on conflict (id) do update set quiesced = excluded.quiesced`
				}),
			)
			.pipe(Effect.andThen(status))
	return {
		admit,
		admitCall,
		paused,
		status,
		quiesce: set(true),
		resume: set(false),
	}
})
