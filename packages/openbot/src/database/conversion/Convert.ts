import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Secrets } from "../../secrets/Secrets.ts"
import * as Authority from "./Authority.ts"
import * as Apps from "./Apps.ts"
import * as Catalogs from "./Catalogs.ts"
import * as Chats from "./Chats.ts"
import * as Channels from "./Channels.ts"
import * as ChannelChecks from "./ChannelChecks.ts"
import * as Checks from "./Checks.ts"
import * as Imported from "./Executions.ts"
import * as Resources from "./Resources.ts"
import * as Legacy from "./LegacyV1.ts"
import * as Progress from "./Progress.ts"

export class InvalidData extends Schema.TaggedError<
	InvalidData,
	{ readonly brand: unique symbol }
>()("DataUpgradeInvalidData", { message: Schema.String }) {}
const keyJson = Schema.fromJsonString(Schema.Array(Schema.String))
const reminderRow = Schema.fromJsonString(
	Schema.Struct({ id: Schema.String, sealed: Schema.String }),
)
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	Schema.decodeEffect(Schema.fromJsonString(schema), {
		onExcessProperty: "error",
	})

/** Run under the maintenance lock. This program never starts an execution or sends a request. */
export const prepare = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const progress = yield* Progress.make
	type RecordRow = {
		key: string
		kind: string
		organization_id: string
		id: string
		owner: string
		scope: string
		status: string
		body: string
	}
	const readRecords =
		(kind: string) => (cursor: string | null, limit: number) =>
			sql<RecordRow>`select json_build_array(organization_id, id)::text as key, kind, organization_id, id, owner, scope, status, body from openbot_bot_records where kind = ${kind} and (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`
	const sealRecord = (row: RecordRow, binding: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			const sealed = yield* secrets.seal(
				row.body,
				yield* Schema.encodeEffect(keyJson)(binding),
			)
			yield* sql`update openbot_bot_records set body = ${sealed} where kind = ${row.kind} and organization_id = ${row.organization_id} and id = ${row.id}`
			yield* progress.record(row.kind, row.key, "converted", { id: row.id })
		})
	for (const [kind, schema] of [
		["confession", Legacy.Confession],
		["memory_enrichment", Legacy.Enrichment],
		["memory_log", Legacy.MemoryLog],
	] as const) {
		let complete = false
		while (!complete) {
			const result = yield* progress.batch(
				{
					name: `seal:${kind}`,
					read: readRecords(kind),
					key: (row) => row.key,
					convert: (row) =>
						Effect.gen(function* () {
							yield* decode(schema)(row.body)
							yield* sealRecord(row, [
								"bot-record",
								kind,
								row.organization_id,
								row.id,
							])
						}),
				},
				100,
			)
			complete = result.complete
		}
	}
	let remindersDone = false
	while (!remindersDone) {
		const result = yield* progress.batch(
			{
				name: "seal:reminder",
				read: readRecords("reminder"),
				key: (row) => row.key,
				convert: (row) =>
					Effect.gen(function* () {
						const value = yield* decode(Legacy.Reminder)(row.body)
						if (
							value.id !== row.id ||
							value.userId !== row.owner ||
							value.chat !== row.scope ||
							value.status !== row.status
						)
							return yield* InvalidData.make({
								message: "The reminder indexes do not match its record.",
							})
						const sealed = yield* secrets.seal(
							row.body,
							yield* Schema.encodeEffect(keyJson)([
								"reminder",
								row.organization_id,
								row.id,
							]),
						)
						const body = yield* Schema.encodeEffect(reminderRow)({
							id: row.id,
							sealed,
						})
						yield* sql`update openbot_bot_records set body = ${body} where kind = 'reminder' and organization_id = ${row.organization_id} and id = ${row.id}`
						yield* progress.record("reminder", row.key, "converted", {
							id: row.id,
							executionLinked: false,
						})
					}),
			},
			100,
		)
		remindersDone = result.complete
	}
	type MemoryRow = {
		key: string
		organization_id: string
		home_bot: string
		id: string
		content: string
		sources: string
	}
	let memoriesDone = false
	while (!memoriesDone) {
		const result = yield* progress.batch(
			{
				name: "seal:memory-content",
				read: (cursor, limit) =>
					sql<MemoryRow>`select json_build_array(organization_id, home_bot, id)::text as key, organization_id, home_bot, id, content, sources from openbot_bot_memories where (${cursor}::text is null or json_build_array(organization_id, home_bot, id)::text > ${cursor}) order by json_build_array(organization_id, home_bot, id)::text limit ${limit}`,
				key: (row) => row.key,
				convert: (row) =>
					Effect.gen(function* () {
						yield* Schema.decodeEffect(Legacy.MemoryContent)(row.content)
						yield* decode(Legacy.MemorySources)(row.sources)
						const content = yield* secrets.seal(
							row.content,
							yield* Schema.encodeEffect(keyJson)([
								"bot-memory",
								row.organization_id,
								row.home_bot,
								row.id,
								"content",
							]),
						)
						yield* sql`update openbot_bot_memories set content = ${content} where organization_id = ${row.organization_id} and home_bot = ${row.home_bot} and id = ${row.id}`
						yield* progress.record("memory-content", row.key, "converted", {
							id: row.id,
						})
					}),
			},
			100,
		)
		memoriesDone = result.complete
	}
	// These old records did not save a token. Keep their owners without making them callers.
	type AuthorityRow = { key: string; organization_id: string; user_id: string }
	for (const table of ["openbot_triggers", "openbot_channels"] as const) {
		let complete = false
		while (!complete) {
			const result = yield* progress.batch(
				{
					name: `authority:${table}`,
					read: (cursor, limit) =>
						sql<AuthorityRow>`select json_build_array(organization_id, id)::text as key, organization_id, actor as user_id from ${sql(table)} where (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
					key: (row) => row.key,
					convert: (row) =>
						progress.record(
							table,
							row.key,
							"needs_authorization",
							Authority.missing({
								organizationId: row.organization_id,
								userId: row.user_id,
							}),
						),
				},
				100,
			)
			complete = result.complete
		}
	}
	type FlowRow = { key: string; owner: string }
	for (const table of [
		"openbot_app_authorizations",
		"openbot_developer_test_flows",
	] as const) {
		let complete = false
		while (!complete) {
			const result = yield* progress.batch(
				{
					name: `authority:${table}`,
					read: (cursor, limit) =>
						table === "openbot_developer_test_flows"
							? sql<FlowRow>`select json_build_array(namespace, flow_id)::text as key, owner from openbot_developer_test_flows where actor is null and (${cursor}::text is null or json_build_array(namespace, flow_id)::text > ${cursor}) order by json_build_array(namespace, flow_id)::text limit ${limit}`
							: sql<FlowRow>`select id as key, owner from openbot_app_authorizations where actor is null and (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
					key: (row) => row.key,
					convert: (row) =>
						Effect.gen(function* () {
							const [organizationId, userId] = yield* Schema.decodeEffect(
								Legacy.Owner,
							)(row.owner)
							yield* progress.record(
								table,
								row.key,
								"needs_authorization",
								Authority.missing({ organizationId, userId }),
							)
						}),
				},
				100,
			)
			complete = result.complete
		}
	}
})

/** Complete all feature moves and checks before the server can start. */
export const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const progress = yield* Progress.make
	const source = yield* Progress.establish
	if (source === "empty") return yield* Progress.checkReady
	if (source !== Legacy.source)
		return yield* Progress.UpgradeRequired.make({
			reason: "SourceUnknown",
			message:
				"This database has an unknown data version. Do not start it or change its records.",
		})
	yield* sql`update openbot_data_upgrades set state = 'converting', checked_at = null, updated_at = ${yield* Clock.currentTimeMillis} where version = ${Progress.version}`
	yield* progress.phase("prepare", prepare)
	yield* progress.phase("chats", Chats.run)
	yield* progress.phase("apps", Apps.run)
	yield* progress.phase("channels", Channels.run)
	yield* progress.phase("resources", Resources.run)
	yield* progress.phase("catalogs", Catalogs.run)
	yield* progress.phase(
		"verify",
		Effect.gen(function* () {
			yield* Chats.verify
			yield* Apps.verify
			yield* Apps.check
			yield* ChannelChecks.verify
			yield* Channels.check
			yield* Resources.verify
			yield* Catalogs.verify
			yield* Catalogs.check
			yield* Checks.sealed
			yield* Imported.verify
			yield* Checks.maintenance
			yield* Checks.counts
		}),
	)
	yield* progress.ready([
		"prepare",
		"chats",
		"apps",
		"channels",
		"resources",
		"catalogs",
		"verify",
	])
	return yield* Progress.checkReady
})
