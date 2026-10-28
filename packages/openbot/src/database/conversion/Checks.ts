import { getTableName } from "drizzle-orm"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Crypto,
	Effect,
	HashMap,
	Record as Rec,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import * as ExecutionTables from "../ExecutionSchema.ts"
import * as PermitTables from "../PermitSchema.ts"
import * as ResourceTables from "../ResourceSchema.ts"
import { appGrantUses, developerWatches } from "../Schema.ts"
import { Secrets } from "../../secrets/Secrets.ts"
import { Store } from "../../execution/Store.ts"
import * as TestCleanup from "../../apps/TestCleanup.ts"
import * as IndexWork from "../../apps/IndexWork.ts"
import * as DeveloperWatches from "../../apps/DeveloperWatches.ts"
import * as Imported from "./Executions.ts"
import * as Legacy from "./LegacyV1.ts"
import * as Progress from "./Progress.ts"

const json = Schema.fromJsonString(Schema.Json)
const Counts = Schema.fromJsonString(
	Schema.Array(Schema.Struct({ table: Schema.String, rows: Schema.Natural })),
)
const fail = (message: string) => Progress.InvalidData.make({ message })

/** The original tables keep every row. Only the common execution tables may gain rows. */
export const counts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const [saved] = yield* sql<{
		counts: string
	}>`select counts from openbot_data_upgrades where version = ${Progress.version}`
	if (saved === undefined)
		return yield* fail("The data move has no source inventory.")
	const before = yield* Schema.decodeEffect(Counts)(saved.counts)
	const after: HashMap.HashMap<string, number> = HashMap.fromIterable(
		Arr.map(
			yield* Progress.inventory,
			(entry) => [entry.table, entry.rows] as const,
		),
	)
	const newTables: ReadonlyArray<string> = Arr.map(
		Rec.values({
			...ExecutionTables,
			...PermitTables,
			...ResourceTables,
			developerWatches,
			appGrantUses,
		}),
		getTableName,
	)
	for (const entry of before) {
		const current = HashMap.get(after, entry.table)
		if (current._tag === "None")
			return yield* fail("A source table is missing after the data move.")
		if (Arr.contains(newTables, entry.table)) {
			if (entry.rows !== 0)
				return yield* fail(
					"The source database already has new execution data.",
				)
		} else if (current.value !== entry.rows)
			return yield* fail(`The row count changed in ${entry.table}.`)
	}
	const [work] = yield* sql<{ count: number }>`select (
		(select count(*) from openbot_cluster_messages) +
		(select count(*) from openbot_executions where workflow not in (${Imported.workflowName}, ${TestCleanup.workflowName}, ${IndexWork.workflowName}, ${DeveloperWatches.workflowName})) +
		(select count(*) from openbot_execution_outbox o where o.sent_at is not null or not exists (
			select 1 from openbot_executions e where e.namespace = o.namespace and e.id = o.execution_id and e.workflow in (${TestCleanup.workflowName}, ${IndexWork.workflowName}, ${DeveloperWatches.workflowName})
		))
	)::float8 as count`
	if (work?.count !== 0)
		return yield* fail("The data move started work or queued an unknown task.")
})

/** Service checks and expiry work wait for startup. They cannot run under the maintenance lock. */
export const maintenance = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const crypto = yield* Crypto.Crypto
	const digest = (value: string) =>
		crypto
			.digest("SHA-256", new TextEncoder().encode(value))
			.pipe(Effect.map(Hex.encode))
	const progress = yield* Progress.make
	yield* progress.verify({
		name: "verify:queued-maintenance",
		read: (cursor, limit) =>
			sql<{
				id: string
				namespace: string
				resource_id: string
				workflow: string
			}>`select id, namespace, resource_id, workflow from openbot_executions where workflow in (${TestCleanup.workflowName}, ${IndexWork.workflowName}, ${DeveloperWatches.workflowName}) and (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
		key: (row) => row.id,
		check: (row) =>
			Effect.gen(function* () {
				const key = { namespace: row.namespace, id: Execution.Id.make(row.id) }
				const serviceId =
					row.workflow === TestCleanup.workflowName
						? TestCleanup.serviceId
						: row.workflow === IndexWork.workflowName
							? IndexWork.serviceId
							: DeveloperWatches.serviceId
				const saved = yield* store.loadService(key, serviceId)
				if (row.workflow === TestCleanup.workflowName) {
					const input = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							indexNamespace: Schema.String,
							owner: Schema.String,
							testId: Schema.String,
							createdAt: Schema.Finite,
						}),
					)(saved.input)
					const [test] = yield* sql<{
						owner: string
						value: string
					}>`select owner, value from openbot_developer_tests where namespace = ${input.indexNamespace} and id = ${input.testId}`
					if (test === undefined)
						return yield* fail("A saved expiry task has no developer test.")
					const value = yield* Schema.decodeEffect(
						Schema.fromJsonString(
							Schema.Struct({
								id: Schema.String,
								createdAt: Schema.Finite,
								cleanupExecutionId: Schema.String,
							}),
						),
					)(test.value)
					const expected = yield* TestCleanup.submission(
						input.indexNamespace,
						test.owner,
						value.id,
						value.createdAt,
					)
					if (
						value.cleanupExecutionId !== row.id ||
						test.owner !== row.namespace ||
						row.resource_id !== value.id ||
						!Schema.toEquivalence(Schema.Json)(saved.input, expected.input) ||
						!Schema.toEquivalence(Schema.Json)(
							saved.identity,
							expected.identity,
						)
					)
						return yield* fail(
							"A saved expiry task does not match its developer test.",
						)
				} else if (row.workflow === IndexWork.workflowName) {
					const input = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							indexNamespace: Schema.String,
							cardUrl: Schema.String,
						}),
					)(saved.input)
					const [job] = yield* sql<{
						execution_id: string | null
					}>`select execution_id from openbot_app_index_jobs where namespace = ${input.indexNamespace} and card_url = ${input.cardUrl}`
					if (
						job?.execution_id !== row.id ||
						row.namespace !== `index:${input.indexNamespace}` ||
						saved.record.resource.kind !== "IndexWatch" ||
						row.resource_id !== (yield* digest(input.cardUrl)) ||
						!Schema.toEquivalence(Schema.Json)(
							saved.identity,
							IndexWork.identity,
						)
					)
						return yield* fail(
							"A saved Index check does not match its source job.",
						)
				} else {
					const input = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							namespace: Schema.String,
							ref: DeveloperWatches.Reference,
						}),
					)(saved.input)
					const [watch] = yield* sql<{
						execution_id: string | null
					}>`select execution_id from openbot_developer_watches where namespace = ${input.namespace} and kind = ${input.ref.kind} and resource_id = ${input.ref.id}`
					const source =
						input.ref.kind === "App"
							? yield* sql`select card_url from openbot_developer_apps where namespace = ${input.namespace} and card_url = ${input.ref.id}`
							: yield* sql`select id from openbot_developer_proofs where namespace = ${input.namespace} and id = ${input.ref.id}`
					if (
						watch?.execution_id !== row.id ||
						source.length !== 1 ||
						row.namespace !== `developer-monitor:${input.namespace}` ||
						saved.record.resource.kind !== "DeveloperWatch" ||
						row.resource_id !==
							(yield* digest(`${input.ref.kind}:${input.ref.id}`)) ||
						!Schema.toEquivalence(Schema.Json)(
							saved.identity,
							DeveloperWatches.identity,
						)
					)
						return yield* fail(
							"A saved developer check does not match its source record.",
						)
				}
				if (saved.record.status !== "queued" || saved.generation !== 0)
					return yield* fail("A saved maintenance task already started.")
				const events = yield* store.events(key, 0)
				if (
					events.length !== 1 ||
					events[0]?.body._tag !== "State" ||
					events[0].body.status !== "queued"
				)
					return yield* fail("A saved maintenance task already started.")
				const [pending] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_execution_outbox o join openbot_execution_commands c on c.namespace = o.namespace and c.id = o.command_id where o.namespace = ${row.namespace} and o.execution_id = ${row.id} and o.sent_at is null and c.kind = 'start' and c.principal_kind = 'service' and c.service_id = ${serviceId}`
				if (pending?.count !== 1)
					return yield* fail(
						"A saved maintenance task has no single start command.",
					)
			}),
	})
})

/** Open every converted secret again, even after its conversion cursor is complete. */
export const sealed = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const progress = yield* Progress.make
	for (const [kind, schema] of [
		["confession", Legacy.Confession],
		["memory_enrichment", Legacy.Enrichment],
		["memory_log", Legacy.MemoryLog],
	] as const) {
		yield* progress.verify({
			name: `verify:sealed-${kind}`,
			read: (cursor, limit) =>
				sql<{
					key: string
					organization_id: string
					id: string
					body: string
				}>`select jsonb_build_array(organization_id, id)::text as key, organization_id, id, body from openbot_bot_records where kind = ${kind} and (${cursor}::text is null or jsonb_build_array(organization_id, id)::text > ${cursor}) order by jsonb_build_array(organization_id, id)::text limit ${limit}`,
			key: (row) => row.key,
			check: (row) =>
				Effect.gen(function* () {
					const value = yield* secrets.open(
						row.body,
						yield* Schema.encodeEffect(json)([
							"bot-record",
							kind,
							row.organization_id,
							row.id,
						]),
					)
					yield* Schema.decodeEffect(Schema.fromJsonString(schema))(value)
				}),
		})
	}
	yield* progress.verify({
		name: "verify:sealed-memory",
		read: (cursor, limit) =>
			sql<{
				key: string
				organization_id: string
				home_bot: string
				id: string
				content: string
				sources: string
			}>`select jsonb_build_array(organization_id, home_bot, id)::text as key, organization_id, home_bot, id, content, sources from openbot_bot_memories where (${cursor}::text is null or jsonb_build_array(organization_id, home_bot, id)::text > ${cursor}) order by jsonb_build_array(organization_id, home_bot, id)::text limit ${limit}`,
		key: (row) => row.key,
		check: (row) =>
			Effect.gen(function* () {
				const content = yield* secrets.open(
					row.content,
					yield* Schema.encodeEffect(json)([
						"bot-memory",
						row.organization_id,
						row.home_bot,
						row.id,
						"content",
					]),
				)
				yield* Schema.decodeEffect(Legacy.MemoryContent)(content)
				yield* Schema.decodeEffect(Schema.fromJsonString(Legacy.MemorySources))(
					row.sources,
				)
			}),
	})
	yield* progress.verify({
		name: "verify:data-move-records",
		read: (cursor, limit) =>
			sql<{
				key: string
				collection: string
				source_key: string
				body: string
			}>`select jsonb_build_array(collection, key)::text as key, collection, key as source_key, body from openbot_data_upgrade_records where version = ${Progress.version} and (${cursor}::text is null or jsonb_build_array(collection, key)::text > ${cursor}) order by jsonb_build_array(collection, key)::text limit ${limit}`,
		key: (row) => row.key,
		check: (row) =>
			Effect.gen(function* () {
				const value = yield* secrets
					.open(
						row.body,
						yield* Schema.encodeEffect(json)([
							"data-upgrade",
							Progress.version,
							row.collection,
							row.source_key,
						]),
					)
					.pipe(Effect.flatMap(Schema.decodeEffect(json)))
				if (row.collection === "execution") {
					const proof = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							namespace: Schema.String,
							id: Schema.String,
							input: Imported.Input,
							resource: Execution.Resource,
							context: Schema.NullOr(Execution.Resource),
							status: Execution.Status,
							createdAt: Schema.Finite,
							updatedAt: Schema.Finite,
						}),
					)(value)
					const [execution] = yield* sql<{
						input: string
						resource_kind: string
						resource_id: string
						context_kind: string | null
						context_id: string | null
						status: string
						created_at: bigint
						updated_at: bigint
					}>`select input, resource_kind, resource_id, context_kind, context_id, status, created_at, updated_at from openbot_executions where namespace = ${proof.namespace} and id = ${proof.id}`
					if (execution === undefined)
						return yield* fail("An imported history record has no execution.")
					const input = yield* secrets
						.open(
							execution.input,
							yield* Schema.encodeEffect(json)([
								"execution",
								proof.namespace,
								proof.id,
								"input",
							]),
						)
						.pipe(
							Effect.flatMap(
								Schema.decodeEffect(Schema.fromJsonString(Imported.Input)),
							),
						)
					if (
						!Schema.toEquivalence(Imported.Input)(input, proof.input) ||
						execution.resource_kind !== proof.resource.kind ||
						execution.resource_id !== proof.resource.id ||
						execution.context_kind !== (proof.context?.kind ?? null) ||
						execution.context_id !== (proof.context?.id ?? null) ||
						execution.status !== proof.status ||
						execution.created_at !== BigInt(proof.createdAt) ||
						execution.updated_at !== BigInt(proof.updatedAt)
					)
						return yield* fail(
							"An imported history record does not match its source.",
						)
				}
			}),
	})
})
