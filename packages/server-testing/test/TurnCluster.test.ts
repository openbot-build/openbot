import * as TestDatabase from "@openbot-build/server-database/Testing"
import { InputCommands as InputCommandsModel } from "@openbot-build/conversation-contract/chats/InputCommands"
import * as Migrations from "@openbot-build/server-database/Migrations"
import { Delegations } from "@openbot-build/conversation-contract/bots/Delegations"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	Config,
	Model,
	Provider,
	ChatStoreRepository,
	Store as CoreStore,
} from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Fiber,
	Layer,
	Redacted,
	Schedule,
	Stream,
	String as Str,
} from "effect"
import { Prompt } from "effect/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Db from "@openbot-build/server-database/Database"
import * as Store from "@openbot-build/server-execution/Store"
import * as ErrorRecords from "@openbot-build/server-kernel/Records"
import * as Observation from "@openbot-build/server-execution/Observation"
import * as Secrets from "@openbot-build/server-kernel/Secrets"
import * as InputCommands from "@openbot-build/plugin-chats/InputCommands"
import { TurnAccess } from "@openbot-build/conversation-contract/chats/TurnAccess"
import * as ChatHost from "@openbot-build/conversation-contract/chats/ChatHost"
import * as StoredChats from "@openbot-build/conversation-contract/chats/StoredChats"
import * as BotFixture from "./BotFixture.ts"

layer(Layer.merge(NodeServices.layer, NodeCrypto.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"another process completes a Turn from its saved model result",
		() =>
			Effect.gen(function* () {
				const database = yield* TestDatabase.start
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const spawn = (runner: number) =>
					spawner.spawn(
						ChildProcess.make(
							"node",
							[
								"--disable-warning=ExperimentalWarning",
								new URL("./ExecutionNodeMain.ts", import.meta.url).pathname,
							],
							{
								extendEnv: true,
								env: {
									TEST_DATABASE_URL: database.url,
									TEST_RUNNER_ID: String(runner),
								},
								stdout: "inherit",
								stderr: "inherit",
							},
						),
					)
				const run = Effect.gen(function* () {
					yield* Migrations.migrate
					const sql = yield* PgClient.PgClient
					yield* sql`create table execution_test_steps (
				execution_id text not null, step text not null, count integer not null, runner integer not null,
				primary key (execution_id, step))`
					const db = yield* Db.make
					const store = yield* Store.Store
					const inputs = yield* InputCommandsModel
					const observation = yield* Observation.Observation
					const definition = yield* CoreStore.define({
						stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore },
						schemaVersion: "chat/1",
					})
					const chats = yield* ChatStoreRepository.make({
						definition,
						persistence: StoredChats.persistence(db, "turn-cluster"),
					})
					const { chain, kind, bot } = BotFixture.direct()
					const view = yield* chats.create({
						settings: {
							model: Config.Selection.make({
								provider: Provider.Id.make("test"),
								model: Model.Id.make("test"),
							}),
						},
						business: { [ChatHost.chatHostId]: { chain, kind, bot: bot.id } },
					})
					const identity = {
						owner: {
							organizationId: chain.organizationId,
							userId: chain.userId,
						},
						actor: {
							kind: "member" as const,
							organizationId: chain.organizationId,
							userId: chain.userId,
						},
						botId: bot.id,
					}
					const receipt = yield* inputs.submit(
						"turn-cluster",
						Execution.CommandKey.make("start"),
						{
							chat: view.chat.id,
							identity,
							content: Prompt.make("go"),
							queue: false,
						},
					)
					const key = { namespace: "turn-cluster", id: receipt.executionId }
					const observed = yield* observation
						.observe(key, 0)
						.pipe(Stream.runCollect, Effect.forkScoped)
					const first = yield* spawn(1)
					const second = yield* spawn(2)
					const markers = yield* sql<{
						readonly runner: number
					}>`select runner from execution_test_steps
			where execution_id = ${key.id} and step = 'checkpoint'`.pipe(
						Effect.repeat({
							schedule: Schedule.spaced("50 millis"),
							until: (rows) => rows.length > 0,
						}),
						Effect.timeout("25 seconds"),
					)
					assert.equal((yield* store.calls(key)).length, 1)
					assert.equal((yield* store.calls(key))[0]?.status, "completed")
					const owner = markers[0]?.runner === 1 ? first : second
					yield* owner.kill({ killSignal: "SIGKILL" })
					const ended = yield* store.load(key).pipe(
						Effect.repeat({
							schedule: Schedule.spaced("100 millis"),
							until: (value) => Execution.isTerminal(value.record.status),
						}),
						Effect.timeout("30 seconds"),
					)
					assert.equal(ended.record.status, "completed")
					assert.isAtLeast(ended.generation, 2)
					assert.equal(
						(yield* chats.read(view.chat.id)).chat.turn?.status._tag,
						"Completed",
					)
					const [model] = yield* sql<{
						readonly count: number
					}>`select count from execution_test_steps where execution_id = 'turn-cluster' and step = 'model'`
					assert.equal(model?.count, 1)
					const events = yield* Fiber.join(observed)
					assert.equal(
						Arr.filter(events, (event) => event.body._tag === "Text").length,
						1,
					)
					assert.equal(
						Arr.filter(events, (event) => event.body._tag === "StepCompleted")
							.length,
						1,
					)
					const last = events.at(-1)
					assert.isDefined(last)
					assert.equal(last?.sequence, ended.record.sequence)
					assert.deepStrictEqual(
						yield* observation.observe(key, 0).pipe(Stream.runCollect),
						events,
					)
				})
				yield* run.pipe(
					Effect.provide(
						InputCommands.layer.pipe(
							Layer.provide(Layer.mock(Delegations, {})),
							Layer.provideMerge(Observation.layer),
							Layer.provideMerge(Layer.merge(Store.layer, ErrorRecords.layer)),
							Layer.provide(
								Layer.mock(TurnAccess, {
									admit: () => Effect.void,
									input: () => Effect.void,
									notice: () => Effect.succeed(true),
								}),
							),
							Layer.provide(
								Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
							),
							Layer.provideMerge(
								PgClient.layer({
									url: Redacted.make(database.url),
								}),
							),
						),
					),
				)
			}),
		{ timeout: 90_000 },
	)
})
