import { Delegations } from "../src/conversation-contract/bots/Delegations.ts"
import * as WorkflowsFixture from "./WorkflowsFixture.ts"
import { Bots } from "../src/conversation-contract/bots/Bots.ts"
import { LiveConnections } from "../src/plugin-chats/live/LiveConnections.ts"
import { ReviewTools } from "../src/conversation-contract/capabilities/ReviewTools.ts"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	ChatStore,
	Config,
	Model,
	Provider,
	ChatStoreRepository,
	TurnRunner,
	Item,
	Store as CoreStore,
	Turn,
	TurnState,
} from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Deferred,
	Fiber,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import * as Db from "@openbot-build/server-database/Database"
import * as DatabasePostgres from "../src/app/DatabasePostgres.ts"
import * as Secrets from "../src/server-kernel/secrets/Secrets.ts"
import * as Store from "../src/server-execution/execution/Store.ts"
import * as StoredChats from "../src/conversation-contract/chats/StoredChats.ts"
import * as TurnPersistence from "../src/plugin-chats/TurnPersistence.ts"
import {
	chatHostId,
	chatHostStore,
} from "../src/conversation-contract/chats/ChatHost.ts"
import * as BotFixture from "./BotFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as Calls from "../src/server-execution/execution/Calls.ts"
import * as Records from "../src/server-kernel/errors/Records.ts"
import * as ToolSteps from "../src/plugin-chats/ToolSteps.ts"
import * as ModelSteps from "../src/plugin-chats/ModelSteps.ts"
import { Billing } from "../src/server-billing/billing/Billing.ts"
import { WorkflowEngine } from "effect/workflow"
import * as Engine from "../src/server-execution/execution/Engine.ts"
import * as Workflows from "../src/server-execution/execution/Workflows.ts"
import * as EngineHost from "../src/server-execution/execution/EngineHost.ts"
import * as Runner from "../src/server-execution/execution/Runner.ts"
import * as RunScope from "../src/server-execution/execution/RunScope.ts"
import * as TurnWorkflow from "../src/plugin-chats/TurnWorkflow.ts"
import * as TurnSession from "../src/plugin-chats/TurnSession.ts"
import * as TurnTools from "../src/plugin-chats/TurnTools.ts"
import * as ToolControls from "../src/plugin-chats/ToolControls.ts"
import * as ToolCommands from "../src/plugin-chats/ToolCommands.ts"
import * as InputCommands from "../src/plugin-chats/InputCommands.ts"
import * as ExecutionFeatures from "../src/plugin-chats/ExecutionFeatures.ts"
import * as BotFeatures from "../src/conversation-contract/chats/BotFeatures.ts"
import * as HostTools from "../src/tools-contract/chats/HostTools.ts"
import * as Observation from "../src/server-execution/execution/Observation.ts"
import { TurnAccess } from "../src/conversation-contract/chats/TurnAccess.ts"
import { ModelRegistry } from "../src/models-contract/models/ModelRegistry.ts"
import { Gates } from "../src/conversation-contract/capabilities/Gate.ts"
import { Files } from "../src/apps-contract/files/Files.ts"
import { Settings } from "../src/server-kernel/settings/Settings.ts"
import { TurnContext } from "../src/conversation-contract/chats/TurnContext.ts"

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const selection = Config.Selection.make({
	provider: Provider.Id.make("provider"),
	model: Model.Id.make("model"),
})
const services = ToolSteps.layer.pipe(
	Layer.provideMerge(
		Layer.mock(TurnAccess, {
			admit: () => Effect.void,
			model: () => Effect.void,
		}),
	),
	Layer.provideMerge(Calls.layer),
	Layer.provideMerge(Layer.mergeAll(Store.layer, Records.layer)),
	Layer.provideMerge(
		Layer.mock(Billing, {
			releaseExecution: () => Effect.succeed(true),
			record: () => Effect.void,
			unknown: () => Effect.void,
		}),
	),
	Layer.provide(
		WorkflowsFixture.layerStub({
			get: () =>
				Effect.succeedSome({
					authorize: () => Effect.void,
				}),
		}),
	),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
)

const setup = (namespace: string) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const executions = yield* Store.Store
		const calls = yield* Calls.Calls
		const definition = yield* CoreStore.define({
			stores: { [chatHostId]: chatHostStore },
			schemaVersion: "chat/1",
		})
		const persistence = StoredChats.persistence(db, namespace)
		const chats = yield* ChatStoreRepository.make({ definition, persistence })
		const { chain, kind, bot } = BotFixture.direct()
		const initial = yield* chats.create({
			business: { [chatHostId]: { chain, kind, bot: bot.id } },
		})
		const chat = initial.chat.id
		const turn = Turn.Id.make(namespace + "-turn")
		const entry = {
			id: Item.Id.make("input"),
			kind: "message" as const,
			content: Prompt.make("go"),
		}
		yield* chats.modifyEffect({
			chat,
			update: (view) =>
				TurnState.start(view, {
					turn,
					selected: [entry],
					items: [
						{
							id: entry.id,
							content: entry.content,
							origin: { chat, turn, step: 0 },
						},
					],
					startedAt: 0,
				}).pipe(
					Effect.map((mutation) => [undefined, Option.some(mutation)] as const),
				),
		})
		const receipt = yield* executions.submit(
			namespace,
			Execution.CommandKey.make("start"),
			{
				workflow: "openbot.chat-turn",
				resource: { kind: "Turn", id: turn },
				identity: {
					owner: { organizationId: chain.organizationId, userId: chain.userId },
					actor: {
						kind: "member",
						organizationId: chain.organizationId,
						userId: chain.userId,
					},
				},
				input: { chat },
			},
		)
		const key = { namespace, id: receipt.executionId }
		const owner = (fence: Store.Fence) =>
			ChatStoreRepository.make({
				definition,
				persistence: TurnPersistence.make(db, executions, calls, {
					fence,
					chat,
					turn,
				}),
			})
		const change = (store: typeof chats) =>
			store.modifyEffect({
				chat,
				update: (view) =>
					Effect.succeed([
						undefined,
						Option.some({ chat: { inbox: view.chat.inbox } }),
					] as const),
			})
		return {
			chats,
			executions,
			key,
			owner,
			change,
			chat,
			turn,
			definition,
			db,
			accepted: {
				view: yield* chats.read(chat),
				turn,
				item: entry.id,
				prompt: entry.content,
			},
		}
	})

/** Gives the Turn a model, so it does not read the Bot. */
const useModel = (test: Effect.Success<ReturnType<typeof setup>>) =>
	test.chats.modifyEffect({
		chat: test.chat,
		update: (view) =>
			Effect.succeed([
				undefined,
				Option.some({
					chat: {
						turn: {
							...view.chat.turn!,
							settings: {
								...view.chat.settings,
								model: Config.Selection.make({
									provider: Provider.Id.make("test"),
									model: Model.Id.make("test"),
								}),
							},
						},
					},
				}),
			] as const),
	})

/** A model that gives one short answer. */
const answer = LanguageModel.make({
	generateText: () => Effect.die("This test uses a stream."),
	streamText: () =>
		Stream.make(
			Response.makePart("text-start", { id: "text" }),
			Response.makePart("text-delta", { id: "text", delta: "answer" }),
			Response.makePart("text-end", { id: "text" }),
			Response.makePart("finish", {
				reason: "stop",
				usage: {
					inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
			}),
		),
})

/** The Turn workflow with the memory engine, a fixed model, and the given features. */
const turnLayer = (options: {
	readonly store: typeof Store.Store.Service
	readonly model: typeof LanguageModel.LanguageModel.Service
	readonly features?: Layer.Layer<
		ExecutionFeatures.ExecutionFeatures | BotFeatures.BotFeatures,
		never,
		Records.Records
	>
}) =>
	EngineHost.layerHandlers.pipe(
		Layer.provideMerge(TurnWorkflow.layer),
		Layer.provideMerge(
			Layer.mergeAll(
				TurnSession.layer.pipe(Layer.provide(Layer.mock(LiveConnections, {}))),
				Runner.layer,
				RunScope.layer,
				Workflows.layer,
			),
		),
		Layer.provide(Layer.mergeAll(TurnTools.layer, ToolControls.layer)),
		Layer.provide(
			Layer.mergeAll(
				ToolCommands.layer,
				InputCommands.layer.pipe(Layer.provide(Layer.mock(Delegations, {}))),
				Observation.layer,
			),
		),
		Layer.provide(Layer.succeed(Store.Store, options.store)),
		Layer.provideMerge(WorkflowEngine.layerMemory),
		Layer.provide(
			Layer.mergeAll(
				options.features ??
					Layer.merge(ExecutionFeatures.none, BotFeatures.layer),
				Layer.mock(ReviewTools, {
					register: () => Effect.die("This test has no review Chat."),
				}),
				HostTools.none,
				Layer.mock(Bots, {}),
				Layer.mock(TurnAccess, {
					admit: () => Effect.void,
					model: () => Effect.void,
					authorize: () => Effect.void,
					input: () => Effect.void,
					notice: () => Effect.succeed(true),
				}),
				Layer.mock(ModelRegistry, {
					defaultModel: Option.none(),
					catalog: () => Effect.succeed({ providers: [], models: [] }),
					resolve: () => Effect.succeed(options.model),
				}),
			),
		),
	)

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	for (const mode of ["complete", "checkpoint", "cancel"] as const)
		it.effect(`a Turn workflow closes its scope after ${mode}`, () =>
			Effect.gen(function* () {
				const failCheckpoint = mode === "checkpoint"
				const test = yield* setup(`turn-session-${mode}`)
				const started = yield* Deferred.make<void>()
				const released = yield* Ref.make(false)
				const sent = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("This test uses a stream."),
					streamText: () =>
						Stream.fromEffect(Ref.update(sent, (n) => n + 1)).pipe(
							Stream.flatMap(() =>
								mode === "cancel"
									? Stream.fromEffect(
											Deferred.succeed(started, undefined).pipe(
												Effect.andThen(Effect.never),
											),
										).pipe(Stream.ensuring(Ref.set(released, true)))
									: Stream.make(
											Response.makePart("text-start", { id: "text" }),
											Response.makePart("text-delta", {
												id: "text",
												delta: "saved answer",
											}),
											Response.makePart("text-end", { id: "text" }),
											Response.makePart("finish", {
												reason: "stop",
												usage: {
													inputTokens: {
														total: 1,
														uncached: 1,
														cacheRead: 0,
														cacheWrite: 0,
													},
													outputTokens: { total: 1, text: 1, reasoning: 0 },
												},
											}),
										),
							),
						),
				})
				yield* test.chats.modifyEffect({
					chat: test.chat,
					update: (view) =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: {
									turn: {
										...view.chat.turn!,
										settings: {
											...view.chat.settings,
											model: Config.Selection.make({
												provider: Provider.Id.make("test"),
												model: Model.Id.make("test"),
											}),
										},
									},
								},
							}),
						] as const),
				})
				const failed = yield* Ref.make(false)
				const flaky = Store.Store.of({
					...test.executions,
					commit: (fence, change, writes) =>
						Effect.gen(function* () {
							if (
								failCheckpoint &&
								typeof change.events !== "function" &&
								Arr.some(
									change.events ?? [],
									(event) => event._tag === "Checkpoint",
								) &&
								Arr.some(
									yield* test.executions.calls(fence),
									(call) => call.status === "completed",
								) &&
								!(yield* Ref.getAndSet(failed, true))
							)
								return yield* Execution.StorageError.make({
									cause: "The checkpoint write failed once.",
								})
							return yield* test.executions.commit(fence, change, writes)
						}),
				})
				const application = turnLayer({ store: flaky, model })
				yield* Effect.gen(function* () {
					if (mode === "cancel") {
						const running = yield* TurnWorkflow.workflow
							.execute(test.key)
							.pipe(Effect.forkScoped)
						yield* Deferred.await(started)
						const before = yield* test.executions.loadMember(test.key)
						yield* test.executions.cancel(
							test.key,
							Execution.CommandKey.make("cancel"),
							before.identity.actor,
						)
						yield* Engine.transport(TurnWorkflow.workflow).cancel(
							test.key,
							(yield* test.executions.loadMember(test.key)).cancelEpoch,
						)
						yield* Fiber.join(running)
						assert.isTrue(yield* Ref.get(released))
					} else yield* TurnWorkflow.workflow.execute(test.key)
					assert.equal(
						(yield* test.chats.read(test.chat)).chat.turn?.status._tag,
						mode === "cancel" ? "Interrupted" : "Completed",
					)
					yield* TurnWorkflow.workflow.execute(test.key)
					assert.equal(yield* Ref.get(sent), 1)
					assert.equal(yield* Ref.get(failed), failCheckpoint)
					assert.equal(
						(yield* test.executions.get(test.key)).status,
						mode === "cancel" ? "cancelled" : "completed",
					)
					const calls = yield* test.executions.calls(test.key)
					assert.equal(calls.length, 1)
					assert.equal(
						calls[0]?.status,
						mode === "cancel" ? "outcome_unknown" : "completed",
					)
				}).pipe(Effect.provide(application))
			}),
		)

	it.effect(
		"the first phase saves the bot features of the Turn, and a replay reads them back",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-features-pin")
				yield* useModel(test)
				const snapshots = yield* Ref.make(0)
				const opened = yield* Ref.make<
					ReadonlyArray<ReadonlyArray<BotFeatures.Pin>>
				>([])
				const failed = yield* Ref.make(false)
				// The checkpoint write fails once, so the work of the Turn runs again.
				const flaky = Store.Store.of({
					...test.executions,
					commit: (fence, change, writes) =>
						Effect.gen(function* () {
							if (
								typeof change.events !== "function" &&
								Arr.some(
									change.events ?? [],
									(event) => event._tag === "Checkpoint",
								) &&
								!(yield* Ref.getAndSet(failed, true))
							)
								return yield* Execution.StorageError.make({
									cause: "The checkpoint write failed once.",
								})
							return yield* test.executions.commit(fence, change, writes)
						}),
				})
				// Each snapshot has a new version, so a second snapshot would show.
				const features = Layer.mock(BotFeatures.BotFeatures, {
					snapshot: Effect.map(
						Ref.updateAndGet(snapshots, (count) => count + 1),
						(version) => [{ id: "tools", version, settings: null }],
					),
				})
				const execution = Layer.effect(
					ExecutionFeatures.ExecutionFeatures,
					Effect.map(ExecutionFeatures.ExecutionFeatures, (base) =>
						ExecutionFeatures.ExecutionFeatures.of({
							...base,
							open: (fence, frame, pins) =>
								Effect.andThen(
									Ref.update(opened, Arr.append(pins)),
									base.open(fence, frame, pins),
								),
						}),
					),
				).pipe(Layer.provide(ExecutionFeatures.none))
				yield* TurnWorkflow.workflow.execute(test.key).pipe(
					Effect.provide(
						turnLayer({
							store: flaky,
							model: yield* answer,
							features: Layer.merge(execution, features),
						}),
					),
				)
				assert.isTrue(yield* Ref.get(failed))
				assert.equal(yield* Ref.get(snapshots), 1)
				const pins = yield* Ref.get(opened)
				assert.isAtLeast(pins.length, 2)
				assert.ok(
					Arr.every(
						pins,
						(pinned) =>
							Schema.is(Schema.Array(BotFeatures.Pin))(pinned) &&
							pinned.length === 1 &&
							pinned[0]?.version === 1,
					),
				)
				assert.equal((yield* test.executions.get(test.key)).status, "completed")
			}),
	)

	it.effect(
		"a Turn fails with a conflict when a pinned bot feature has a new version",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-features-version")
				yield* useModel(test)
				const sent = yield* Ref.make(0)
				// The journal kept version 1, and the server now has version 2.
				const features = Layer.effect(
					BotFeatures.BotFeatures,
					Effect.gen(function* () {
						const present = yield* BotFeatures.make({ drain: "0 millis" })
						yield* present
							.contribute({
								id: "tools",
								version: 2,
								order: 10,
								build: "normal",
								review: true,
								restores: [],
								settings: Effect.succeed(null),
								prepare: () =>
									Effect.die("A feature with a new version must not be built."),
							})
							.pipe(Effect.orDie)
						return BotFeatures.BotFeatures.of({
							...present,
							snapshot: Effect.succeed([
								{ id: "tools", version: 1, settings: null },
							]),
						})
					}),
				)
				const execution = ExecutionFeatures.layer.pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.mock(Gates, {
								durable: () =>
									Effect.die("A Turn with a conflict must not build a Gate."),
							}),
							Layer.mock(Files, {}),
							Layer.mock(Settings, {}),
							Layer.mock(TurnContext, {}),
						),
					),
					Layer.provideMerge(features),
				)
				yield* TurnWorkflow.workflow.execute(test.key).pipe(
					Effect.exit,
					Effect.provide(
						turnLayer({
							store: test.executions,
							model: yield* LanguageModel.make({
								generateText: () => Effect.die("This test uses a stream."),
								streamText: () =>
									Stream.fromEffect(
										Ref.update(sent, (count) => count + 1),
									).pipe(
										Stream.flatMap(() => Stream.die("The model must not run.")),
									),
							}),
							features: execution,
						}),
					),
				)
				assert.equal(yield* Ref.get(sent), 0)
				const record = yield* test.executions.get(test.key)
				assert.equal(record.status, "failed")
				assert.equal(
					(yield* test.chats.read(test.chat)).chat.turn?.status._tag,
					"Failed",
				)
			}),
	)

	it.effect(
		"a Turn owner cannot write after takeover even with the latest Chat revision",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-fence")
				const old = yield* test.owner(yield* test.executions.takeOver(test.key))
				const first = yield* test.change(old)
				const current = yield* test.owner(
					yield* test.executions.takeOver(test.key),
				)
				const next = yield* test.change(current)
				assert.equal(next.view.chat.revision, first.view.chat.revision + 1)
				const error = yield* test.change(old).pipe(Effect.flip)
				assert.ok(Schema.is(ChatStore.ChatStoreError)(error))
				assert.ok(
					"cause" in error && Schema.is(Execution.Conflict)(error.cause),
				)
				assert.equal(
					(yield* test.chats.read(test.chat)).chat.revision,
					next.view.chat.revision,
				)
				const events = yield* test.executions.events(test.key, 0)
				assert.deepStrictEqual(
					Arr.map(Arr.takeRight(events, 2), (event) => event.body),
					[
						{
							_tag: "Checkpoint",
							resource: { kind: "Chat", id: test.chat },
							revision: first.view.chat.revision,
						},
						{
							_tag: "Checkpoint",
							resource: { kind: "Chat", id: test.chat },
							revision: next.view.chat.revision,
						},
					],
				)
			}),
	)
	it.effect(
		"a saved model result survives a failed Chat checkpoint and a new owner",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-model-replay")
				const sent = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("This test uses a stream."),
					streamText: () =>
						Stream.fromEffect(Ref.update(sent, (n) => n + 1)).pipe(
							Stream.flatMap(() =>
								Stream.make(
									Response.makePart("text-start", { id: "text" }),
									Response.makePart("text-delta", {
										id: "text",
										delta: "saved answer",
									}),
									Response.makePart("text-end", { id: "text" }),
									Response.makePart("finish", {
										reason: "stop",
										usage: {
											inputTokens: {
												total: 1,
												uncached: 1,
												cacheRead: 0,
												cacheWrite: 0,
											},
											outputTokens: { total: 1, text: 1, reasoning: 0 },
										},
									}),
								),
							),
						),
				})
				yield* Effect.gen(function* () {
					const steps = yield* ModelSteps.ModelSteps
					const first = yield* test.executions.takeOver(test.key)
					const persistence = TurnPersistence.make(
						test.db,
						test.executions,
						yield* Calls.Calls,
						{
							fence: first,
							chat: test.chat,
							turn: test.turn,
						},
					)
					const hasModel = Schema.is(
						Schema.Struct({
							turn: Schema.Struct({
								pendingStep: Schema.Struct({ model: Schema.Unknown }),
							}),
						}),
					)
					const store = yield* ChatStoreRepository.make({
						definition: test.definition,
						persistence: {
							...persistence,
							save: (delta) =>
								hasModel(delta.ref)
									? Effect.fail(
											ChatStore.ChatStoreError.make({
												reason: "storage-failed",
												message: "The model checkpoint could not be saved.",
											}),
										)
									: persistence.save(delta),
						},
					})
					const runner = yield* TurnRunner.make({
						store,
						bot: {},
						executeModel: steps.executor(first, selection),
					})
					const error = yield* runner
						.run(test.accepted)
						.pipe(Stream.runDrain, Effect.flip)
					assert.ok(Schema.is(ChatStore.ChatStoreError)(error))
					assert.equal(
						(yield* test.chats.read(test.chat)).chat.turn?.pendingStep?.model,
						undefined,
					)
					assert.equal(
						(yield* test.executions.calls(test.key))[0]?.status,
						"completed",
					)
					const second = yield* test.executions.takeOver(test.key)
					const resumed = yield* TurnRunner.make({
						store: yield* test.owner(second),
						bot: {},
						executeModel: steps.executor(second, selection),
					})
					yield* resumed
						.run({ ...test.accepted, view: yield* test.chats.read(test.chat) })
						.pipe(Stream.runDrain)
					assert.equal(
						(yield* test.chats.read(test.chat)).chat.turn?.status._tag,
						"Completed",
					)
					assert.equal(yield* Ref.get(sent), 1)
					assert.equal((yield* test.executions.calls(test.key)).length, 1)
				}).pipe(
					Effect.provide(
						ModelSteps.layer.pipe(
							Layer.provideMerge(
								Layer.succeed(LanguageModel.LanguageModel, model),
							),
						),
					),
				)
			}),
	)

	it.effect(
		"a saved tool result survives a failed Chat checkpoint without a second write",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-tool-replay")
				const writes = yield* Ref.make(0)
				const modelCalls = yield* Ref.make(0)
				const tool = Tool.make("WriteNote", {
					parameters: Schema.Struct({}),
					success: Schema.String,
				})
				const toolkit = Toolkit.make(tool)
				const usage = {
					inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				}
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("This test uses a stream."),
					streamText: ({ prompt }) =>
						Stream.fromEffect(
							Effect.gen(function* () {
								const outputs = Arr.flatMap(prompt.content, (message) =>
									message.role === "tool" ? message.content : [],
								)
								for (const output of outputs)
									if (output.type === "tool-result") {
										assert.isFalse(output.isFailure)
										assert.equal(output.result, "saved note")
									}
								yield* Ref.update(modelCalls, (n) => n + 1)
							}),
						).pipe(
							Stream.flatMap(() =>
								Arr.some(prompt.content, (message) => message.role === "tool")
									? Stream.make(
											Response.makePart("finish", { reason: "stop", usage }),
										)
									: Stream.make(
											Response.makePart("tool-call", {
												id: "write-call",
												name: "WriteNote",
												params: {},
												providerExecuted: false,
											}),
											Response.makePart("finish", {
												reason: "tool-calls",
												usage,
											}),
										),
							),
						),
				})
				const handlers = toolkit.toLayer({
					WriteNote: () =>
						Ref.update(writes, (n) => n + 1).pipe(Effect.as("saved note")),
				})
				yield* Effect.gen(function* () {
					const models = yield* ModelSteps.ModelSteps
					const tools = yield* ToolSteps.ToolSteps
					const first = yield* test.executions.takeOver(test.key)
					const persistence = TurnPersistence.make(
						test.db,
						test.executions,
						yield* Calls.Calls,
						{
							fence: first,
							chat: test.chat,
							turn: test.turn,
						},
					)
					const hasToolResult = Schema.is(
						Schema.Struct({
							turn: Schema.Struct({
								pendingStep: Schema.Struct({
									after: Schema.Struct({
										content: Schema.NonEmptyArray(Schema.Unknown),
									}),
								}),
							}),
						}),
					)
					const store = yield* ChatStoreRepository.make({
						definition: test.definition,
						persistence: {
							...persistence,
							save: (delta) =>
								hasToolResult(delta.ref)
									? Effect.fail(
											ChatStore.ChatStoreError.make({
												reason: "storage-failed",
												message: "The tool checkpoint could not be saved.",
											}),
										)
									: persistence.save(delta),
						},
					})
					const runner = yield* TurnRunner.make({
						store,
						bot: { toolkit },
						executeModel: models.executor(first, selection),
						executeTool: tools.executor(first),
					})
					const error = yield* runner
						.run(test.accepted)
						.pipe(Stream.runDrain, Effect.flip)
					assert.ok(Schema.is(ChatStore.ChatStoreError)(error))
					assert.equal(yield* Ref.get(writes), 1)
					assert.isDefined(
						(yield* test.chats.read(test.chat)).chat.turn?.pendingStep?.model,
					)
					const outputs = Arr.filter(
						yield* test.executions.events(test.key, 0),
						(event) => event.body._tag === "ToolOutput",
					)
					assert.equal(outputs.length, 1)
					const second = yield* test.executions.takeOver(test.key)
					const resumed = yield* TurnRunner.make({
						store: yield* test.owner(second),
						bot: {},
						executeModel: models.executor(second, selection),
						executeTool: tools.executor(second),
					})
					yield* resumed
						.run({ ...test.accepted, view: yield* test.chats.read(test.chat) })
						.pipe(Stream.runDrain)
					assert.equal(yield* Ref.get(writes), 1)
					assert.equal(yield* Ref.get(modelCalls), 2)
					assert.equal(
						(yield* test.chats.read(test.chat)).chat.turn?.status._tag,
						"Completed",
					)
					assert.equal(
						Arr.filter(
							yield* test.executions.events(test.key, 0),
							(event) => event.body._tag === "ToolOutput",
						).length,
						1,
					)
				}).pipe(
					Effect.provide(
						Layer.merge(
							handlers,
							ModelSteps.layer.pipe(
								Layer.provideMerge(
									Layer.succeed(LanguageModel.LanguageModel, model),
								),
							),
						),
					),
				)
			}),
	)

	it.effect("a failed event write rolls back the Chat checkpoint", () =>
		Effect.gen(function* () {
			const test = yield* setup("turn-rollback")
			const current = yield* test.owner(
				yield* test.executions.takeOver(test.key),
			)
			const before = yield* test.chats.read(test.chat)
			const sequence = (yield* test.executions.get(test.key)).sequence
			const sql = yield* PgClient.PgClient
			yield* sql`create function fail_turn_event() returns trigger language plpgsql as $$ begin if NEW.namespace = 'turn-rollback' then raise exception 'event write failed'; end if; return NEW; end; $$`
			yield* sql`create trigger fail_turn_event before insert on openbot_execution_events for each row execute function fail_turn_event()`
			yield* test.change(current).pipe(Effect.flip)
			assert.equal(
				(yield* test.chats.read(test.chat)).chat.revision,
				before.chat.revision,
			)
			assert.equal((yield* test.executions.get(test.key)).sequence, sequence)
			yield* sql`drop trigger fail_turn_event on openbot_execution_events`
			yield* sql`drop function fail_turn_event()`
			const committed = yield* test.change(current)
			assert.equal(committed.view.chat.revision, before.chat.revision + 1)
		}),
	)
})
