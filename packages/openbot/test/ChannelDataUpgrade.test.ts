import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Authorization, Execution, TokenId } from "@openbot-build/domain"
import { Authorizer, Policy } from "@nmnmcc/ability"
import * as RuntimeChannels from "../src/channels/Channels.ts"
import * as RuntimeTriggers from "../src/triggers/Triggers.ts"
import * as Admission from "../src/channels/ChannelAdmission.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import {
	Array as Arr,
	Effect,
	Crypto,
	Layer,
	Option,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import { Hex } from "effect/encoding"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Migrations from "../src/database/Migrations.ts"
import * as Channels from "../src/database/conversion/Channels.ts"
import * as Imported from "../src/database/conversion/Executions.ts"
import * as Progress from "../src/database/conversion/Progress.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const database = Layer.unwrap(
	Effect.map(PostgresTest.start, (database) =>
		Layer.merge(
			DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
			Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
		),
	),
).pipe(Layer.provideMerge(NodeServices.layer))

const auth = Authorizer.layer(Authorization.Auth, {
	policy: () =>
		Effect.succeed(
			Policy.define(Authorization.OpenBot)(function* (_) {
				yield* _.allow("*", "*")
			}),
		),
})

it.layer(Store.layer.pipe(Layer.provideMerge(database)), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"old Channel work keeps its input and time without making a caller",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const db = yield* Db.make
				const secrets = yield* Secrets.Secrets
				const store = yield* Store.Store
				const folder = yield* MigrationTest.migrationsWhere(
					(name) => name < "20261026084803_execution_records",
				)
				yield* migrate(db, { migrationsFolder: folder })
				const credentials = {
					kind: "custom",
					endpoint: "https://channel.example.test",
					secret: "private channel key",
				}
				yield* sql`insert into openbot_channels ${sql.insert({
					organization_id: "org",
					id: "channel",
					kind: "custom",
					name: "Channel",
					bot: "bot",
					actor: "member",
					enabled: true,
					credentials: yield* secrets.seal(
						yield* encode(credentials),
						"openbot_channels:channel:credentials",
					),
					hints: yield* encode({
						hints: { secret: "key" },
						plain: { endpoint: credentials.endpoint },
					}),
					version: 1,
					created_at: 1,
					updated_at: 2,
				})}`
				const event = (id: string) => ({
					_tag: "Message",
					eventId: id,
					conversation: { key: "room", kind: "group" },
					sender: { externalId: "external-person", displayName: "Person" },
					text: "private input",
					mentioned: true,
				})
				for (let index = 100; index >= 0; index--) {
					const id = Str.padStart(3, "0")(String(index))
					yield* sql`insert into openbot_channel_inbox ${sql.insert({
						organization_id: "org",
						channel_id: "channel",
						event_id: id,
						conversation_key: "room",
						event: index === 100 ? "broken" : yield* encode(event(id)),
						received_at: index + 10,
						next_at: index + 1000,
						claim: index === 0 ? "old-worker" : null,
					})}`
				}
				for (const [id, state, claim, ref] of [
					["pending", "pending", null, null],
					["sending", "pending", "old-worker", null],
					[
						"sent",
						"done",
						null,
						{ conversation: "room", id: "external-message" },
					],
				] as const) {
					yield* sql`insert into openbot_channel_deliveries ${sql.insert({
						id,
						organization_id: "org",
						channel_id: "channel",
						kind: "notice",
						state,
						claim,
						target: yield* encode({
							_tag: "Conversation",
							conversation: "room",
						}),
						body: yield* encode({ markdown: "private message" }),
						ref: ref === null ? null : yield* encode(ref),
						next_at: 9000,
						updated_at: 100,
					})}`
				}
				yield* sql`insert into openbot_triggers ${sql.insert({
					organization_id: "org",
					id: "trigger",
					owner_user_id: "member",
					bot: "bot",
					prompt: "private prompt",
					schedule_cron: "0 * * * *",
					hook_secret_hash: Hex.encode(
						yield* (yield* Crypto.Crypto).digest(
							"SHA-256",
							new TextEncoder().encode("old trigger key"),
						),
					),
					next_run_at: 5000,
					actor: "member",
					enabled: true,
					revision: 2,
					created_at: 1,
					updated_at: 2,
				})}`
				const reminder = {
					id: "reminder",
					userId: "member",
					author: "person",
					chat: "chat",
					turn: "turn",
					toolCallId: "tool",
					note: "private reminder",
					createdAt: 1,
					dueAt: 7000,
					status: "waiting",
				}
				yield* sql`insert into openbot_bot_records ${sql.insert({
					kind: "reminder",
					organization_id: "org",
					id: "reminder",
					owner: "member",
					scope: "chat",
					status: "waiting",
					body: yield* encode(reminder),
				})}`
				yield* sql`insert into openbot_computers ${sql.insert({
					organization_id: "org",
					id: "computer",
					owner_user_id: "member",
					name: "Computer",
					source: "connector",
					state: "running",
					features: yield* encode({
						pause: false,
						desktop: true,
						ports: false,
					}),
					created_by: "member",
					version: 1,
					created_at: 1,
					updated_at: 2,
				})}`
				yield* sql`insert into openbot_computer_calls ${sql.insert({
					id: "call",
					computer_id: "computer",
					call: yield* encode({
						id: "call",
						operation: {
							_tag: "Write",
							file: {
								path: "/private",
								encoding: "utf8",
								content: "private file",
							},
						},
					}),
					created_at: 3,
				})}`
				yield* Migrations.initialize
				// Convert.run seals reminders before this feature step.
				const binding = yield* encode(["reminder", "org", "reminder"])
				yield* sql`update openbot_bot_records set body = ${yield* encode({ id: "reminder", sealed: yield* secrets.seal(yield* encode(reminder), binding) })} where kind = 'reminder'`
				const failed = yield* Progress.withMaintenance(Channels.run).pipe(
					Effect.flip,
				)
				assert.isTrue(Schema.is(Progress.InvalidRecord)(failed))
				const [step] = yield* sql<{
					rows: string
					complete: boolean
				}>`select rows, complete from openbot_data_upgrade_steps where step = 'import:channel-inbox'`
				assert.strictEqual(Number(step?.rows), 100)
				assert.strictEqual(step?.complete, false)
				const [first] = yield* sql<{
					event: string
				}>`select event from openbot_channel_inbox where event_id = '000'`
				yield* sql`update openbot_channel_inbox set event = ${yield* encode(event("100"))} where event_id = '100'`
				yield* Progress.withMaintenance(Channels.run)
				yield* Progress.withMaintenance(Channels.run)
				assert.strictEqual((yield* Channels.check).length, 7)
				const [again] = yield* sql<{
					event: string
				}>`select event from openbot_channel_inbox where event_id = '000'`
				assert.deepStrictEqual(again, first)
				const ordered = yield* sql<{
					event_id: string
				}>`select event_id from openbot_channel_inbox order by position`
				assert.strictEqual(ordered[0]?.event_id, "000")
				assert.strictEqual(ordered[100]?.event_id, "100")
				const rows = yield* sql<{
					id: string
					namespace: string
					resource_kind: string
					resource_id: string
					status: string
					input: string
					identity: string
				}>`select id, namespace, resource_kind, resource_id, status, input, identity from openbot_executions order by resource_kind, resource_id`
				assert.strictEqual(rows.length, 109)
				for (const row of rows) {
					assert.notInclude(row.input, "private")
					const saved = yield* store.loadService(
						{ namespace: row.namespace, id: Execution.Id.make(row.id) },
						Imported.serviceId,
					)
					const input = yield* Schema.decodeUnknownEffect(Imported.Input)(
						saved.input,
					)
					assert.strictEqual(input.authority._tag, "NeedsAuthorization")
					assert.strictEqual(saved.identity.actor.kind, "service")
				}
				const status = (kind: string, id: string) =>
					Arr.findFirst(
						rows,
						(row) => row.resource_kind === kind && row.resource_id === id,
					)
				assert.strictEqual(
					status("ChannelDelivery", "sent").pipe((row) =>
						row._tag === "Some" ? row.value.status : undefined,
					),
					"completed",
				)
				assert.strictEqual(
					status("ChannelDelivery", "sending").pipe((row) =>
						row._tag === "Some" ? row.value.status : undefined,
					),
					"outcome_unknown",
				)
				assert.strictEqual(
					status("ChannelDelivery", "pending").pipe((row) =>
						row._tag === "Some" ? row.value.status : undefined,
					),
					"interrupted",
				)
				assert.strictEqual(
					status("ComputerCall", "call").pipe((row) =>
						row._tag === "Some" ? row.value.status : undefined,
					),
					"outcome_unknown",
				)
				const [channel] = yield* sql<{
					credentials: string
					execution_id: string
				}>`select credentials, execution_id from openbot_channels`
				assert.isDefined(channel)
				if (channel === undefined)
					return yield* Effect.die("Expected the Channel.")
				const opened = yield* secrets
					.open(channel.credentials, "openbot_channels:channel:credentials")
					.pipe(Effect.flatMap(Schema.decodeEffect(json)))
				assert.deepStrictEqual(opened, { credentials, caller: null })
				const [trigger] = yield* sql<{
					prompt: string
					next_run_at: string
					enabled: boolean
				}>`select prompt, next_run_at, enabled from openbot_triggers`
				assert.isDefined(trigger)
				if (trigger === undefined)
					return yield* Effect.die("Expected the trigger.")
				assert.strictEqual(Number(trigger.next_run_at), 5000)
				assert.isTrue(trigger.enabled)
				assert.notInclude(trigger.prompt, "private prompt")
				const [item] = yield* sql<{
					body: string
					status: string
				}>`select body, status from openbot_bot_records where kind = 'reminder'`
				if (item === undefined)
					return yield* Effect.die("Expected the reminder.")
				const sealed = yield* Schema.decodeEffect(
					Schema.fromJsonString(
						Schema.Struct({ id: Schema.String, sealed: Schema.String }),
					),
				)(item.body)
				const moved = yield* secrets.open(sealed.sealed, binding).pipe(
					Effect.flatMap(
						Schema.decodeEffect(
							Schema.fromJsonString(
								Schema.Struct({
									id: Schema.String,
									dueAt: Schema.Finite,
									executionId: Schema.String,
								}),
							),
						),
					),
				)
				assert.strictEqual(item.status, "waiting")
				assert.strictEqual(moved.id, "reminder")
				assert.strictEqual(moved.dueAt, 7000)
				const [counts] = yield* sql<{
					inbox: number
					pending: number
					deliveries: number
					outbox: number
					resources: number
					calls: number
				}>`select (select count(*)::float8 from openbot_channel_inbox) as inbox, (select count(*)::float8 from openbot_channel_inbox where done_at is null) as pending, (select count(*)::float8 from openbot_channel_deliveries) as deliveries, (select count(*)::float8 from openbot_execution_outbox) as outbox, (select count(*)::float8 from openbot_resource_owners) as resources, (select count(*)::float8 from openbot_computer_calls) as calls`
				assert.deepStrictEqual(counts, {
					inbox: 101,
					pending: 101,
					deliveries: 3,
					outbox: 0,
					resources: 0,
					calls: 1,
				})
				const caller = {
					kind: "user_token",
					organizationId: "org",
					userId: "new-member",
					tokenId: TokenId.make("current-token"),
				} as const
				const channelRecords = yield* RuntimeChannels.make.pipe(
					Effect.provide(auth),
				)
				const triggerRecords = yield* RuntimeTriggers.make.pipe(
					Effect.provide(auth),
				)
				const currentChannel = yield* channelRecords.get("org", "channel")
				assert.isTrue(Option.isSome(currentChannel))
				if (Option.isNone(currentChannel))
					return yield* Effect.die("Expected the Channel.")
				assert.isTrue(currentChannel.value.needsAuthorization)
				assert.isTrue(currentChannel.value.enabled)
				assert.isTrue(
					(yield* channelRecords.list(caller))[0]!.needsAuthorization,
				)
				assert.isTrue(
					Option.isNone(yield* channelRecords.authority("org", "channel")),
				)
				const admit = yield* Admission.make.pipe(
					Effect.provideService(RuntimeChannels.Channels, channelRecords),
				)
				assert.isTrue(
					Schema.is(Execution.Forbidden)(
						yield* admit("org", "channel").pipe(Effect.flip),
					),
				)
				const currentTrigger = yield* triggerRecords.get(caller, "trigger")
				assert.strictEqual(currentTrigger.prompt, "private prompt")
				assert.strictEqual(currentTrigger.nextRunAt, 5000)
				assert.isTrue(currentTrigger.needsAuthorization)
				assert.isTrue(
					(yield* triggerRecords.list(caller))[0]!.needsAuthorization,
				)
				assert.isTrue(
					Option.isNone(
						yield* triggerRecords.verifyHook("trigger", "old trigger key"),
					),
				)
				const savedTrigger = yield* triggerRecords.read("org", "trigger")
				assert.isTrue(
					Option.isSome(savedTrigger) &&
						Option.isNone(savedTrigger.value.caller),
				)
				const updated = yield* channelRecords.update(caller, "channel", 1, {
					name: "New Channel",
				})
				assert.isFalse(updated.needsAuthorization)
				assert.deepStrictEqual(
					yield* channelRecords.authority("org", "channel"),
					Option.some(caller),
				)
				yield* admit("org", "channel")
				const changed = yield* triggerRecords.update(caller, "trigger", {
					expected: 2,
				})
				assert.isFalse(changed.needsAuthorization)
				assert.strictEqual(changed.prompt, "private prompt")
				assert.strictEqual(changed.actor, caller.userId)
				assert.isNotNull(changed.executionId)
				if (changed.executionId === null)
					return yield* Effect.die("Expected a new timer.")
				const timer = yield* store.loadMember({
					namespace: ownerKey(caller),
					id: changed.executionId,
				})
				assert.deepStrictEqual(timer.identity.actor, caller)
				assert.strictEqual(timer.workflow, RuntimeTriggers.workflowName)
				assert.isTrue(
					Option.isSome(
						yield* triggerRecords.verifyHook("trigger", "old trigger key"),
					),
				)

				const [computer] = yield* sql<{
					state: string
				}>`select state from openbot_computers`
				assert.strictEqual(computer?.state, "offline")
			}),
	)
})
