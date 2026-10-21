import { PgClient } from "@effect/sql-pg"
import { AgentsApi } from "@openbot-build/api"
import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect"
import * as Fence from "../execution/ExecutionFence.ts"

/** Where one record is. `owner` and `scope` are the keys that lists filter by. */
export interface Keys<Status extends string = string> {
	readonly organizationId: string
	readonly id: string
	readonly owner: string
	readonly scope: string
	readonly status: Status
}

export interface Filter<Status extends string = string> {
	readonly owner?: string
	readonly scope?: string
	readonly status?: Status
}

/** Typed JSON records of one kind. */
export interface Collection<A, Status extends string = string> {
	readonly find: (
		organizationId: string,
		id: string,
	) => Effect.Effect<Option.Option<A>, AgentsApi.AgentStorageUnavailable>
	readonly list: (
		organizationId: string,
		filter?: Filter<Status>,
	) => Effect.Effect<ReadonlyArray<A>, AgentsApi.AgentStorageUnavailable>
	/** Records with this status in every organization. Recovery uses it after a restart. */
	readonly withStatus: (
		status: Status,
	) => Effect.Effect<
		ReadonlyArray<{ readonly organizationId: string; readonly value: A }>,
		AgentsApi.AgentStorageUnavailable
	>
	readonly put: (
		keys: Keys<Status>,
		value: A,
	) => Effect.Effect<void, AgentsApi.AgentStorageUnavailable>
	readonly remove: (
		organizationId: string,
		id: string,
	) => Effect.Effect<void, AgentsApi.AgentStorageUnavailable>
}

export class AgentRecords extends Context.Service<
	AgentRecords,
	{
		/** `status` is the set of values that the status key can have. */
		readonly collection: <
			S extends Schema.Codec<any, any>,
			Status extends string = string,
		>(
			kind: string,
			schema: S,
			status?: Schema.Schema<Status>,
		) => Collection<S["Type"], Status>
		/**
		 * Runs the operation in one transaction that holds a lock on `key`.
		 * Read-change-write steps on the same key never run at the same time.
		 */
		readonly transaction: <A, E, R>(
			key: string,
			operation: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | AgentsApi.AgentStorageUnavailable, R>
	}
>()("@openbot-build/openbot/agents/AgentRecords") {}

export const make: Effect.Effect<
	typeof AgentRecords.Service,
	never,
	PgClient.PgClient
> = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const unavailable = () => AgentsApi.AgentStorageUnavailable.make({})
	// The outer transaction keeps its lease through the driver's commit or rollback.
	const write = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
		Effect.flatMap(Fence.CurrentExecution, (lease) =>
			Fence.guard(lease?.accountId ?? "", "write", operation),
		)
	const account = (
		kind: string,
		organizationId: string,
		owner: string,
		body: string,
	) =>
		Effect.gen(function* () {
			if (kind === "agent" || kind === "delegation") return owner
			if (kind === "request") {
				const stored = yield* Schema.decodeEffect(
					Schema.fromJsonString(
						Schema.Struct({
							chain: Schema.Struct({
								userId: Schema.NonEmptyString,
								organizationId: Schema.NonEmptyString,
							}),
						}),
					),
				)(body)
				if (stored.chain.organizationId !== organizationId)
					return yield* unavailable()
				return stored.chain.userId
			}
			const rows = yield* sql<{
				owner: string
			}>`SELECT owner FROM openbot_agent_records WHERE kind = 'agent' AND organization_id = ${organizationId} AND id = ${owner}`
			return rows[0]?.owner ?? "unresolved:" + owner
		})
	const recordWrite = <A, E, R>(
		kind: string,
		keys: Pick<Keys, "organizationId" | "owner">,
		body: string,
		operation: Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			const owner = yield* account(kind, keys.organizationId, keys.owner, body)
			const current = yield* Fence.CurrentExecution
			// Organization-owned records still require the caller's admitted account.
			return yield* Fence.guard(
				owner || current?.accountId || "",
				"write",
				operation,
			)
		})
	const collection = <
		S extends Schema.Codec<any, any>,
		Status extends string = string,
	>(
		kind: string,
		schema: S,
		// Only the type of the status keys comes from this schema.
		_status?: Schema.Schema<Status>,
	): Collection<S["Type"], Status> => {
		type A = S["Type"]
		const codec = Schema.fromJsonString(
			Schema.toCodecJson(schema),
		) as Schema.Codec<A, string>
		const decode = Schema.decodeEffect(codec)
		return {
			find: (organizationId, id) =>
				sql<{
					body: string
				}>`SELECT body FROM openbot_agent_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND id = ${id}`.pipe(
					Effect.map(Arr.head),
					Effect.flatMap((row) =>
						Effect.transposeOption(Option.map(row, (row) => decode(row.body))),
					),
					Effect.mapError(unavailable),
				),
			list: (organizationId, filter = {}) =>
				sql<{
					body: string
				}>`SELECT body FROM openbot_agent_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND (${filter.owner ?? null}::text IS NULL OR owner = ${filter.owner ?? null}) AND (${filter.scope ?? null}::text IS NULL OR scope = ${filter.scope ?? null}) AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null}) ORDER BY id`.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) => decode(row.body)),
					),
					Effect.mapError(unavailable),
				),
			withStatus: (status) =>
				sql<{
					organization_id: string
					body: string
				}>`SELECT organization_id, body FROM openbot_agent_records WHERE kind = ${kind} AND status = ${status} ORDER BY id`.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) =>
							decode(row.body).pipe(
								Effect.map((value) => ({
									organizationId: row.organization_id,
									value,
								})),
							),
						),
					),
					Effect.mapError(unavailable),
				),
			put: (keys, value) =>
				Schema.encodeEffect(codec)(value).pipe(
					Effect.flatMap((body) =>
						write(
							sql.withTransaction(
								Effect.gen(function* () {
									yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["agent-record", kind, keys.organizationId, keys.id])}, 0))`
									const rows = yield* sql<{
										owner: string
										body: string
									}>`SELECT owner, body FROM openbot_agent_records WHERE kind = ${kind} AND organization_id = ${keys.organizationId} AND id = ${keys.id} FOR UPDATE`
									if (rows[0] !== undefined)
										yield* recordWrite(
											kind,
											{
												organizationId: keys.organizationId,
												owner: rows[0].owner,
											},
											rows[0].body,
											Effect.void,
										)
									return yield* recordWrite(
										kind,
										keys,
										body,
										sql`INSERT INTO openbot_agent_records (kind, organization_id, id, owner, scope, status, body) VALUES (${kind}, ${keys.organizationId}, ${keys.id}, ${keys.owner}, ${keys.scope}, ${keys.status}, ${body}) ON CONFLICT (kind, organization_id, id) DO UPDATE SET owner = EXCLUDED.owner, scope = EXCLUDED.scope, status = EXCLUDED.status, body = EXCLUDED.body`,
									)
								}),
							),
						),
					),
					Effect.asVoid,
					Effect.mapError(unavailable),
				),
			remove: (organizationId, id) =>
				write(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["agent-record", kind, organizationId, id])}, 0))`
							const rows = yield* sql<{
								owner: string
								body: string
							}>`SELECT owner, body FROM openbot_agent_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND id = ${id} FOR UPDATE`
							if (rows.length === 0) return
							return yield* recordWrite(
								kind,
								{ organizationId, owner: rows[0]!.owner },
								rows[0]!.body,
								sql`DELETE FROM openbot_agent_records WHERE kind = ${kind} AND organization_id = ${organizationId} AND id = ${id}`,
							)
						}),
					),
				).pipe(Effect.asVoid, Effect.mapError(unavailable)),
		}
	}
	return AgentRecords.of({
		collection,
		transaction: (key, operation) =>
			write(
				sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${"agents:" + key}, 0))`.pipe(
							Effect.mapError(unavailable),
						)
						return yield* operation
					}),
				),
			).pipe(
				// catchTags cannot infer its key set when the caller supplies generic E.
				// @effect-diagnostics-next-line multipleCatchTag:off
				Effect.catchTag("SqlError", unavailable),
				Effect.catchTag("FenceUnavailable", unavailable),
			),
	})
})
export const layer = Layer.effect(AgentRecords, make)
