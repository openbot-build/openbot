import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	AppIndex,
	Bots,
	ConnectionId,
	Execution,
	Settings as SettingsModel,
} from "@openbot-build/domain"
import {
	Cause,
	Crypto,
	Effect,
	Layer,
	Logger,
	Option,
	Redacted,
	References,
	Schema,
	String as Str,
} from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Records from "../src/errors/Records.ts"
import * as Report from "../src/errors/Report.ts"
import * as Failures from "../src/errors/Failures.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Judge from "../src/capabilities/Judge.ts"
import * as Db from "../src/database/Database.ts"
import * as Bindings from "../src/apps/Bindings.ts"
import { Capabilities } from "../src/apps/Capabilities.ts"
import { ActionPolicy } from "../src/apps/ActionPolicy.ts"
import * as AppPolicy from "../src/apps/ActionPolicy.ts"
import { Settings } from "../src/settings/Settings.ts"
import { Connections } from "../src/apps/Connections.ts"
import { PublicIndex } from "../src/apps/Index.ts"
import * as Assistance from "../src/plugins/apps/Assistance.ts"
import { bot } from "./BotFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Records.layer.pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const collect = () => {
	let lines: ReadonlyArray<unknown> = []
	return {
		lines: () => lines,
		layer: Logger.layer([
			Logger.make((log) => {
				lines = [
					...lines,
					{
						message: log.message,
						cause: Cause.pretty(log.cause),
						annotations: log.fiber.getRef(References.CurrentLogAnnotations),
					},
				]
			}),
		]),
	}
}
const opened = (errorId: Execution.ErrorId) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const secrets = yield* Secrets.Secrets
		const [row] = yield* sql<{
			readonly cause: string
		}>`select cause from openbot_execution_failures where id = ${errorId}`
		assert.isDefined(row)
		assert.notMatch(row!.cause, /private-/)
		return yield* secrets.open(row!.cause, `failure:${errorId}`)
	})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"App binding discovery keeps a broken private connection before giving an empty list",
		() => {
			const logs = collect()
			return Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const secrets = yield* Secrets.Secrets
				const crypto = yield* Crypto.Crypto
				const db = yield* Db.make
				const report = yield* Report.make
				const owner = "test-binding-owner"
				const id = yield* crypto.randomUUIDv4()
				const body = yield* secrets.seal(
					'{"private-app-record":',
					yield* encode(["connection", owner, id]),
				)
				yield* sql`insert into openbot_app_connections (owner, id, name, revision, body) values (${owner}, ${id}, 'Test', 1, ${body})`
				const result = yield* Bindings.describe(
					{
						db,
						secrets,
						crypto,
						report,
						capabilities: Capabilities.of({
							open: () => Effect.die("A broken connection must not be opened."),
						}),
						policy: ActionPolicy.of({ isRead: () => Effect.succeed(false) }),
					},
					owner,
					[],
					Option.none(),
				)
				assert.deepStrictEqual(result.entries, [])
				assert.strictEqual(result.issues.length, 1)
				assert.notMatch(yield* encode([result, logs.lines()]), /private-/)
				const [failure] = yield* sql<{
					readonly id: string
				}>`select id from openbot_execution_failures order by created_at desc limit 1`
				assert.isDefined(failure)
				const saved = yield* opened(Execution.ErrorId.make(failure!.id))
				assert.match(saved, /SchemaError/)
				assert.match(saved, /Expected a valid JSON string/)
			}).pipe(Effect.provide(logs.layer))
		},
	)
	it.effect(
		"App read rules keep a private settings failure before treating a tool as a write",
		() => {
			const logs = collect()
			return Effect.gen(function* () {
				const policy = yield* ActionPolicy
				const read = yield* policy.isRead({
					organizationId: "test-org",
					source: {
						kind: "tool",
						cardUrl: "https://app.example/card.json",
						name: "read_page",
						connectionId: ConnectionId.make("test-connection"),
						connectionName: "Test App",
						appName: "Test App",
						remoteIndex: 0,
						revision: 1,
					},
				})
				assert.isFalse(read)
				assert.notMatch(yield* encode(logs.lines()), /private-/)
				const sql = yield* PgClient.PgClient
				const [failure] = yield* sql<{
					readonly id: string
				}>`select id from openbot_execution_failures order by created_at desc limit 1`
				assert.isDefined(failure)
				assert.match(
					yield* opened(Execution.ErrorId.make(failure!.id)),
					/private-settings-result/,
				)
			}).pipe(
				Effect.provide([
					logs.layer,
					AppPolicy.layer.pipe(
						Layer.provide(
							Layer.mock(Settings, {
								organization: () =>
									Effect.fail("private-settings-result").pipe(
										Failures.replace(
											"The test settings could not be read",
											() => SettingsModel.SettingsUnavailable.make({}),
										),
									),
							}),
						),
					),
				]),
			)
		},
	)
	it.effect(
		"a feature report seals every failure reason and logs only a safe reference",
		() => {
			const logs = collect()
			return Effect.gen(function* () {
				const report = yield* Report.make
				// Capture the recorder at construction. A method needs no recorder context.
				const failure = yield* report(
					"The test feature failed",
					Cause.combine(
						Cause.fail(new Error("private-provider-token")),
						Cause.die(new Error("private-driver-result")),
					),
				).pipe(
					Effect.provideService(
						Records.Records,
						Records.Records.of({
							record: () => Effect.die("The captured recorder must be used."),
						}),
					),
				)
				assert.strictEqual(failure.category, "unavailable")
				const text = yield* opened(failure.errorId)
				assert.match(text, /private-provider-token/)
				assert.match(text, /private-driver-result/)
				const output = yield* encode(logs.lines())
				assert.notMatch(output, /private-/)
				assert.include(output, failure.errorId)
			}).pipe(Effect.provide(logs.layer))
		},
	)
	it.effect(
		"a judge failure keeps its private cause and gives a safe no match result",
		() => {
			const logs = collect()
			return Effect.gen(function* () {
				const judge = yield* Judge.make.pipe(
					Effect.provide(
						Layer.mock(Judge.HelperModel, {
							rules: () => Effect.die(new Error("private-judge-result")),
						}),
					),
				)
				const result = yield* judge.decide({
					organizationId: "test-org",
					bot,
					capability: { action: "tools.call", target: "read_docs" },
					reason: "Read the page.",
					rules: [
						{
							id: Bots.RuleId.make("test-rule"),
							bot: bot.id,
							author: { _tag: "Person", userId: "test-user" },
							text: "The Bot may read the page.",
							status: "active",
							version: 1,
							createdAt: 0,
							updatedAt: 0,
						},
					],
				})
				assert.strictEqual(result.decision, "no_match")
				assert.notMatch(yield* encode([result, logs.lines()]), /private-/)
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					readonly id: string
				}>`select id from openbot_execution_failures order by created_at desc limit 1`
				assert.match(
					yield* opened(Execution.ErrorId.make(rows[0]!.id)),
					/private-judge-result/,
				)
			}).pipe(Effect.provide(logs.layer))
		},
	)
	it.effect(
		"App assistance records a private Index error before it gives a safe failure",
		() => {
			const logs = collect()
			return Effect.gen(function* () {
				const index = yield* PublicIndex
				const connections = yield* Connections
				const report = yield* Report.make
				const entries = Assistance.entries({
					identity: {
						kind: "member",
						organizationId: "test-org",
						userId: "test-user",
					},
					occupied: [],
					index,
					connections,
					report,
				})
				const context = { preliminary: () => Effect.void }
				const result = yield* entries[0]!.handle(
					{ query: "read the page" },
					context,
				)
				assert.strictEqual(result._tag, "AppAssistanceFailed")
				assert.notMatch(yield* encode([result, logs.lines()]), /private-/)
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					readonly id: string
				}>`select id from openbot_execution_failures order by created_at desc limit 1`
				assert.match(
					yield* opened(Execution.ErrorId.make(rows[0]!.id)),
					/private-index-response/,
				)
			}).pipe(
				Effect.provide([
					logs.layer,
					Layer.mock(PublicIndex, {
						search: () =>
							Effect.fail(
								AppIndex.IndexUnavailable.make({
									issues: [
										{
											source: "test-source",
											message: "private-index-response",
										},
									],
								}),
							),
					}),
					Layer.mock(Connections, {}),
				]),
			)
		},
	)
})
