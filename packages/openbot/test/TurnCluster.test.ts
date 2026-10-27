import { Delegations } from "../src/bots/Delegations.ts"
import { NodeServices } from "@effect/platform-node"
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
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Store from "../src/execution/Store.ts"
import * as ErrorRecords from "../src/errors/Records.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as InputCommands from "../src/chats/InputCommands.ts"
import { TurnAccess } from "../src/chats/TurnAccess.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import * as BotFixture from "./BotFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	it.effect(
		"another process completes a Turn from its saved model result",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
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
					yield* DatabasePostgres.migrate
					const sql = yield* PgClient.PgClient
					yield* sql`create table execution_test_steps (
				execution_id text not null, step text not null, count integer not null, runner integer not null,
				primary key (execution_id, step))`
					const db = yield* Db.make
					const store = yield* Store.Store
					const inputs = yield* InputCommands.InputCommands
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
								DatabasePostgres.layer({
									databaseUrl: Redacted.make(database.url),
								}),
							),
						),
					),
				)
			}),
		{ timeout: 90_000 },
	)
})
