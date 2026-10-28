import { AccountCaller } from "@openbot-build/domain"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Chat, Turn } from "@openbot-build/core"
import { Authorization, Execution, type Caller } from "@openbot-build/domain"
import { Authorizer } from "@nmnmcc/ability"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Option,
	Redacted,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Prompt } from "effect/ai"
import { WorkflowEngine } from "effect/workflow"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Migrations from "../src/database/Migrations.ts"
import * as Convert from "../src/database/conversion/Convert.ts"
import * as Progress from "../src/database/conversion/Progress.ts"
import * as Imported from "../src/database/conversion/Executions.ts"
import * as ImportedWorkflow from "../src/database/conversion/ImportedWorkflow.ts"
import * as ImportedHistory from "../src/apps/ImportedHistory.ts"
import * as IndexWork from "../src/apps/IndexWork.ts"
import * as DeveloperWatches from "../src/apps/DeveloperWatches.ts"
import * as IndexFixture from "./IndexCommandsFixture.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as ErrorRecords from "../src/errors/Records.ts"
import * as Store from "../src/execution/Store.ts"
import * as Commands from "../src/execution/Commands.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as InputCommands from "../src/chats/InputCommands.ts"
import * as TurnAccess from "../src/chats/TurnAccess.ts"
import * as ChatQueries from "../src/chats/ChatQueries.ts"
import * as ChatViews from "../src/chats/ChatViews.ts"
import * as BotRecords from "../src/bots/BotRecords.ts"
import * as Bots from "../src/bots/Bots.ts"
import * as Delegations from "../src/bots/Delegations.ts"
import * as OpenWorkCount from "../src/bots/OpenWorkCount.ts"
import * as Grants from "../src/capabilities/Grants.ts"
import * as Requests from "../src/capabilities/Requests.ts"
import * as Rules from "../src/capabilities/Rules.ts"
import * as Reminders from "../src/plugins/work/Reminders.ts"
import * as Channels from "../src/channels/Channels.ts"
import * as TokensPostgres from "../src/auth/TokensPostgres.ts"
import * as OrganizationPostgres from "../src/organization/OrganizationPostgres.ts"
import { Organization } from "../src/organization/Organization.ts"
import * as RolesPostgres from "../src/authorization/RolesPostgres.ts"
import { policyOf } from "../src/authorization/Load.ts"
import * as PlatformAdminsPostgres from "../src/platform/PlatformAdminsPostgres.ts"
import * as AuditLogPostgres from "../src/audit/AuditLogPostgres.ts"
import * as SettingsPostgres from "../src/settings/SettingsPostgres.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"
import * as Fixture from "./MigrationRehearsalFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Observation.layer.pipe(
	Layer.provideMerge(Store.layer),
	Layer.provideMerge(ErrorRecords.layer),
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (database) =>
				Layer.merge(
					DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
					Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
				),
			),
		),
	),
	Layer.provideMerge(NodeServices.layer),
)
const auth = Authorizer.layer(Authorization.Auth, {
	policy: (caller) =>
		Schema.decodeUnknownEffect(AccountCaller)(caller).pipe(
			Effect.flatMap((caller) => policyOf(caller, { platform: false })),
		),
})
const runtime = Layer.mergeAll(
	InputCommands.layer,
	Commands.layer,
	ImportedWorkflow.layer,
	OpenWorkCount.layer,
).pipe(
	Layer.provideMerge(TurnAccess.layer),
	Layer.provideMerge(Requests.layer),
	Layer.provideMerge(
		Layer.mergeAll(
			Bots.layer,
			Delegations.layer,
			Grants.layer,
			Rules.layer,
			Reminders.layer,
			Channels.layer,
		),
	),
	Layer.provideMerge(BotRecords.layer),
	Layer.provideMerge(auth),
	Layer.provideMerge(
		Layer.mergeAll(
			OrganizationPostgres.layer,
			TokensPostgres.layer,
			RolesPostgres.layer,
			PlatformAdminsPostgres.layer,
		),
	),
	Layer.provideMerge(
		Layer.mergeAll(AuditLogPostgres.layer, SettingsPostgres.layer),
	),
	Layer.provideMerge(Engine.layerRegistry),
	Layer.provide(WorkflowEngine.layerMemory),
)
const actor: Caller = {
	kind: "member",
	organizationId: "org",
	userId: "person",
}
const keyOf = (row: { id: string }) => ({
	namespace: Fixture.namespace,
	id: Execution.Id.make(row.id),
})
const startup = Effect.scoped(Migrations.checkStartup)

it.layer(database, { excludeTestServices: true, timeout: "90 seconds" })(
	(it) => {
		it.effect(
			"the old database resumes a full data move and accepts new Chat input",
			() =>
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					const secrets = yield* Secrets.Secrets
					const store = yield* Store.Store
					yield* Fixture.before
					yield* Fixture.resources
					yield* Fixture.chats
					yield* Fixture.applications
					yield* Fixture.connections
					yield* Fixture.channels
					const sourceTables = yield* sql<{
						name: string
					}>`select tablename as name from pg_tables where schemaname = 'public' and tablename like 'openbot_%' order by tablename`
					const inventory = yield* Effect.forEach(sourceTables, ({ name }) =>
						Effect.gen(function* () {
							const [row] = yield* sql<{
								count: number
							}>`select count(*)::float8 as count from ${sql(name)}`
							return { table: name, rows: row?.count ?? 0 }
						}),
					)
					assert.isAtLeast(
						Arr.filter(inventory, (entry) => entry.rows > 0).length,
						25,
					)
					const failure = yield* Migrations.upgrade.pipe(
						Effect.tapError(Effect.logError),
						Effect.flip,
					)
					assert.ok(
						Schema.is(Progress.InvalidRecord)(failure),
						`Expected a saved bad-record report, got ${failure._tag}`,
					)
					const [step] = yield* sql<{
						rows: string
						complete: boolean
						cursor: string | null
					}>`select rows, complete, cursor from openbot_data_upgrade_steps where step = 'import:channel-inbox'`
					assert.equal(Number(step?.rows), 100)
					assert.isFalse(step?.complete)
					assert.isString(step?.cursor)
					assert.ok(
						Schema.is(Progress.UpgradeRequired)(
							yield* startup.pipe(Effect.flip),
						),
					)
					const [kept] = yield* sql<{
						event: string
					}>`select event from openbot_channel_inbox where event_id = '000'`
					if (kept === undefined)
						return yield* Effect.die("Expected the first saved event.")
					assert.notInclude(kept.event, "private input")
					const failures = yield* sql<{
						id: string
						cause: string
					}>`select id, cause from openbot_data_upgrade_failures`
					assert.isAbove(failures.length, 0)
					for (const report of failures) {
						assert.notInclude(report.cause, "broken")
						assert.isNotEmpty(
							yield* secrets.open(
								report.cause,
								`data-upgrade-failure:${report.id}`,
							),
						)
					}
					yield* sql`update openbot_channel_inbox set event = ${yield* Fixture.encode(Fixture.event("100"))} where event_id = '100'`
					yield* Migrations.upgrade
					yield* startup
					const [sealedVault] = yield* sql<{
						values: string
					}>`select values from openbot_vault_items where id = 'vault-item'`
					if (sealedVault === undefined)
						return yield* Effect.die("Expected the saved Vault item.")
					yield* sql`update openbot_vault_items set values = 'broken private key' where id = 'vault-item'`
					assert.ok(
						Schema.is(Progress.InvalidRecord)(
							yield* Progress.withMaintenance(Convert.run).pipe(Effect.flip),
						),
					)
					assert.ok(
						Schema.is(Progress.UpgradeRequired)(
							yield* startup.pipe(Effect.flip),
						),
					)
					yield* sql`update openbot_vault_items set values = ${sealedVault.values} where id = 'vault-item'`
					yield* Migrations.upgrade
					yield* startup
					const beforeRepeat = yield* sql<{
						id: string
						input: string
					}>`select id, input from openbot_executions order by id`
					yield* Migrations.upgrade
					yield* startup
					assert.deepEqual(
						yield* sql`select id, input from openbot_executions order by id`,
						beforeRepeat,
					)
					assert.deepEqual(
						yield* sql`select event from openbot_channel_inbox where event_id = '000'`,
						[kept],
					)
					const afterCounts: HashMap.HashMap<string, number> =
						HashMap.fromIterable(
							Arr.map(
								yield* Progress.inventory,
								(entry) => [entry.table, entry.rows] as const,
							),
						)
					for (const entry of inventory)
						assert.equal(
							Option.getOrThrow(HashMap.get(afterCounts, entry.table)),
							entry.rows,
							entry.table,
						)
					const [ready] = yield* sql<{
						state: string
						checked_at: string | null
					}>`select state, checked_at from openbot_data_upgrades`
					assert.equal(ready?.state, "ready")
					assert.isNotNull(ready?.checked_at)
					const [pending] = yield* sql<{
						count: number
					}>`select count(*)::float8 as count from openbot_cluster_messages`
					assert.equal(pending?.count, 0)
					const [usage] = yield* sql<{
						status: string
						cost: string
						charged: boolean
					}>`select status, cost_micros::text as cost, charged from openbot_usage_events where id = 'usage'`
					assert.deepEqual(usage, {
						status: "confirmed",
						cost: "42",
						charged: true,
					})
					const [vault] = yield* sql<{
						values: string
					}>`select values from openbot_vault_items where id = 'vault-item'`
					assert.equal(
						yield* secrets.open(
							vault!.values,
							"openbot_vault_items:vault-item:values",
						),
						'{"key":"private Vault value"}',
					)
					const [memory] = yield* sql<{
						content: string
					}>`select content from openbot_bot_memories where id = 'memory'`
					assert.equal(
						yield* secrets.open(
							memory!.content,
							'["bot-memory","org","bot","memory","content"]',
						),
						"private memory",
					)
					const records = yield* sql<{
						id: string
						resource_kind: string
						resource_id: string
						status: string
					}>`select id, resource_kind, resource_id, status from openbot_executions where workflow = ${Imported.workflowName} order by resource_kind, resource_id`
					const record = (kind: string, id: string) =>
						Option.getOrThrow(
							Arr.findFirst(
								records,
								(row) => row.resource_kind === kind && row.resource_id === id,
							),
						)
					assert.equal(record("Turn", "turn").status, "outcome_unknown")
					assert.equal(record("Turn", "old-turn").status, "completed")
					assert.equal(record("Request", "approval").status, "interrupted")
					assert.equal(record("AppCall", "a").status, "outcome_unknown")
					assert.equal(record("AppCall", "c").status, "completed")
					assert.equal(record("CodeRun", "program").status, "outcome_unknown")
					assert.equal(
						record("IndexRequest", "old-index-request").status,
						"completed",
					)
					assert.equal(
						record("IndexRequest", "pending-index-request").status,
						"interrupted",
					)
					yield* Effect.gen(function* () {
						const index = yield* IndexWork.IndexWork
						const watches = yield* DeveloperWatches.DeveloperWatches
						const [job] = yield* sql<{
							execution_id: string | null
						}>`select execution_id from openbot_app_index_jobs where namespace = 'public' and card_url = 'https://example.test/card'`
						if (job?.execution_id === null || job?.execution_id === undefined)
							return yield* Effect.die("Expected the saved Index execution.")
						const key = {
							namespace: "index:public",
							id: Execution.Id.make(job.execution_id),
						}
						const loaded = yield* index.load(key)
						assert.equal(loaded.saved.record.status, "queued")
						assert.equal(loaded.row.generation, "new-check")
						assert.equal(loaded.row.completedGeneration, "old-check")
						assert.equal(
							(yield* index.job("https://example.test/card", "old-check")).pipe(
								Option.getOrThrow,
							).status,
							"Completed",
						)
						const next = yield* index.begin(yield* store.takeOver(key))
						assert.equal(next.generation, "new-check")
						assert.equal(
							next.input.previous?.cardUrl,
							"https://example.test/card",
						)
						const savedWatches = yield* sql<{
							kind: string
							resource_id: string
							execution_id: string | null
							next_check_at: bigint
						}>`select kind, resource_id, execution_id, next_check_at from openbot_developer_watches where namespace = 'public' order by kind`
						assert.equal(savedWatches.length, 2)
						for (const watch of savedWatches) {
							if (watch.execution_id === null)
								return yield* Effect.die(
									"Expected the saved developer execution.",
								)
							const watchKey = {
								namespace: "developer-monitor:public",
								id: Execution.Id.make(watch.execution_id),
							}
							const loadedWatch = yield* watches.load(watchKey)
							assert.equal(loadedWatch.ref.kind, watch.kind)
							assert.equal(loadedWatch.ref.id, watch.resource_id)
							assert.equal(loadedWatch.saved.record.status, "queued")
							assert.equal(
								watch.next_check_at,
								watch.kind === "App" ? 200n : 100n,
							)
						}
					}).pipe(
						Effect.provide(
							Layer.mergeAll(IndexFixture.layer, DeveloperWatches.layer),
						),
					)
					yield* Effect.gen(function* () {
						const organization = yield* Organization
						assert.equal(
							Option.getOrThrow(
								yield* organization.activeMember("org", "person"),
							).name,
							"Person",
						)
						const commands = yield* Commands.Commands
						assert.equal(
							(yield* commands.get(
								Execution.Id.make(record("File", "removed-file").id),
								actor,
							)).status,
							"interrupted",
						)
						assert.equal(
							(yield* commands.get(
								Execution.Id.make(
									record("IndexRequest", "old-index-request").id,
								),
								actor,
							)).status,
							"completed",
						)
						for (const resource of ["File", "IndexRequest"] as const) {
							const id = Execution.Id.make(
								record(
									resource,
									resource === "File" ? "removed-file" : "old-index-request",
								).id,
							)
							assert.ok(
								Schema.is(Execution.Forbidden)(
									yield* commands
										.get(id, { ...actor, userId: "other-person" })
										.pipe(Effect.flip),
								),
							)
						}
						const indexExecution = Execution.Id.make(
							record("IndexRequest", "old-index-request").id,
						)
						yield* sql`update openbot_developer_proofs set status = 'Relinquished' where namespace = 'public' and id = 'proof'`
						assert.ok(
							Schema.is(Execution.Forbidden)(
								yield* commands.get(indexExecution, actor).pipe(Effect.flip),
							),
						)
						yield* sql`update openbot_developer_proofs set status = 'Confirmed' where namespace = 'public' and id = 'proof'`
						assert.equal(
							(yield* commands.get(indexExecution, actor)).status,
							"completed",
						)
						const queries = yield* ChatQueries.make.pipe(
							Effect.provide(
								Layer.mock(ModelRegistry, { defaultModel: Option.none() }),
							),
						)
						const view = ChatViews.project(
							yield* queries.get(actor, Chat.Id.make("chat")),
						)
						assert.equal(view.status, "Interrupted")
						assert.equal(view.executionId, record("Turn", "turn").id)
						assert.equal(
							(yield* queries.turns(actor, Chat.Id.make("chat"), {})).items
								.length,
							2,
						)
						assert.equal(
							(yield* queries.items(actor, Chat.Id.make("chat"), {})).items[0]
								?.id,
							"item",
						)
						assert.equal(
							(yield* queries.turn(
								actor,
								Chat.Id.make("chat"),
								Turn.Id.make("old-turn"),
							)).saved.record.status._tag,
							"Completed",
						)
						const requests = yield* Requests.Requests
						assert.equal(
							Option.getOrThrow(yield* requests.find("org", "approval")).request
								.status,
							"pending",
						)
						const channels = yield* Channels.Channels
						assert.isTrue(
							Option.getOrThrow(yield* channels.get("org", "channel"))
								.needsAuthorization,
						)
						const history = yield* ImportedHistory.make
						assert.deepEqual(
							(yield* history.app(keyOf(record("AppCall", "c")), actor)).view
								.result,
							{ _tag: "Completed", result: { note: "private result" } },
						)
						assert.equal(
							(yield* history.code(keyOf(record("CodeRun", "program")), actor))
								.calls[0]?.app?.id,
							"a",
						)
						const old = keyOf(record("Turn", "old-turn"))
						assert.equal(
							(yield* commands.get(old.id, actor)).status,
							"completed",
						)
						assert.isAbove(
							(yield* commands
								.observe(old.id, actor, 0)
								.pipe(Stream.runCollect)).length,
							0,
						)
						for (const entry of records) {
							if (entry.status !== "outcome_unknown") continue
							const saved = yield* store.load(keyOf(entry))
							if (saved.context?.kind !== "Chat" || saved.context.id !== "chat")
								continue
							for (const call of yield* store.calls(keyOf(entry))) {
								if (call.status !== "outcome_unknown") continue
								yield* commands.decide(Execution.Id.make(entry.id), actor, {
									commandKey: Execution.CommandKey.make(`stop:${call.id}`),
									decisionId: call.id,
									answer: "stop",
								})
							}
						}
						const inputs = yield* InputCommands.InputCommands
						const input = {
							caller: actor,
							chat: Chat.Id.make("chat"),
							queue: false,
							content: Prompt.make("New input after the data move"),
						}
						const receipt = yield* inputs.message(
							Fixture.namespace,
							Execution.CommandKey.make("after-upgrade"),
							input,
						)
						assert.deepEqual(
							yield* inputs.message(
								Fixture.namespace,
								Execution.CommandKey.make("after-upgrade"),
								input,
							),
							receipt,
						)
						const current = yield* queries.get(actor, Chat.Id.make("chat"))
						assert.equal(current.executionId, receipt.executionId)
						assert.equal(current.view.chat.turn?.status._tag, "Running")
						assert.equal(
							(yield* store.loadMember({
								namespace: Fixture.namespace,
								id: receipt.executionId,
							})).identity.actor.kind,
							"member",
						)
					}).pipe(Effect.provide(runtime))
				}),
			90_000,
		)
	},
)
