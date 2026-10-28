import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import { Indexing } from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import * as DeveloperWatches from "../src/apps/DeveloperWatches.ts"
import { Governance } from "../src/apps/Governance.ts"
import * as IndexWork from "../src/apps/IndexWork.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Migrations from "../src/database/Migrations.ts"
import * as Catalogs from "../src/database/conversion/Catalogs.ts"
import * as Imported from "../src/database/conversion/Executions.ts"
import * as Legacy from "../src/database/conversion/LegacyCatalogs.ts"
import * as Progress from "../src/database/conversion/Progress.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const owner = '["org","person"]'
const cardUrl = "https://example.test/card"
const secondUrl = "https://example.test/second"
const draftId = "00000000-0000-4000-8000-000000000020"
const proofId = "00000000-0000-4000-8000-000000000021"
const closedProofId = "00000000-0000-4000-8000-000000000022"
const memberId = "00000000-0000-4000-8000-000000000023"
const reportId = "00000000-0000-4000-8000-000000000024"
const completedRequestId = "00000000-0000-4000-8000-000000000025"
const pendingRequestId = "00000000-0000-4000-8000-000000000026"
const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const database = () =>
	Store.layer.pipe(
		Layer.provideMerge(
			Layer.unwrap(
				Effect.map(PostgresTest.start, (database) =>
					Layer.merge(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				),
			),
		),
		Layer.provideMerge(NodeServices.layer),
	)
const card = {
	$schema:
		"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
	name: "test/app",
	version: "1.0.0",
	description: "Read a note.",
}
const sources = [{ role: "catalog", url: "https://example.test/catalog" }]
const candidate = { cardUrl, card, endpoints: [], sources }
const check = { _tag: "Indexed", attemptedAt: 10 }
const entry = {
	cardUrl,
	card,
	checkedAt: 10,
	validators: {},
	evidence: [
		{
			publisherUrl: "https://example.test/",
			catalogUrl: "https://example.test/catalog",
			cardUrl,
			association: "CardOrigin",
		},
	],
}
const report = {
	input: cardUrl,
	checkedAt: 10,
	apps: [
		{
			candidate,
			eligibility: { _tag: "Eligible", entry, stages: [] },
			stored: { _tag: "Known", check },
		},
	],
	issues: [],
	stages: [],
}
const fixture = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const secrets = yield* Secrets.Secrets
	const connection = {
		connection: {
			owner,
			connectionId: "connection",
			cardUrl,
			endpoint: "https://example.test/mcp",
			remoteIndex: 0,
			configuration: { token: "private-configuration" },
			headers: {},
			state: "Enabled",
			authorization: { _tag: "Unprotected" },
		},
		name: "Saved App",
		revision: 2,
		verification: null,
	}
	const body = yield* secrets.seal(
		yield* encode(connection),
		yield* encode(["connection", owner, "connection"]),
	)
	yield* sql`insert into openbot_app_records ${sql.insert({ owner, card_url: cardUrl, body: yield* encode({ cardUrl, card, sources }) })}`
	yield* sql`insert into openbot_app_drafts ${sql.insert({ owner, id: draftId, body: yield* encode({ id: draftId, revision: 1, input: cardUrl, discovery: { _tag: "Single", candidate, issues: [] }, expiresAt: 100 }) })}`
	yield* sql`insert into openbot_app_connections ${sql.insert({ owner, id: "connection", name: "Saved App", revision: 2, body })}`
	yield* sql`insert into openbot_app_index_entries ${sql.insert({ namespace: "public", card_url: cardUrl, body: yield* encode(entry) })}`
	yield* sql`insert into openbot_app_index_results ${sql.insert({ namespace: "public", card_url: cardUrl, generation: "done", check: yield* encode(check), finished_at: 10 })}`
	yield* sql`insert into openbot_app_index_jobs ${sql.insert({ namespace: "public", card_url: cardUrl, generation: "done", completed_generation: "done", next_check_at: 321, lease_until: 99, claim: "old-claim", check: yield* encode(check), sources: yield* encode(sources), requested_at: 1, started_at: 2 })}`
	yield* sql`insert into openbot_app_index_jobs ${sql.insert({ namespace: "public", card_url: secondUrl, generation: "pending", next_check_at: 0, sources: '["broken source"]', requested_at: 5, started_at: 6 })}`
	for (const id of [proofId, closedProofId]) {
		const scope = yield* encode({ _tag: "AppCard", cardUrl })
		yield* sql`insert into openbot_developer_claims ${sql.insert({ namespace: "public", id, owner, scope_key: "card:" + cardUrl, scope, token: "private-proof-token", status: "Confirmed", created_at: 1, expires_at: 100 })}`
		yield* sql`insert into openbot_developer_proofs ${sql.insert({ namespace: "public", id, owner, scope_key: "card:" + cardUrl, scope, token: "private-proof-token", transition: 2, status: id === proofId ? "Confirmed" : "Relinquished", confirmed_at: 2, valid_until: 9999999999999, next_verification_at: 567, reason: null })}`
	}
	const member = '["org","member"]'
	yield* sql`insert into openbot_developer_members ${sql.insert({ namespace: "public", id: memberId, owner: member, proof_id: proofId, role: "viewer" })}`
	yield* sql`insert into openbot_developer_invitations ${sql.insert({ namespace: "public", id: "private-invitation-token", owner, proof_id: proofId, role: "viewer", expires_at: 50, status: "Accepted", accepted_by: member })}`
	yield* sql`insert into openbot_developer_apps ${sql.insert({ namespace: "public", card_url: cardUrl, candidate: yield* encode(candidate), next_check_at: 789, monitor_revision: 4, monitor_issues: "[]", monitor_token: "old-monitor", lease_until: 90 })}`
	yield* sql`insert into openbot_developer_reports ${sql.insert({ namespace: "public", id: reportId, owner, card_url: cardUrl, checked_at: 10, report: yield* encode(report) })}`
	for (const [id, generation] of [
		[completedRequestId, "done"],
		[pendingRequestId, "old-pending"],
	])
		yield* sql`insert into openbot_developer_index_requests ${sql.insert({ namespace: "public", id, owner, card_url: cardUrl, generation, accepted_at: 1 })}`
	yield* sql`insert into openbot_developer_subscriptions ${sql.insert({ namespace: "public", owner, card_url: cardUrl, enabled: false })}`
	yield* sql`insert into openbot_developer_notices ${sql.insert({ namespace: "public", id: "notice", owner, card_url: cardUrl, kind: "AccessChanged", reason: "Saved change.", report_id: reportId, created_at: 10 })}`
	return { connection, body }
})

it.layer(database(), { excludeTestServices: true })((it) => {
	it.effect(
		"The catalog move resumes batches and enrolls platform reads without the old caller",
		() =>
			Effect.gen(function* () {
				yield* Migrations.initialize
				const sql = yield* PgClient.PgClient
				const store = yield* Store.Store
				const saved = yield* fixture
				const move = yield* Catalogs.make
				assert.isTrue(
					Schema.is(Progress.InvalidRecord)(
						yield* move.run(1).pipe(Effect.flip),
					),
				)
				const [first] = yield* sql<{
					execution_id: string
					generation: string
					next_check_at: string
					claim: string
				}>`select execution_id, generation, next_check_at::text, claim from openbot_app_index_jobs where card_url = ${cardUrl}`
				assert.isString(first?.execution_id)
				assert.equal(first?.next_check_at, "321")
				assert.equal(first?.claim, "old-claim")
				const [progress] = yield* sql<{
					rows: string
					complete: boolean
				}>`select rows::text, complete from openbot_data_upgrade_steps where step = 'catalogs:app_index_jobs'`
				assert.equal(progress?.rows, "1")
				assert.isFalse(progress?.complete)
				yield* sql`update openbot_app_index_jobs set sources = ${yield* encode(sources)} where card_url = ${secondUrl}`
				yield* sql`update openbot_developer_invitations set owner = '["org","another"]' where id = 'private-invitation-token'`
				assert.isTrue(
					Schema.is(Progress.InvalidRecord)(
						yield* move.run(1).pipe(Effect.flip),
					),
				)
				yield* sql`update openbot_developer_invitations set owner = ${owner} where id = 'private-invitation-token'`
				yield* move.run(1)
				yield* move.run(1)
				yield* move.verify
				yield* move.verify
				yield* move.check
				const rows = yield* sql<{
					id: string
					workflow: string
					namespace: string
					input: string
					status: string
				}>`select id, workflow, namespace, input, status from openbot_executions`
				assert.equal(rows.length, 6)
				const imported = Arr.filter(
					rows,
					(row) => row.workflow === Imported.workflowName,
				)
				assert.equal(imported.length, 2)
				for (const row of imported) {
					const record = yield* store.loadService(
						{ namespace: row.namespace, id: Execution.Id.make(row.id) },
						Imported.serviceId,
					)
					const input = yield* Schema.decodeUnknownEffect(Imported.Input)(
						record.input,
					)
					const history = yield* Schema.decodeUnknownEffect(
						Legacy.IndexRequestHistory,
					)(input.history)
					assert.equal(input.authority._tag, "NeedsAuthorization")
					assert.isFalse("caller" in input.authority)
					assert.equal(
						record.record.status,
						history.request.id === completedRequestId
							? "completed"
							: "interrupted",
					)
					assert.equal(
						history.check?._tag ?? null,
						history.request.id === completedRequestId ? "Indexed" : null,
					)
					assert.isEmpty(
						yield* store.calls({
							namespace: row.namespace,
							id: Execution.Id.make(row.id),
						}),
					)
				}
				const index = yield* IndexWork.IndexWork.pipe(
					Effect.provide(
						IndexWork.layer().pipe(
							Layer.provide(
								Layer.merge(
									Layer.mock(Governance, {}),
									Layer.mock(Indexing.PublicationInspection, {}),
								),
							),
						),
					),
				)
				const indexRecord = yield* index.load({
					namespace: "index:public",
					id: Execution.Id.make(first!.execution_id),
				})
				assert.equal(indexRecord.saved.identity.owner.kind, "platform")
				assert.equal(indexRecord.row.completedGeneration, "done")
				assert.equal(indexRecord.row.nextCheckAt, 321)
				const watches = yield* DeveloperWatches.DeveloperWatches.pipe(
					Effect.provide(DeveloperWatches.layer),
				)
				const watchRows = yield* sql<{
					kind: string
					resource_id: string
					execution_id: string
					next_check_at: number
				}>`select kind, resource_id, execution_id, next_check_at::float8 from openbot_developer_watches`
				assert.equal(watchRows.length, 2)
				for (const row of watchRows) {
					const watch = yield* watches.load({
						namespace: "developer-monitor:public",
						id: Execution.Id.make(row.execution_id),
					})
					assert.equal(watch.saved.identity.owner.kind, "platform")
					assert.equal(watch.ref.id, row.resource_id)
					assert.equal(watch.row.nextCheckAt, row.kind === "App" ? 789 : 567)
				}
				const [outbox] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_execution_outbox where sent_at is null`
				assert.equal(outbox?.count, 4)
				const [connection] = yield* sql<{
					body: string
				}>`select body from openbot_app_connections where id = 'connection'`
				assert.equal(connection?.body, saved.body)
				for (const row of rows) {
					assert.notInclude(row.input, "private-configuration")
					assert.notInclude(row.input, "private-proof-token")
					assert.notInclude(row.input, "private-invitation-token")
				}
				// A valid but changed source also fails. Verification does not trust an old cursor.
				yield* sql`update openbot_developer_reports set report = ${yield* encode({ ...report, input: "changed source" })} where id = ${reportId}`
				assert.isTrue(
					Schema.is(Progress.InvalidRecord)(
						yield* move.verify.pipe(Effect.flip),
					),
				)
				yield* sql`update openbot_developer_reports set report = ${yield* encode(report)} where id = ${reportId}`
				yield* move.verify
				yield* sql`update openbot_app_index_jobs set execution_id = null where card_url = ${cardUrl}`
				assert.isTrue(
					Schema.is(Progress.InvalidRecord)(
						yield* move.verify.pipe(Effect.flip),
					),
				)
			}),
	)
})
