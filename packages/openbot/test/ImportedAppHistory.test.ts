import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Chat, Item } from "@openbot-build/core"
import {
	AppCalls,
	Authorization,
	CodeRuns,
	Execution,
	TokenId,
	type Caller,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { Prompt } from "effect/ai"
import { AppCommands } from "../src/apps/AppCommands.ts"
import * as AppQueries from "../src/apps/AppQueries.ts"
import { Bots } from "../src/bots/Bots.ts"
import { CodeCommands } from "../src/code/CodeCommands.ts"
import * as CodeQueries from "../src/code/CodeQueries.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Migrations from "../src/database/Migrations.ts"
import * as Apps from "../src/database/conversion/Apps.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const actor: Caller = {
	kind: "member",
	organizationId: "org",
	userId: "person",
}
const token: Caller = {
	...actor,
	kind: "user_token",
	tokenId: TokenId.make("token"),
}
const namespace = '["org","person"]'
const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const database = Store.layer.pipe(
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
const readPolicy = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("read", Authorization.Chat)
})

it.layer(database, { excludeTestServices: true })((it) => {
	it.effect(
		"App and Code Mode queries read migrated history with current rights and safe errors",
		() =>
			Effect.gen(function* () {
				yield* Migrations.initialize
				const sql = yield* PgClient.PgClient
				const secrets = yield* Secrets.Secrets
				const seal = (value: Schema.Json, binding: ReadonlyArray<string>) =>
					Effect.gen(function* () {
						return yield* secrets.seal(
							yield* encode(value),
							yield* encode(binding),
						)
					})
				yield* sql`insert into openbot_chats ${sql.insert({ namespace, id: "chat", body: "{}", state: "{}", bot: "bot", kind: "direct", status: "Idle", revision: 0, inbox_size: 0, created_at: 1, updated_at: 1 })}`
				const source = {
					connectionId: "connection",
					connectionName: "App",
					cardUrl: "https://example.test/card",
					appName: "App",
					remoteIndex: 0,
					revision: 1,
					kind: "tool",
					name: "read",
				}
				const value = {
					id: "operation",
					chat: "chat",
					turn: "turn",
					callId: "call",
					toolName: "apps.read",
					source,
					arguments: {},
					readOnly: true,
					round: 0,
					status: "Completed",
					result: {
						_tag: "Completed",
						source,
						operationId: "operation",
						result: { text: "saved result" },
					},
				}
				yield* sql`insert into openbot_app_invocations ${sql.insert({ owner: namespace, id: value.id, chat: "chat", status: value.status, body: yield* seal(value, ["app-invocation", namespace, value.id]) })}`
				const failed = {
					...value,
					id: "failed",
					status: "Failed",
					result: {
						_tag: "Failed",
						source,
						operationId: "failed",
						reason: "Error",
						message: "raw inside error",
						cause: "private cause",
					},
				}
				yield* sql`insert into openbot_app_invocations ${sql.insert({ owner: namespace, id: failed.id, chat: "chat", status: failed.status, body: yield* seal(failed, ["app-invocation", namespace, failed.id]) })}`
				const run = {
					id: "program",
					chat: "chat",
					turn: "turn",
					callId: "program-call",
					status: "Completed",
					code: "return await apps.read({})",
					reason: "Read the note.",
					calls: [
						{
							index: 0,
							binding: "apps.read",
							source,
							operationId: "operation",
							argumentsHash: "saved",
							outcome: { _tag: "Done", result: value.result },
						},
					],
					result: {
						_tag: "Completed",
						value: { text: "saved result" },
						logs: ["Read the note."],
					},
					createdAt: 1,
					updatedAt: 2,
					seed: 1,
					clock: 1,
					organizationId: "org",
					userId: "person",
				}
				yield* sql`insert into openbot_code_runs ${sql.insert({ owner: namespace, id: run.id, chat: "chat", call_id: run.callId, status: run.status, body: yield* seal(run, ["code-run", namespace, run.id]) })}`
				const item = {
					id: "item",
					seq: 1,
					origin: { chat: "chat", turn: "turn", step: 2 },
					content: yield* Schema.encodeEffect(Item.Record.fields.content)(
						Prompt.make([
							{
								role: "tool",
								content: [
									Prompt.toolResultPart({
										id: "call",
										name: "apps.read",
										result: { text: "saved result" },
										isFailure: false,
										providerExecuted: false,
									}),
								],
							},
						]),
					),
				}
				yield* sql`insert into openbot_chat_items ${sql.insert({ namespace, chat: "chat", seq: 1, id: "item", turn: "turn", value: yield* encode(item) })}`
				yield* Apps.run
				yield* Apps.check
				yield* Apps.verify
				yield* Apps.verify
				const allowed = yield* Ref.make(true)
				const policy = Authorizer.layer(Authorization.Auth, {
					policy: () =>
						Ref.get(allowed).pipe(
							Effect.map((allow) =>
								allow ? readPolicy : Authorization.emptyPolicy,
							),
						),
				})
				const queries = yield* Effect.all({
					apps: AppQueries.make,
					code: CodeQueries.make,
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							policy,
							Layer.mock(Bots, { find: () => Effect.succeedNone }),
							Layer.mock(AppCommands, {}),
							Layer.mock(CodeCommands, {}),
						),
					),
				)
				for (const caller of [actor, token]) {
					const operation = yield* queries.apps.read(
						caller,
						AppCalls.AppOperationId.make("operation"),
					)
					assert.deepStrictEqual(operation.result, {
						_tag: "Completed",
						result: { text: "saved result" },
					})
					assert.strictEqual(operation.status, "completed")
					assert.strictEqual(
						(yield* queries.apps.history(caller, operation.id)).position.step,
						2,
					)
					assert.strictEqual(
						(yield* queries.apps.list(caller, Chat.Id.make("chat"))).length,
						2,
					)
					const error = yield* queries.apps.read(
						caller,
						AppCalls.AppOperationId.make("failed"),
					)
					assert.strictEqual(error.result?._tag, "Failed")
					const encoded = yield* Schema.encodeEffect(
						Schema.fromJsonString(AppCalls.ExecutionView),
					)(error)
					assert.notInclude(encoded, "raw inside error")
					assert.notInclude(encoded, "private cause")
					const program = yield* queries.code.read(
						caller,
						CodeRuns.CodeRunId.make("program"),
					)
					assert.strictEqual(program.calls[0]?.app?.id, "operation")
					assert.strictEqual(program.result?._tag, "Completed")
					assert.strictEqual(
						(yield* queries.code.list(caller, Chat.Id.make("chat"))).length,
						1,
					)
					assert.isTrue(
						Schema.is(Execution.Conflict)(
							yield* queries.apps
								.respond(
									caller,
									operation.id,
									Execution.CommandKey.make("resume"),
									0,
									{},
								)
								.pipe(Effect.flip),
						),
					)
				}
				const other = { ...actor, userId: "other" }
				assert.strictEqual(
					(yield* queries.apps
						.read(other, AppCalls.AppOperationId.make("operation"))
						.pipe(Effect.flip))._tag,
					"ExperienceNotFound",
				)
				yield* Ref.set(allowed, false)
				assert.isTrue(
					Schema.is(Execution.Forbidden)(
						yield* queries.apps
							.read(token, AppCalls.AppOperationId.make("operation"))
							.pipe(Effect.flip),
					),
				)
				assert.isTrue(
					Schema.is(Execution.Forbidden)(
						yield* queries.code
							.read(actor, CodeRuns.CodeRunId.make("program"))
							.pipe(Effect.flip),
					),
				)
				const rows = yield* sql<{
					input: string
				}>`select input from openbot_executions`
				assert.isTrue(
					Arr.every(rows, (row) => !Str.includes("private cause")(row.input)),
				)
				// A saved verification cursor never permits a later corrupt source to pass.
				yield* sql`update openbot_app_invocations set body = 'broken' where id = 'operation'`
				assert.strictEqual(
					(yield* Apps.verify.pipe(Effect.flip))._tag,
					"DataUpgradeInvalidRecord",
				)
			}),
	)
})
