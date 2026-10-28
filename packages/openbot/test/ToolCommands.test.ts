import * as TaskMessages from "../src/chats/TaskMessages.ts"
import * as DelegationTools from "../src/bots/WorkflowTools.ts"
import * as DelegationWorkflow from "../src/bots/DelegationWorkflow.ts"
import { eq } from "drizzle-orm"
import { SqlClient, SqlError } from "effect/sql"
import { delegationPeriods } from "../src/database/ExecutionSchema.ts"
import * as WorkAdmission from "../src/chats/WorkAdmission.ts"
import * as Admission from "../src/execution/Admission.ts"
import * as PolicyOrigin from "../src/capabilities/PolicyOrigin.ts"
import * as DelegationSessionModule from "../src/bots/DelegationSession.ts"
import * as RequestCommandsModule from "../src/capabilities/RequestCommands.ts"
import * as RequestsModule from "../src/capabilities/Requests.ts"
import * as GrantsModule from "../src/capabilities/Grants.ts"
import * as RulesModule from "../src/capabilities/Rules.ts"
import * as AuditModule from "../src/audit/AuditLogPostgres.ts"
import * as DelegationNotices from "../src/bots/DelegationNotices.ts"
import * as DelegationCommands from "../src/bots/DelegationCommands.ts"
import * as DelegationsModule from "../src/bots/Delegations.ts"
import * as BotRecordsModule from "../src/bots/BotRecords.ts"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import { ChatModelInvalid } from "@openbot-build/domain"
import { Cause } from "effect"
import { Config } from "@openbot-build/core"
import * as ToolDefinitions from "../src/chats/ToolDefinitions.ts"
import { Vaults as VaultDomain } from "@openbot-build/domain"
import * as WorkflowTools from "../src/apps/WorkflowTools.ts"
import { InputState } from "../src/plugins/ToolEntry.ts"
import { names as codeNames } from "../src/code/ToolSchema.ts"
import * as ToolResults from "../src/chats/ToolResults.ts"
import * as CodeCommands from "../src/code/CodeCommands.ts"
import * as CodeProgram from "../src/code/CodeProgram.ts"
import * as CodeWorkflow from "../src/code/CodeWorkflow.ts"
import * as SandboxModule from "../src/code/Sandbox.ts"
import { Settings as SettingsService } from "../src/settings/Settings.ts"
import { organizationDefaults } from "../src/settings/Documents.ts"
import { Settings as SettingsApi } from "@openbot-build/api"
import { Vaults } from "../src/vaults/Vaults.ts"
import * as AppSessionModule from "../src/apps/AppSession.ts"
import { ConnectionSessions } from "../src/apps/ConnectionSessions.ts"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Authorization } from "@openbot-build/domain"
import * as StoredConnections from "../src/apps/StoredConnections.ts"
import { appConnections, usageEvents } from "../src/database/Schema.ts"
import { Store as ProtocolStore } from "@openbot-build/protocol"
import { Grants } from "../src/capabilities/Grants.ts"
import { Rules } from "../src/capabilities/Rules.ts"
import {
	RequestCommands,
	workflowName as requestWorkflowName,
} from "../src/capabilities/RequestCommands.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"
import * as AppWorkflow from "../src/apps/AppWorkflow.ts"
import { AppSession } from "../src/apps/AppSession.ts"
import { Client } from "@openbot-build/protocol"
import * as AppCommands from "../src/apps/AppCommands.ts"
import * as AppCall from "../src/apps/AppCall.ts"
import { ActionPolicy } from "../src/apps/ActionPolicy.ts"
import { AppCalls, ConnectionId } from "@openbot-build/domain"
import { Billing } from "../src/billing/Billing.ts"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	Bot,
	Chat,
	ChatState,
	ToolStep,
	ChatStoreRepository,
	Store as CoreStore,
	Item,
	Operation,
	Turn,
	TurnState,
} from "@openbot-build/core"
import {
	Execution,
	TokenId,
	executionCallers,
	Bots as BotDomain,
	type Caller,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Effect,
	Deferred,
	Fiber,
	Schema,
	Context,
	Ref,
	Record as Rec,
	Struct,
	Stream,
	Layer,
	Option,
	Redacted,
	String as Str,
} from "effect"
import { Prompt, Response, Tool, Toolkit } from "effect/ai"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Store from "../src/execution/Store.ts"
import { Calls } from "../src/execution/Calls.ts"
import { TurnAccess } from "../src/chats/TurnAccess.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as BotFixture from "./BotFixture.ts"
import * as Db from "../src/database/Database.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import * as CallFrame from "../src/chats/CallFrame.ts"
import * as ToolOrigins from "../src/chats/ToolOrigins.ts"
import * as ToolCommands from "../src/chats/ToolCommands.ts"
import * as CallsModule from "../src/execution/Calls.ts"
import { Registry } from "../src/execution/Engine.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as Runner from "../src/execution/Runner.ts"
import * as RunScope from "../src/execution/RunScope.ts"
import * as ToolWorkflow from "../src/chats/ToolWorkflow.ts"
import { WorkflowEngine } from "effect/workflow"
import { TestClock } from "effect/testing"
import * as Records from "../src/errors/Records.ts"
import * as ToolSession from "../src/chats/ToolSession.ts"
import * as TurnTools from "../src/chats/TurnTools.ts"
import { CallContext } from "../src/execution/CallContext.ts"
import * as ToolControls from "../src/chats/ToolControls.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as ToolSteps from "../src/chats/ToolSteps.ts"
import * as HostTools from "../src/chats/HostTools.ts"
import { ExecutionFeatures } from "../src/chats/ExecutionFeatures.ts"
import * as TurnContext from "../src/chats/TurnContext.ts"
import { InputCommands } from "../src/chats/InputCommands.ts"
import * as InputCommandsModule from "../src/chats/InputCommands.ts"
import * as ToolNotices from "../src/chats/ToolNotices.ts"
import * as ToolNoticeWorkflow from "../src/chats/ToolNoticeWorkflow.ts"
import { Bots } from "../src/bots/Bots.ts"
import { layerEveryoneAdministrator } from "./OrganizationFixture.ts"
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
class StartFailure extends Context.Service<
	StartFailure,
	Ref.Ref<"none" | "input" | "bot" | "model" | "storage">
>()("@openbot-build/openbot/test/ToolCommands.test/StartFailure") {}
class Advance extends Context.Service<Advance, Ref.Ref<boolean>>()(
	"@openbot-build/openbot/test/ToolCommands.test/Advance",
) {}
const policy = Layer.effect(Advance, Ref.make(true))
const calls = Layer.effect(
	Calls,
	Effect.gen(function* () {
		const allowed = yield* Advance
		return Calls.of({
			admission: () => Effect.void,
			stopOnPause: (work) => work,
			reserve: () => Effect.die("This test does not reserve model usage."),
			ready: () => Effect.void,
			authorize: (_, mode) =>
				Effect.gen(function* () {
					if (mode === "advance" && !(yield* Ref.get(allowed)))
						return yield* Execution.Forbidden.make({})
				}),
			invoke: () => Effect.die("This test does not send tool calls."),
			recover: () => Effect.die("This test does not recover tool calls."),
		})
	}),
)
const services = ToolCommands.layer.pipe(
	Layer.provideMerge(calls),
	Layer.provide(
		Layer.mock(TurnAccess, {
			admit: () => Effect.void,
			authorize: (_, actor) =>
				actor.kind === "user_token"
					? Effect.void
					: Effect.fail(Execution.Forbidden.make({})),
		}),
	),
	Layer.provideMerge(Store.layer),
	Layer.provideMerge(
		DelegationsModule.layer.pipe(Layer.provide(BotRecordsModule.layer)),
	),
	Layer.provideMerge(Records.layer),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(policy),
	Layer.provideMerge(NodeServices.layer),
)
const settings = {
	budget: "0 millis",
	maxDuration: "1 hour",
	limit: 1,
} as const
const setup = Effect.fn(function* (
	namespace: string,
	actor: Caller = { kind: "member", organizationId: "org", userId: "speaker" },
	owner = "owner",
	botId?: BotDomain.BotId,
) {
	const store = yield* Store.Store
	const tools = yield* ToolCommands.ToolCommands
	const call = (id: string, secret: string = "private tool input") =>
		Prompt.makePart("tool-call", {
			id,
			name: "send",
			params: { secret },
			providerExecuted: false,
		})
	const db = yield* Db.make
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore },
		schemaVersion: "chat/1",
	})
	const chats = yield* ChatStoreRepository.make({
		definition,
		persistence: StoredChats.persistence(db, namespace),
	})
	const fixture = BotFixture.direct({
		organizationId: "org",
		userId: owner,
	})
	const bot = {
		...fixture.bot,
		id:
			botId ??
			(owner === "owner"
				? fixture.bot.id
				: BotDomain.BotId.make(`bot_${owner}`)),
	}
	const kind = fixture.kind
	const chain = { ...fixture.chain, bots: [bot.id] }
	const view = yield* chats.create({
		business: { [ChatHost.chatHostId]: { bot: bot.id, kind, chain } },
	})
	const position = {
		chat: view.chat.id,
		turn: Turn.Id.make(`${view.chat.id}-turn`),
		item: Item.Id.make(`${view.chat.id}-model-step`),
		step: 0,
	}
	const pending: Turn.PendingStep = {
		step: 0,
		item: position.item,
		input: Prompt.make([
			{
				role: "assistant",
				content: Arr.map(
					[
						"call",
						"one",
						"two",
						"foreground",
						"finished",
						"later",
						"private",
						"stale",
						"cancelled",
					],
					(id) => call(id),
				),
			},
		]),
		before: Prompt.empty,
		after: Prompt.empty,
	}
	yield* chats.modifyEffect({
		chat: position.chat,
		update: () =>
			Effect.succeed([
				undefined,
				Option.some({
					chat: {
						turn: {
							id: position.turn,
							chat: position.chat,
							settings: view.chat.settings,
							status: Turn.Status.Running(),
							steps: 0,
							input: [],
							items: [],
							startedAt: 0,
							pendingStep: pending,
						},
					},
				}),
			] as const),
	})
	const receipt = yield* store.submit(
		namespace,
		Execution.CommandKey.make(`parent:${position.chat}`),
		{
			workflow: "openbot.chat-turn",
			resource: { kind: "Turn", id: position.turn },
			identity: {
				botId: bot.id,
				owner: { organizationId: "org", userId: owner },
				actor,
			},
			input: { chat: position.chat },
		},
	)
	const key = { namespace, id: receipt.executionId }
	const parent = yield* store.takeOver(key)

	return {
		store,
		tools,
		chats,
		key,
		parent,
		position,
		pending,
		call,
		submit: (id: string) => tools.submit(parent, position, call(id), settings),
	}
})

const saveTaskSteps = Effect.fn(function* (
	key: Store.Key,
	count: number,
	callId?: Execution.CallId,
) {
	const store = yield* Store.Store
	const db = yield* Db.make
	const task = yield* store.loadMember(key)
	const input = yield* Schema.decodeUnknownEffect(
		Schema.Struct({ chat: Chat.Id }),
	)(task.input)
	for (let step = 0; step < count; step++) {
		yield* db
			.insert(usageEvents)
			.values({
				id:
					step === 0 && callId !== undefined
						? callId
						: `${key.id}:model:${step}`,
				executionId: key.id,
				status: "unknown",
				startedAt: step + 1,
				organizationId: task.identity.owner.organizationId,
				occurredAt: step + 1,
				source: "turn",
				chatId: input.chat,
				turnId: task.record.resource.id,
				providerId: "test",
				providerOwner: "organization",
				modelId: "test",
				inputUncached: 0,
				inputCacheRead: 0,
				inputCacheWrite: 0,
				outputText: 0,
				outputReasoning: 0,
				costMicros: 0,
				charged: false,
			})
			.onConflictDoNothing()
	}
})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	const delegationLayerWithSettings = (
		settings: Layer.Layer<SettingsService> = OrganizationFixture.layerDefaultSettings,
	) =>
		DelegationCommands.layer.pipe(
			Layer.provide(
				RequestsModule.layer.pipe(
					Layer.provide(Layer.merge(GrantsModule.layer, RulesModule.layer)),
					Layer.provide(BotRecordsModule.layer),
					Layer.provide(OrganizationFixture.layerDefaultSettings),
				),
			),
			Layer.provideMerge(
				Layer.effect(
					InputCommands,
					Effect.gen(function* () {
						const inputs = yield* InputCommands
						const failed = yield* StartFailure
						return InputCommands.of({
							...inputs,
							submit: (...args) =>
								Ref.get(failed).pipe(
									Effect.flatMap((fail) =>
										fail === "input"
											? Effect.fail(
													Execution.StorageError.make({
														cause: "The input write failed",
													}),
												)
											: inputs.submit(...args),
									),
								),
						})
					}),
				).pipe(Layer.provide(InputCommandsModule.layer)),
			),
			Layer.provideMerge(
				DelegationsModule.layer.pipe(Layer.provide(BotRecordsModule.layer)),
			),
			Layer.provide(settings),
			Layer.provide(
				Layer.mock(TurnAccess, {
					admit: () => Effect.void,
					authorize: () => Effect.void,
					input: () => Effect.void,
					command: () => Effect.void,
					notice: () => Effect.succeed(true),
				}),
			),
			Layer.provide(
				Layer.unwrap(
					Effect.gen(function* () {
						const failure = yield* StartFailure
						return Layer.mock(Bots, {
							find: (_, id) =>
								Effect.succeedSome({
									...BotFixture.bot,
									id: BotDomain.BotId.make(id),
								}),
							access: (_, id) =>
								Effect.gen(function* () {
									const fail = yield* Ref.get(failure)
									if (fail === "storage")
										return yield* BotDomain.BotStorageUnavailable.make({})
									if (fail === "bot")
										return yield* Authorizer.Forbidden.make({
											action: "delegate",
											kind: "Bot",
										})
									return { ...BotFixture.bot, id: BotDomain.BotId.make(id) }
								}),
						})
					}),
				),
			),
			Layer.provide(
				Layer.unwrap(
					Effect.gen(function* () {
						const failure = yield* StartFailure
						return Layer.mock(ModelRegistry, {
							defaultModel: Option.some(DevelopmentModel.selection),
							catalog: () =>
								Ref.get(failure).pipe(
									Effect.map((fail) => ({
										providers: [
											{
												id: DevelopmentModel.selection.provider,
												name: "Test",
											},
										],
										models:
											fail === "model"
												? []
												: [
														Config.Model.make({
															provider: DevelopmentModel.selection.provider,
															id: DevelopmentModel.selection.model,
															name: "Test",
															reasoningEfforts: [],
															serviceTiers: [],
														}),
													],
									})),
								),
						})
					}),
				),
			),
			Layer.provideMerge(
				Layer.effect(
					StartFailure,
					Ref.make<"none" | "input" | "bot" | "model" | "storage">("none"),
				),
			),
		)
	const delegationLayer = delegationLayerWithSettings()
	const delegationInput: DelegationCommands.Input = {
		bot: BotDomain.BotId.make("bot_child"),
		task: "Read the note",
		reason: "Help with the note",
		limits: { timeMs: 60000, steps: 3 },
	}
	it.effect(
		"a delegation keeps its saved time limit and waits for readable settings",
		() =>
			Effect.gen(function* () {
				const readable = yield* Ref.make(false)
				const timeLimit = yield* Ref.make(120000)
				const given = Layer.mock(SettingsService, {
					organization: () =>
						Effect.gen(function* () {
							if (!(yield* Ref.get(readable)))
								return yield* SettingsApi.SettingsUnavailable.make({})
							return {
								document: {
									...organizationDefaults,
									delegationTimeLimitMs: yield* Ref.get(timeLimit),
								},
								version: 1,
								updatedAt: 0,
							}
						}),
				})
				yield* Effect.gen(function* () {
					const test = yield* setup("delegation-default-limit")
					const commands = yield* DelegationCommands.DelegationCommands
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: (yield* test.submit("call")).executionId,
					})
					const input = Struct.omit(delegationInput, ["limits"])
					assert.ok(
						Schema.is(SettingsApi.SettingsUnavailable)(
							yield* commands
								.submit(source, Execution.mainCall("call"), input)
								.pipe(Effect.flip),
						),
					)
					const sql = yield* PgClient.PgClient
					assert.isEmpty(
						yield* sql`select id from openbot_executions where namespace = ${source.namespace} and resource_kind = 'Delegation'`,
					)
					yield* Ref.set(readable, true)
					const receipt = yield* commands.submit(
						source,
						Execution.mainCall("call"),
						input,
					)
					const key = { namespace: source.namespace, id: receipt.executionId }
					assert.deepEqual(
						(yield* commands.load(key)).stored.delegation.limits,
						{ timeMs: 120000 },
					)
					yield* Ref.set(timeLimit, 240000)
					yield* Ref.set(readable, false)
					const next = yield* test.store.takeOver(source)
					assert.deepEqual(
						yield* commands.submit(next, Execution.mainCall("call"), input),
						receipt,
					)
					assert.deepEqual(
						(yield* commands.load(key)).stored.delegation.limits,
						{ timeMs: 120000 },
					)
				}).pipe(Effect.provide(delegationLayerWithSettings(given)))
			}),
	)
	it.effect(
		"a delegation cancel command waits for release and replays after takeover",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-tool-cancel")
				const commands = yield* DelegationCommands.DelegationCommands
				const submitted = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: submitted.executionId,
				})
				const { bot: _bot, ...input } = delegationInput
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					input,
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const target = yield* commands.load(key)
				assert.equal(
					target.input.bot,
					(yield* test.store.loadMember(source)).identity.botId,
				)
				const task = yield* test.store.takeOver(key)
				yield* commands.start(task)
				const cancel = yield* test.submit("two")
				const caller = yield* test.store.takeOver({
					namespace: source.namespace,
					id: cancel.executionId,
				})
				const result = yield* commands.cancel(
					caller,
					Execution.mainCall("two"),
					target.stored.delegation.id,
				)
				assert.deepEqual(result, {
					delegation: target.stored.delegation.id,
					executionId: key.id,
					accepted: true,
				})
				assert.equal(
					(yield* test.store.loadMember(key)).record.status,
					"cancelling",
				)
				assert.equal(
					(yield* commands.load(key)).stored.delegation.status,
					"running",
				)
				const next = yield* test.store.takeOver(caller)
				assert.deepEqual(
					yield* commands.cancel(
						next,
						Execution.mainCall("two"),
						target.stored.delegation.id,
					),
					result,
				)
				assert.equal(
					Arr.filter(
						yield* test.store.events(key, 0),
						(event) =>
							event.body._tag === "State" && event.body.status === "cancelling",
					).length,
					1,
				)
			}).pipe(Effect.provide(delegationLayer)),
	)
	it.effect(
		"a delegation cancel checks its source Chat and current generation",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-tool-cancel-source")
				const commands = yield* DelegationCommands.DelegationCommands
				const submitted = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: submitted.executionId,
				})
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const target = yield* commands.load(key)
				const other = yield* setup(
					test.key.namespace,
					undefined,
					"owner",
					BotDomain.BotId.make("bot_other"),
				)
				const otherTool = yield* other.submit("two")
				const wrong = yield* test.store.takeOver({
					namespace: source.namespace,
					id: otherTool.executionId,
				})
				assert.ok(
					Schema.is(Execution.Forbidden)(
						yield* commands
							.cancel(
								wrong,
								Execution.mainCall("two"),
								target.stored.delegation.id,
							)
							.pipe(Effect.flip),
					),
				)
				const cancel = yield* test.submit("two")
				const old = yield* test.store.takeOver({
					namespace: source.namespace,
					id: cancel.executionId,
				})
				const current = yield* test.store.takeOver(old)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* commands
							.cancel(
								old,
								Execution.mainCall("two"),
								target.stored.delegation.id,
							)
							.pipe(Effect.flip),
					),
				)
				yield* test.store.cancel(
					current,
					Execution.CommandKey.make("cancel-source"),
					(yield* test.store.loadMember(current)).identity.actor,
				)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* commands
							.cancel(
								current,
								Execution.mainCall("two"),
								target.stored.delegation.id,
							)
							.pipe(Effect.flip),
					),
				)
				assert.equal(
					(yield* test.store.loadMember(key)).record.status,
					"queued",
				)
			}).pipe(Effect.provide(delegationLayer)),
	)
	it.effect(
		"the Turn routes delegation tools through saved tool executions",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-tool-route")
				const workflows = yield* DelegationTools.make.pipe(
					Effect.provide(Layer.mock(Records.Records, {})),
				)
				const entries = workflows.entries(test.parent)
				const entry = Option.getOrThrow(Arr.head(entries))
				const call = Prompt.makePart("tool-call", {
					id: "call",
					name: entry.tool.name,
					params: { task: "Read the note", limits: { timeMs: 60000 } },
					providerExecuted: false,
				})
				yield* test.chats.modifyEffect({
					chat: test.position.chat,
					update: (view) =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: {
									turn: {
										...view.chat.turn!,
										pendingStep: {
											...test.pending,
											input: Prompt.make([
												{ role: "assistant", content: [call] },
											]),
										},
									},
								},
							}),
						] as const),
				})
				const toolkit = Toolkit.make(entry.tool)
				const handlers = yield* toolkit.toHandlers({
					[entry.tool.name]: entry.handle,
				})
				const ready = yield* toolkit.pipe(Effect.provideContext(handlers))
				const routes = yield* TurnTools.TurnTools.pipe(
					Effect.provide(
						TurnTools.layer.pipe(
							Layer.provide(ToolSteps.layer),
							Layer.provide(Observation.layer),
						),
					),
				)
				yield* routes.run(
					test.parent,
					test.position,
					{ call, toolkit: ready },
					settings,
					() => Effect.void,
				)
				const children = yield* test.tools.list(
					test.key.namespace,
					test.position.chat,
				)
				assert.equal(children.length, 1)
				const child = children[0]!
				const fence = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: child.executionId,
				})
				const saved = yield* test.tools.load(fence)
				const restored = Option.getOrThrow(
					workflows.restore(fence, saved.input.definition!),
				)
				const output = yield* restored
					.handle(call.params, {
						toolCallId: call.id,
						preliminary: () => Effect.void,
					})
					.pipe(
						Effect.provideService(CallContext, {
							fence,
							id: Execution.CallId.make("send"),
							inputState: saved.input.definition!.inputState!,
						}),
					)
				assert.ok(
					Schema.is(Schema.Struct({ executionId: Execution.Id }))(output),
				)
				for (const tool of entries)
					assert.notStrictEqual(
						(yield* ToolDefinitions.capture(tool.tool)).budgetMs,
						null,
					)
			}).pipe(Effect.provide(delegationLayer), Effect.scoped),
	)
	it.effect("a saved delegation tool restores its command after takeover", () =>
		Effect.gen(function* () {
			const test = yield* setup("delegation-tool-restore")
			const tools = yield* DelegationTools.make.pipe(
				Effect.provide(Layer.mock(Records.Records, {})),
			)
			const entry = Option.getOrThrow(Arr.head(tools.entries(test.parent)))
			const definition = yield* ToolDefinitions.capture(entry.tool)
			assert.equal(definition.local, true)
			const submitted = yield* test.submit("call")
			const source = yield* test.store.takeOver({
				namespace: test.key.namespace,
				id: submitted.executionId,
			})
			const run = (fence: Store.Fence) =>
				Option.getOrThrow(tools.restore(fence, definition))
					.handle(
						{ task: "Read the note", limits: { timeMs: 60000 } },
						{ toolCallId: "call", preliminary: () => Effect.void },
					)
					.pipe(
						Effect.provideService(CallContext, {
							fence,
							id: Execution.CallId.make("tool-call"),
							inputState: definition.inputState!,
						}),
					)
			const first = yield* run(source)
			const next = yield* test.store.takeOver(source)
			assert.deepEqual(yield* run(next), first)
			const saved = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ delegation: Schema.String, executionId: Execution.Id }),
			)(first)
			assert.equal(
				(yield* (yield* DelegationCommands.DelegationCommands).load({
					namespace: source.namespace,
					id: saved.executionId,
				})).stored.delegation.id,
				saved.delegation,
			)
		}).pipe(Effect.provide(delegationLayer)),
	)
	it.effect(
		"a delegation command keeps one task and the source actor after takeover",
		() =>
			Effect.gen(function* () {
				const actor: Caller = {
					kind: "user_token",
					organizationId: "org",
					userId: "speaker",
					tokenId: TokenId.make("speaker-token"),
				}
				const test = yield* setup("delegation-command", actor)
				const commands = yield* DelegationCommands.DelegationCommands
				const records = yield* DelegationsModule.Delegations
				const tool = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: tool.executionId,
				})
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				assert.deepEqual(
					yield* commands.submit(
						source,
						Execution.mainCall("call"),
						delegationInput,
					),
					receipt,
				)
				assert.ok(
					Schema.is(Execution.KeyConflict)(
						yield* commands
							.submit(source, Execution.mainCall("call"), {
								...delegationInput,
								task: "A different note",
							})
							.pipe(Effect.flip),
					),
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const saved = yield* commands.load(key)
				assert.deepEqual(saved.execution.identity.actor, actor)
				assert.equal(saved.stored.chain.userId, "speaker")
				assert.equal(saved.stored.chain.owner, "owner")
				assert.equal(saved.stored.chain.tokenId, actor.tokenId)
				assert.equal(saved.stored.userId, "owner")
				if (saved.origin._tag !== "Tool")
					return yield* Effect.die("The delegation has no tool source.")
				assert.equal(saved.origin.toolKey.id, tool.executionId)
				assert.equal(
					Option.getOrThrow(
						yield* records.find("org", saved.stored.delegation.id),
					).executionId,
					key.id,
				)
				const fence = yield* test.store.takeOver(key)
				const first = yield* commands.start(fence)
				const task = yield* test.store.loadMember({
					namespace: key.namespace,
					id: first.executionId,
				})
				assert.deepEqual(task.identity.actor, actor)
				assert.equal(task.identity.owner.userId, "owner")
				assert.equal(task.identity.botId, delegationInput.bot)
				assert.equal(task.identity.delegationId, saved.stored.delegation.id)
				assert.equal(task.identity.parentExecutionId, test.key.id)
				const next = yield* test.store.takeOver(key)
				assert.deepEqual(yield* commands.start(next), first)
				const db = yield* Db.make
				assert.equal(
					(yield* db
						.select()
						.from(delegationPeriods)
						.where(eq(delegationPeriods.executionId, key.id))).length,
					1,
				)
				assert.deepEqual(
					yield* commands.task(key),
					Option.some({ namespace: key.namespace, id: first.executionId }),
				)
				assert.equal(
					Arr.filter(
						yield* test.store.events(key, 0),
						(event) => event.body._tag === "ChildExecution",
					).length,
					1,
				)
				const current = yield* commands.load(key)
				assert.equal(current.stored.delegation.status, "running")
				assert.equal(
					current.stored.delegation.chat,
					`chat_task_${saved.stored.delegation.id}`,
				)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* commands
							.finish(fence, {
								status: "failed",
								failure: {
									errorId: Execution.ErrorId.make("stale-owner"),
									category: "external",
								},
							})
							.pipe(Effect.flip),
					),
				)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* commands
							.finish(next, { status: "completed", result: "Too early" })
							.pipe(Effect.flip),
					),
				)
			}).pipe(Effect.provide(delegationLayer)),
	)

	it.effect(
		"a delegation start rolls back its Chat and receipt when input cannot commit",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-start-rollback")
				const good = yield* DelegationCommands.DelegationCommands
				const tool = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: tool.executionId,
				})
				const receipt = yield* good.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const fence = yield* test.store.takeOver(key)
				const failure = yield* StartFailure
				yield* Ref.set(failure, "input")
				assert.ok(
					Schema.is(Execution.StorageError)(
						yield* good.start(fence).pipe(Effect.flip),
					),
				)
				yield* Ref.set(failure, "none")
				const saved = yield* good.load(key)
				assert.equal(saved.stored.delegation.status, "authorizing")
				assert.equal(saved.stored.delegation.chat, null)
				assert.ok(Option.isNone(yield* good.task(key)))
				const db = yield* Db.make
				assert.equal(
					(yield* db
						.select()
						.from(delegationPeriods)
						.where(eq(delegationPeriods.executionId, key.id))).length,
					0,
				)
				assert.ok(
					Option.isNone(
						yield* StoredChats.ref(
							db,
							key.namespace,
							Chat.Id.make(`chat_task_${saved.stored.delegation.id}`),
						),
					),
				)
				assert.equal(
					Arr.filter(
						yield* test.store.events(key, 0),
						(event) => event.body._tag === "ChildExecution",
					).length,
					0,
				)
				yield* good.start(fence)
				assert.equal(
					(yield* good.load(key)).stored.delegation.status,
					"running",
				)
			}).pipe(Effect.provide(delegationLayer)),
	)

	it.effect(
		"task messages keep source rights and record their own caller",
		() =>
			Effect.gen(function* () {
				const origin: Caller = {
					kind: "user_token",
					organizationId: "org",
					userId: "speaker",
					tokenId: TokenId.make("origin"),
				}
				const test = yield* setup("task-message-callers", origin)
				const commands = yield* DelegationCommands.DelegationCommands
				const inputs = yield* InputCommands
				const tool = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: tool.executionId,
				})
				const accepted = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				const key = { namespace: source.namespace, id: accepted.executionId }
				const first = yield* commands.start(yield* test.store.takeOver(key))
				const saved = yield* commands.load(key)
				const chat = saved.stored.delegation.chat
				if (chat === null) return yield* Effect.die("The task Chat is missing.")
				const caller: Caller = {
					kind: "user_token",
					organizationId: "org",
					userId: "owner",
					tokenId: TokenId.make("narrow"),
				}
				const input = {
					chat,
					caller,
					content: Prompt.make("Add a note"),
					queue: false,
				}
				const commandKey = Execution.CommandKey.make("operator-input")
				const receipt = yield* inputs.message(
					source.namespace,
					commandKey,
					input,
				)
				assert.deepStrictEqual(
					yield* inputs.message(source.namespace, commandKey, input),
					receipt,
				)
				assert.notEqual(receipt.executionId, first.executionId)
				const task = yield* test.store.loadMember({
					namespace: key.namespace,
					id: receipt.executionId,
				})
				assert.deepStrictEqual(task.identity.actor, origin)
				assert.deepStrictEqual(executionCallers(task.identity), [
					origin,
					caller,
				])
				assert.equal(task.identity.parentExecutionId, saved.origin.key.id)
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					readonly id: string
					readonly user_id: string
				}>`select id, user_id from openbot_execution_commands where namespace = ${source.namespace} and key = ${commandKey}`
				assert.equal(rows[0]?.user_id, caller.userId)
				const command = yield* test.store.command(source.namespace, rows[0]!.id)
				const body = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ caller: Schema.Unknown }),
				)(Option.getOrThrow(command).body)
				assert.deepStrictEqual(body.caller, caller)
				const member: Caller = {
					kind: "member",
					organizationId: "org",
					userId: "owner",
				}
				const next = yield* inputs.message(
					source.namespace,
					Execution.CommandKey.make("member-input"),
					{ ...input, caller: member },
				)
				const nextTask = yield* test.store.loadMember({
					namespace: key.namespace,
					id: next.executionId,
				})
				assert.deepStrictEqual(executionCallers(nextTask.identity), [
					origin,
					caller,
					member,
				])
				const view = yield* test.chats.read(chat)
				assert.deepStrictEqual(ChatHost.hostState(view.chat).inputConstraints, [
					origin,
					caller,
					member,
				])
				assert.equal(view.chat.inbox.length, 2)
				assert.ok(
					Arr.every(view.chat.inbox, (entry) => entry.kind === "message"),
				)
			}).pipe(Effect.provide(delegationLayer)),
	)

	it.effect(
		"a delegation retries a failed Bot read without keeping half a task",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-storage-retry")
				const commands = yield* DelegationCommands.DelegationCommands
				const tool = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: tool.executionId,
				})
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const fence = yield* test.store.takeOver(key)
				const failure = yield* StartFailure
				yield* Ref.set(failure, "storage")
				const error = yield* commands.start(fence).pipe(Effect.flip)
				assert.ok(Schema.is(Execution.StorageError)(error))
				assert.ok(Option.isNone(yield* commands.task(key)))
				yield* Ref.set(failure, "none")
				yield* commands.start(fence)
				assert.equal(
					(yield* commands.load(key)).stored.delegation.status,
					"running",
				)
			}).pipe(Effect.provide(delegationLayer)),
	)
	for (const failure of ["bot", "model"] as const) {
		it.effect(
			`a delegation ${failure} refusal stays a non-retryable failure`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`delegation-start-${failure}`)
					const commands = yield* DelegationCommands.DelegationCommands
					const tool = yield* test.submit("call")
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: tool.executionId,
					})
					const receipt = yield* commands.submit(
						source,
						Execution.mainCall("call"),
						delegationInput,
					)
					const key = { namespace: source.namespace, id: receipt.executionId }
					const fence = yield* test.store.takeOver(key)
					yield* Ref.set(yield* StartFailure, failure)
					const error = yield* commands.start(fence).pipe(Effect.flip)
					assert.ok(
						failure === "bot"
							? Schema.is(Authorizer.Forbidden)(error)
							: Schema.is(ChatModelInvalid)(error),
					)
					assert.equal(
						Records.category(Cause.fail(error)),
						failure === "bot" ? "forbidden" : "invalid",
					)
					assert.ok(Option.isNone(yield* commands.task(key)))
					assert.equal(
						(yield* commands.load(key)).stored.delegation.status,
						"authorizing",
					)
				}).pipe(Effect.provide(delegationLayer)),
		)
	}

	it.effect(
		"a delegation end commits its notice once and waits for the task to stop",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-end")
				const commands = yield* DelegationCommands.DelegationCommands
				const inputs = yield* InputCommands
				const tool = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: tool.executionId,
				})
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const fence = yield* test.store.takeOver(key)
				const first = yield* commands.start(fence)
				const childKey = { namespace: key.namespace, id: first.executionId }
				const child = yield* test.store.takeOver(childKey)
				const saved = yield* commands.load(key)
				yield* test.store.cancel(
					key,
					Execution.CommandKey.make("cancel-delegation"),
					saved.execution.identity.actor,
				)
				const state = yield* test.store.loadMember(key)
				const end = { status: "cancelled", epoch: state.cancelEpoch } as const
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* commands.finish(fence, end).pipe(Effect.flip),
					),
				)
				assert.equal(
					(yield* commands.load(key)).stored.delegation.status,
					"running",
				)
				yield* test.store.cancel(
					childKey,
					Execution.CommandKey.make("cancel-task"),
					saved.execution.identity.actor,
				)
				const task = yield* test.store.loadMember(childKey)
				yield* inputs.finish(child, saved.stored.delegation.chat!, {
					status: "cancelled",
					epoch: task.cancelEpoch,
				})
				const notice = yield* commands.finish(fence, end)
				assert.deepEqual(yield* commands.finish(fence, end), notice)
				assert.notEqual(notice.executionId, key.id)
				const notification = yield* test.store.loadMember({
					namespace: key.namespace,
					id: notice.executionId,
				})
				assert.equal(
					notification.workflow,
					DelegationCommands.noticeWorkflowName,
				)
				assert.deepEqual(notification.input, { delegationExecutionId: key.id })
				assert.equal((yield* commands.view(key)).status, "cancelled")
				assert.equal(
					(yield* commands.load(key)).stored.delegation.status,
					"cancelled",
				)
			}).pipe(Effect.provide(delegationLayer)),
	)

	it.effect(
		"a delegation waits for a later notice before it commits its final answer",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-later-notice")
				const commands = yield* DelegationCommands.DelegationCommands
				const notices = yield* DelegationNotices.DelegationNotices
				const inputs = yield* InputCommands
				const tool = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: tool.executionId,
				})
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const fence = yield* test.store.takeOver(key)
				const first = yield* commands.start(fence)
				const childKey = { namespace: key.namespace, id: first.executionId }
				assert.deepEqual(yield* test.store.ownership(childKey), {
					ownerExecutionId: key.id,
				})
				const child = yield* test.store.takeOver(childKey)
				const saved = yield* commands.load(key)
				const chat = saved.stored.delegation.chat!
				yield* test.chats.modifyEffect({
					chat,
					update: (view) =>
						TurnState.end(view, {
							turn: view.chat.turn!.id,
							completedAt: 1,
							items: [],
							status: Turn.Status.Completed({
								result: { text: "Done", finishReason: "stop" },
							}),
						}).pipe(
							Effect.map(
								({ mutation }) => [undefined, Option.some(mutation)] as const,
							),
						),
				})
				yield* inputs.finish(child, chat, { status: "completed" })
				const db = yield* Db.make
				const ref = Option.getOrThrow(
					yield* StoredChats.ref(db, key.namespace, chat),
				)
				assert.equal(ref.turn?.status._tag, "Completed")
				if (ref.turn?.status._tag !== "Completed")
					return yield* Effect.die("The task did not complete")
				const end = {
					status: "completed",
					result: ref.turn.status.result.text,
				} as const
				const pending = yield* test.store.submit(
					key.namespace,
					Execution.CommandKey.make("later-notice"),
					{
						workflow: "test.notice",
						resource: { kind: "ChatNotice", id: "later-notice" },
						identity: (yield* test.store.loadMember(childKey)).identity,
						ownerExecutionId: key.id,
						input: {},
					},
				)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* commands.finish(fence, end).pipe(Effect.flip),
					),
				)
				assert.equal(
					(yield* commands.load(key)).stored.delegation.status,
					"running",
				)
				const pendingFence = yield* test.store.takeOver({
					namespace: key.namespace,
					id: pending.executionId,
				})
				yield* test.store.commit(
					pendingFence,
					{ status: "completed" },
					Effect.void,
				)
				const result = yield* commands.finish(fence, end)
				assert.deepEqual(yield* commands.finish(fence, end), result)
				const notice = yield* test.store.takeOver({
					namespace: key.namespace,
					id: result.executionId,
				})
				yield* notices.deliver(notice)
				const before = yield* test.chats.read(test.position.chat)
				assert.equal(before.chat.inbox.length, 1)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* notices.deliver(notice).pipe(Effect.flip),
					),
				)
				assert.equal(
					(yield* test.chats.read(test.position.chat)).chat.inbox.length,
					1,
				)
			}).pipe(
				Effect.provide(
					DelegationNotices.layer.pipe(Layer.provideMerge(delegationLayer)),
				),
			),
	)

	it.effect(
		"more input joins a running delegation once and keeps its identity",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-more-input")
				const commands = yield* DelegationCommands.DelegationCommands
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: (yield* test.submit("call")).executionId,
				})
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const fence = yield* test.store.takeOver(key)
				const first = yield* commands.start(fence)
				const saved = yield* commands.load(key)
				const next = yield* test.store.takeOver({
					namespace: source.namespace,
					id: (yield* test.submit("one")).executionId,
				})
				const input = {
					...delegationInput,
					previous: saved.stored.delegation.id,
					task: "Read the next note",
				}
				const failed = yield* StartFailure
				yield* Ref.set(failed, "input")
				assert.ok(
					Schema.is(Execution.StorageError)(
						yield* commands
							.submit(next, Execution.mainCall("one"), input)
							.pipe(Effect.flip),
					),
				)
				assert.equal(
					(yield* test.chats.read(saved.stored.delegation.chat!)).chat.inbox
						.length,
					0,
				)
				yield* Ref.set(failed, "none")
				const added = yield* commands.submit(
					next,
					Execution.mainCall("one"),
					input,
				)
				assert.equal(added.executionId, key.id)
				assert.deepEqual(
					yield* commands.submit(next, Execution.mainCall("one"), input),
					added,
				)
				const chat = (yield* test.chats.read(saved.stored.delegation.chat!))
					.chat
				assert.equal(chat.inbox.length, 1)
				assert.equal((yield* test.store.owned(key)).length, 1)
				assert.equal(
					Option.getOrThrow(yield* commands.task(key)).id,
					first.executionId,
				)
				assert.deepEqual(
					(yield* commands.load(key)).execution.identity,
					saved.execution.identity,
				)
			}).pipe(Effect.provide(delegationLayer)),
	)

	it.effect(
		"a new delegation keeps the old Chat and reserves it before its first Turn",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-next-round")
				const commands = yield* DelegationCommands.DelegationCommands
				const inputs = yield* InputCommands
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: (yield* test.submit("call")).executionId,
				})
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const fence = yield* test.store.takeOver(key)
				const first = yield* commands.start(fence)
				const saved = yield* commands.load(key)
				const chat = saved.stored.delegation.chat!
				const taskKey = { namespace: key.namespace, id: first.executionId }
				const taskFence = yield* test.store.takeOver(taskKey)
				const firstTurn = (yield* test.chats.read(chat)).chat.turn!.id
				yield* test.chats.modifyEffect({
					chat,
					update: (view) =>
						TurnState.end(view, {
							turn: firstTurn,
							completedAt: 1,
							items: [],
							status: Turn.Status.Completed({
								result: { text: "Done", finishReason: "stop" },
							}),
						}).pipe(
							Effect.map(
								({ mutation }) => [undefined, Option.some(mutation)] as const,
							),
						),
				})
				yield* inputs.finish(taskFence, chat, { status: "completed" })
				yield* commands.finish(fence, { status: "completed", result: "Done" })
				const oldChat = (yield* test.chats.read(chat)).chat
				const next = yield* test.store.takeOver({
					namespace: source.namespace,
					id: (yield* test.submit("one")).executionId,
				})
				const input = {
					...delegationInput,
					previous: saved.stored.delegation.id,
					task: "Read the next note",
				}
				const added = yield* commands.submit(
					next,
					Execution.mainCall("one"),
					input,
				)
				assert.notEqual(added.executionId, key.id)
				assert.deepEqual(
					yield* commands.submit(next, Execution.mainCall("one"), input),
					added,
				)
				const reserved = ChatHost.hostState((yield* test.chats.read(chat)).chat)
				assert.equal(reserved.ownerExecutionId, added.executionId)
				assert.equal(reserved.closed, true)
				const other = yield* test.store.takeOver({
					namespace: source.namespace,
					id: (yield* test.submit("two")).executionId,
				})
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* commands
							.submit(other, Execution.mainCall("two"), input)
							.pipe(Effect.flip),
					),
				)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* commands.close(fence).pipe(Effect.flip),
					),
				)
				const nextKey = { namespace: source.namespace, id: added.executionId }
				const nextFence = yield* test.store.takeOver(nextKey)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* commands
							.finish(nextFence, { status: "completed", result: "Done" })
							.pipe(Effect.flip),
					),
				)
				assert.equal(
					(yield* commands.load(nextKey)).stored.delegation.status,
					"authorizing",
				)
				yield* Ref.set(yield* StartFailure, "model")
				const nextTask = yield* commands.start(nextFence)
				assert.notEqual(nextTask.executionId, first.executionId)
				assert.equal(
					(yield* commands.load(nextKey)).stored.delegation.chat,
					chat,
				)
				assert.equal(
					(yield* commands.load(key)).stored.delegation.status,
					"completed",
				)
				const kept = (yield* test.chats.read(chat)).chat
				assert.deepEqual(kept.settings, oldChat.settings)
				assert.notEqual(kept.turn!.id, firstTurn)
				assert.equal(
					Option.getOrThrow(yield* test.chats.turn(chat, firstTurn)).status
						._tag,
					"Completed",
				)
				assert.equal(
					ChatHost.hostState(kept).parent?.delegation,
					(yield* commands.load(nextKey)).stored.delegation.id,
				)
				assert.equal(ChatHost.hostState(kept).closed, undefined)
				assert.deepEqual(
					yield* test.store.ownership({
						namespace: key.namespace,
						id: nextTask.executionId,
					}),
					{ ownerExecutionId: nextKey.id },
				)
			}).pipe(Effect.provide(delegationLayer)),
	)

	it.effect(
		"a repeated person message starts one new task round and keeps all caller limits",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("delegation-person-round")
				const commands = yield* DelegationCommands.DelegationCommands
				const inputs = yield* InputCommands
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: (yield* test.submit("call")).executionId,
				})
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					delegationInput,
				)
				const key = { namespace: source.namespace, id: receipt.executionId }
				const fence = yield* test.store.takeOver(key)
				const first = yield* commands.start(fence)
				const saved = yield* commands.load(key)
				const chat = saved.stored.delegation.chat!
				const taskKey = { namespace: key.namespace, id: first.executionId }
				const taskFence = yield* test.store.takeOver(taskKey)
				const firstTurn = (yield* test.chats.read(chat)).chat.turn!.id
				yield* test.chats.modifyEffect({
					chat,
					update: (view) =>
						TurnState.end(view, {
							turn: firstTurn,
							completedAt: 1,
							items: [],
							status: Turn.Status.Completed({
								result: { text: "Done", finishReason: "stop" },
							}),
						}).pipe(
							Effect.map(
								({ mutation }) => [undefined, Option.some(mutation)] as const,
							),
						),
				})
				yield* inputs.finish(taskFence, chat, { status: "completed" })
				yield* commands.finish(fence, { status: "completed", result: "Done" })

				const messages = yield* TaskMessages.make.pipe(
					Effect.provide(
						Layer.mock(TurnAccess, {
							command: () => Effect.void,
							notice: () => Effect.succeed(true),
						}),
					),
				)
				const caller = {
					...saved.execution.identity.actor,
					kind: "user_token" as const,
					tokenId: TokenId.make("round-token"),
				}
				const command = Execution.CommandKey.make("person-round")
				const message = {
					chat,
					caller,
					content: Prompt.make("Read the new note."),
					queue: false,
				}
				const receipts = yield* Effect.all(
					[
						messages.message(key.namespace, command, message),
						messages.message(key.namespace, command, message),
					],
					{ concurrency: "unbounded" },
				)
				assert.deepEqual(receipts[0], receipts[1])
				assert.notEqual(receipts[0]!.executionId, first.executionId)
				const ref = (yield* test.chats.read(chat)).chat
				const host = ChatHost.hostState(ref)
				assert.notEqual(host.ownerExecutionId, key.id)
				const next = yield* commands.load({
					namespace: key.namespace,
					id: host.ownerExecutionId!,
				})
				assert.equal(next.input.source._tag, "Message")
				assert.notEqual(next.stored.delegation.id, saved.stored.delegation.id)
				assert.equal(next.stored.delegation.chat, chat)
				assert.deepEqual(
					next.execution.identity.actor,
					saved.execution.identity.actor,
				)
				assert.ok(
					Arr.some(
						next.execution.identity.constraints ?? [],
						(value) => value.tokenId === caller.tokenId,
					),
				)
				assert.equal(
					(yield* commands.load(key)).stored.delegation.status,
					"completed",
				)
				assert.equal((yield* test.store.get(key)).status, "completed")
				assert.deepEqual(
					yield* test.store.ownership({
						namespace: key.namespace,
						id: receipts[0]!.executionId,
					}),
					{ ownerExecutionId: next.execution.record.id },
				)
				assert.deepEqual(
					yield* messages.message(key.namespace, command, message),
					receipts[0],
				)
				assert.ok(
					Schema.is(Execution.KeyConflict)(
						yield* messages
							.message(key.namespace, command, {
								...message,
								content: Prompt.make("Another note."),
							})
							.pipe(Effect.flip),
					),
				)
			}).pipe(Effect.provide(delegationLayer)),
	)
	it.effect("only the source Chat can add to a delegation", () =>
		Effect.gen(function* () {
			const test = yield* setup("delegation-private")
			const commands = yield* DelegationCommands.DelegationCommands
			const source = yield* test.store.takeOver({
				namespace: test.key.namespace,
				id: (yield* test.submit("call")).executionId,
			})
			const receipt = yield* commands.submit(
				source,
				Execution.mainCall("call"),
				delegationInput,
			)
			const key = { namespace: source.namespace, id: receipt.executionId }
			const fence = yield* test.store.takeOver(key)
			yield* commands.start(fence)
			const saved = yield* commands.load(key)
			const other = yield* setup("delegation-other-chat")
			const next = yield* test.store.takeOver({
				namespace: other.key.namespace,
				id: (yield* other.submit("call")).executionId,
			})
			assert.ok(
				Schema.is(Execution.Forbidden)(
					yield* commands
						.submit(next, Execution.mainCall("call"), {
							...delegationInput,
							previous: saved.stored.delegation.id,
						})
						.pipe(Effect.flip),
				),
			)
			assert.equal(
				(yield* test.chats.read(saved.stored.delegation.chat!)).chat.inbox
					.length,
				0,
			)
		}).pipe(Effect.provide(delegationLayer)),
	)

	for (const ended of [false, true])
		for (const caller of ["member", "token"] as const) {
			it.effect(
				`a ${caller} cannot reuse another identity's ${ended ? "ended" : "running"} delegation`,
				() =>
					Effect.gen(function* () {
						const test = yield* setup(`delegation-caller-${caller}-${ended}`)
						const commands = yield* DelegationCommands.DelegationCommands
						const source = yield* test.store.takeOver({
							namespace: test.key.namespace,
							id: (yield* test.submit("call")).executionId,
						})
						const receipt = yield* commands.submit(
							source,
							Execution.mainCall("call"),
							delegationInput,
						)
						const key = { namespace: source.namespace, id: receipt.executionId }
						const fence = yield* test.store.takeOver(key)
						const first = yield* commands.start(fence)
						const saved = yield* commands.load(key)
						const chat = saved.stored.delegation.chat!
						if (ended) {
							const taskFence = yield* test.store.takeOver({
								namespace: key.namespace,
								id: first.executionId,
							})
							yield* test.chats.modifyEffect({
								chat,
								update: (view) =>
									TurnState.end(view, {
										turn: view.chat.turn!.id,
										completedAt: 1,
										items: [],
										status: Turn.Status.Completed({
											result: { text: "Done", finishReason: "stop" },
										}),
									}).pipe(
										Effect.map(
											({ mutation }) =>
												[undefined, Option.some(mutation)] as const,
										),
									),
							})
							yield* (yield* InputCommands).finish(taskFence, chat, {
								status: "completed",
							})
							yield* commands.finish(fence, {
								status: "completed",
								result: "Done",
							})
						}
						const original = yield* test.store.loadMember(test.key)
						const nextTurn = Turn.Id.make("next-turn")
						yield* test.chats.modifyEffect({
							chat: test.position.chat,
							update: (view) =>
								Effect.succeed([
									undefined,
									Option.some({
										chat: { turn: { ...view.chat.turn!, id: nextTurn } },
									}),
								] as const),
						})
						const actor: Caller =
							caller === "member"
								? {
										kind: "member",
										organizationId: "org",
										userId: "another-speaker",
									}
								: {
										kind: "user_token",
										organizationId: "org",
										userId: "speaker",
										tokenId: TokenId.make("limited-token"),
									}
						const turn = yield* test.store.submit(
							test.key.namespace,
							Execution.CommandKey.make("next-turn"),
							{
								workflow: InputCommandsModule.workflowName,
								resource: { kind: "Turn", id: nextTurn },
								identity: { ...original.identity, actor },
								input: { chat: test.position.chat },
							},
						)
						const parent = yield* test.store.takeOver({
							namespace: test.key.namespace,
							id: turn.executionId,
						})
						const tool = yield* test.tools.submit(
							parent,
							{ ...test.position, turn: nextTurn },
							test.call("one"),
							settings,
						)
						const next = yield* test.store.takeOver({
							namespace: test.key.namespace,
							id: tool.executionId,
						})
						assert.ok(
							Schema.is(Execution.Forbidden)(
								yield* commands
									.submit(next, Execution.mainCall("one"), {
										...delegationInput,
										previous: saved.stored.delegation.id,
										task: "Read a private note",
									})
									.pipe(Effect.flip),
							),
						)
						const after = (yield* test.chats.read(chat)).chat
						assert.equal(after.inbox.length, 0)
						assert.equal(ChatHost.hostState(after).ownerExecutionId, key.id)
					}).pipe(Effect.provide(delegationLayer)),
			)
		}

	const delegationSessionLayer = (
		permission: Ref.Ref<boolean>,
		beforePolicy: Effect.Effect<void> = Effect.void,
	) => {
		const allowed = Policy.define(Authorization.OpenBot)(function* (_) {
			yield* _.allow("*", "*")
		})
		return Layer.merge(DelegationSessionModule.layer, WorkAdmission.layer).pipe(
			Layer.provideMerge(RequestCommandsModule.layer),
			Layer.provideMerge(RequestsModule.layer),
			Layer.provideMerge(
				Layer.mergeAll(
					GrantsModule.layer,
					RulesModule.layer,
					AuditModule.layer,
					Records.layer,
				),
			),
			Layer.provide(
				Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
			),
			Layer.provideMerge(delegationLayer),
			Layer.provide(BotRecordsModule.layer),
			Layer.provide(OrganizationFixture.layerDefaultSettings),
			Layer.provide(
				Layer.mergeAll(
					Authorizer.layer(Authorization.Auth, {
						policy: () =>
							beforePolicy.pipe(
								Effect.andThen(Ref.get(permission)),
								Effect.map((yes) =>
									yes ? allowed : Authorization.emptyPolicy,
								),
							),
					}),
					Layer.mock(TurnAccess, {
						admit: () => Effect.void,
						authorize: () => Effect.void,
						input: () => Effect.void,
						notice: () => Effect.succeed(true),
					}),
					Layer.mock(Bots, {
						access: (_, id) =>
							Effect.succeed({
								...BotFixture.bot,
								id: BotDomain.BotId.make(id),
							}),
					}),
					Layer.mock(Billing, {}),
					Layer.mock(ModelRegistry, { defaultModel: Option.none() }),
					Layer.mock(TurnContext.TurnContext, {
						prepare: (frame) =>
							Effect.gen(function* () {
								return {
									...frame,
									bot: { ...BotFixture.bot, id: frame.host.bot },
									chain: ChatHost.chainForHost(frame.host, frame.identity),
									deciders:
										frame.host.kind === "task"
											? [BotFixture.bot.id, frame.host.bot]
											: [],
								}
							}),
					}),
				),
			),
		)
	}
	for (const outcome of ["allow", "deny", "revoked"] as const) {
		it.effect(
			`a delegation approval can ${outcome} after its source tool ends`,
			() =>
				Effect.gen(function* () {
					const permission = yield* Ref.make(true)
					const sessionLayer = delegationSessionLayer(permission)
					yield* Effect.gen(function* () {
						const test = yield* setup(`delegation-approval-${outcome}`)
						const commands = yield* DelegationCommands.DelegationCommands
						const session = yield* DelegationSessionModule.DelegationSession
						const requests = yield* RequestCommands
						const source = yield* test.store.takeOver({
							namespace: test.key.namespace,
							id: (yield* test.submit("call")).executionId,
						})
						const receipt = yield* commands.submit(
							source,
							Execution.mainCall("call"),
							delegationInput,
						)
						const key = { namespace: source.namespace, id: receipt.executionId }
						const fence = yield* test.store.takeOver(key)
						const first = yield* session.advance(fence)
						assert.equal(first._tag, "Approval")
						if (first._tag !== "Approval")
							return yield* Effect.die("The task needs approval")
						assert.equal((yield* test.store.get(key)).status, "waiting")
						assert.ok(Option.isNone(yield* commands.task(key)))
						yield* test.store.commit(
							source,
							{ status: "completed" },
							Effect.void,
						)
						const requestFence = yield* test.store.takeOver(first.key)
						const request = yield* requests.load(first.key)
						yield* requests.decide(
							first.key,
							request.execution.identity.actor,
							{
								commandKey: Execution.CommandKey.make("decision"),
								decisionId: RequestCommandsModule.decisionId(
									request.stored.request,
								),
								answer: outcome === "deny" ? "deny" : "allow",
								details: { reason: "Use the short way." },
							},
						)
						yield* requests.finish(requestFence, { status: "completed" })
						if (outcome === "revoked") yield* Ref.set(permission, false)
						if (outcome === "allow") {
							const started = yield* session.advance(fence)
							assert.equal(started._tag, "Started")
							assert.deepEqual(yield* session.advance(fence), started)
							assert.equal((yield* test.store.get(key)).status, "running")
							assert.equal((yield* test.store.owned(key)).length, 1)
						} else {
							assert.ok(
								Schema.is(Execution.Forbidden)(
									yield* session.advance(fence).pipe(Effect.flip),
								),
							)
							assert.ok(Option.isNone(yield* commands.task(key)))
							assert.equal((yield* test.store.owned(key)).length, 0)
						}
					}).pipe(Effect.provide(sessionLayer))
				}),
		)
	}

	for (const outcome of ["allow", "deny", "revoked"] as const) {
		it.effect(
			`a limit check uses the task Bot and can ${outcome} after takeover`,
			() =>
				Effect.gen(function* () {
					const permission = yield* Ref.make(true)
					yield* Effect.gen(function* () {
						const test = yield* setup(`delegation-limit-${outcome}`)
						const commands = yield* DelegationCommands.DelegationCommands
						const session = yield* DelegationSessionModule.DelegationSession
						const requests = yield* RequestCommands
						const source = yield* test.store.takeOver({
							namespace: test.key.namespace,
							id: (yield* test.submit("call")).executionId,
						})
						const receipt = yield* commands.submit(
							source,
							Execution.mainCall("call"),
							delegationInput,
						)
						const key = { namespace: source.namespace, id: receipt.executionId }
						const before = yield* test.store.takeOver(key)
						const task = yield* commands.start(before)
						const control: PolicyOrigin.Control = {
							kind: "delegationLimit",
							turnExecutionId: task.executionId,
							epoch: 1,
						}
						assert.ok(
							Schema.is(Execution.Conflict)(
								yield* commands.pause(before, control).pipe(Effect.flip),
							),
						)
						assert.equal(
							(yield* commands.load(key)).stored.delegation.status,
							"running",
						)
						yield* saveTaskSteps(
							{ namespace: key.namespace, id: task.executionId },
							3,
						)
						const paused = yield* commands.pause(before, control)
						assert.equal(
							(yield* commands.view(key)).delegation.usage?.timeMs,
							(yield* commands.load(key)).stored.delegation.usage?.timeMs,
						)
						assert.deepEqual(yield* commands.pause(before, control), paused)
						const fence = yield* test.store.takeOver(key)
						assert.ok(
							Schema.is(Execution.Conflict)(
								yield* commands.resume(before, control).pipe(Effect.flip),
							),
						)
						const admission = yield* WorkAdmission.WorkAdmission
						const taskKey = { namespace: key.namespace, id: task.executionId }
						const blocked = yield* admission
							.check(taskKey, false)
							.pipe(Effect.flip)
						assert.ok(Schema.is(Admission.Paused)(blocked))
						if (Schema.is(Admission.Paused)(blocked))
							assert.equal(blocked.id, key.id)
						const first = yield* session.continueWork(fence)
						if (first._tag !== "Approval")
							return yield* Effect.die("The limit needs approval")
						assert.deepEqual(yield* session.continueWork(fence), first)
						let request = yield* requests.load(first.key)
						assert.equal(
							(yield* commands.load(key)).stored.delegation.pause?.request,
							request.stored.request.id,
						)
						assert.equal(request.stored.request.bot, delegationInput.bot)
						assert.equal(request.originKey.id, task.executionId)
						assert.equal(request.sourceKey.id, key.id)
						assert.equal(
							request.execution.identity.parentExecutionId,
							task.executionId,
						)
						assert.equal(request.execution.identity.actor.userId, "speaker")
						assert.deepEqual(yield* test.store.ownership(first.key), {
							ownerExecutionId: key.id,
						})
						assert.deepEqual(request.stored.request.approver, {
							_tag: "Bot",
							bot: BotFixture.bot.id,
						})
						const review = yield* test.store.submit(
							key.namespace,
							Execution.CommandKey.make("limit-review"),
							{
								workflow: "openbot.turn",
								resource: { kind: "Turn", id: "review-turn" },
								ownerExecutionId: key.id,
								identity: {
									...request.execution.identity,
									botId: BotFixture.bot.id,
								},
								input: {
									chat: "review-chat",
									host: {
										kind: "review",
										bot: BotFixture.bot.id,
										review: request.stored.request.id,
										chain: request.stored.chain,
									},
								},
							},
						)
						const reviewKey = {
							namespace: key.namespace,
							id: review.executionId,
						}
						// A review label alone cannot bypass the pause.
						assert.deepInclude(
							yield* admission.check(reviewKey, false).pipe(Effect.flip),
							{ _tag: "ExecutionPaused" },
						)
						const requestFence = yield* test.store.takeOver(first.key)
						yield* test.store.commit(
							requestFence,
							{
								events: [
									{
										_tag: "ChildExecution",
										executionId: reviewKey.id,
										step: `review:${request.stored.request.revision}`,
									},
								],
							},
							Effect.void,
						)
						yield* admission.check(reviewKey, false)
						// The review does not permit ordinary task work.
						assert.ok(
							Schema.is(Admission.Paused)(
								yield* admission.check(taskKey, false).pipe(Effect.flip),
							),
						)
						const reviewFence = yield* test.store.takeOver(reviewKey)
						yield* test.store.commit(
							reviewFence,
							{ status: "completed" },
							Effect.void,
						)
						yield* requests.pass(requestFence, request.stored.request.revision)
						request = yield* requests.load(first.key)
						yield* requests.decide(
							first.key,
							request.execution.identity.actor,
							{
								commandKey: Execution.CommandKey.make("limit-answer"),
								decisionId: RequestCommandsModule.decisionId(
									request.stored.request,
								),
								answer: outcome === "deny" ? "deny" : "allow",
								details: { reason: "Use the short way." },
							},
						)
						yield* requests.finish(requestFence, { status: "completed" })
						if (outcome === "revoked") yield* Ref.set(permission, false)
						if (outcome !== "allow") {
							assert.deepEqual(yield* session.continueWork(fence), {
								_tag: "Stopped",
								epoch: paused.control.epoch,
							})
							assert.equal(
								(yield* commands.load(key)).execution.record.status,
								"cancelling",
							)
							return
						}
						const db = yield* Db.make
						// A model result can arrive while the approval is open.
						yield* db
							.update(usageEvents)
							.set({ status: "confirmed", costMicros: 7 })
							.where(eq(usageEvents.id, `${task.executionId}:model:0`))
						assert.deepEqual(yield* session.continueWork(fence), {
							_tag: "Continued",
							epoch: 1,
						})
						assert.deepEqual(yield* session.continueWork(fence), {
							_tag: "Continued",
							epoch: 1,
						})
						const running = (yield* commands.load(key)).stored
						const guidance = Arr.filter(
							(yield* test.chats.read(running.delegation.chat!)).chat.inbox,
							(entry) =>
								entry.notice?.kind === "request" &&
								entry.notice.ref === request.stored.request.id,
						)
						assert.equal(guidance.length, 1)
						assert.include(
							yield* Schema.encodeEffect(Schema.fromJsonString(Prompt.Prompt))(
								guidance[0]!.content,
							),
							"Use the short way.",
						)
						assert.equal(running.window?.steps, 3)
						assert.equal(running.window?.costMicros, 7)
						assert.equal(running.delegation.usage?.costMicros, 7)
						assert.equal(running.delegation.status, "running")
						yield* admission.check(taskKey, false)
						yield* saveTaskSteps(taskKey, 6)
						yield* commands.pause(fence, { ...control, epoch: 2 })
						assert.deepInclude(
							yield* admission.check(reviewKey, false).pipe(Effect.flip),
							{ _tag: "ExecutionPaused" },
						)
						const second = yield* session.continueWork(fence)
						if (second._tag !== "Approval")
							return yield* Effect.die("The new limit needs approval")
						assert.notEqual(second.key.id, first.key.id)
						assert.equal(
							(yield* requests.load(first.key)).stored.request.status,
							"allowed",
						)
						assert.equal(
							(yield* requests.load(second.key)).stored.request.status,
							"pending",
						)
						const stale = yield* requests
							.submit(fence, Execution.CommandKey.make("stale-limit"), {
								control,
								continuation: "workflow",
								toolCallId: PolicyOrigin.controlId(fence, control),
								capability: request.stored.request.capability,
								reason: "The old pause cannot ask again.",
							})
							.pipe(Effect.flip)
						assert.ok(Schema.is(Execution.Conflict)(stale))
						if (Schema.is(Execution.Conflict)(stale))
							assert.equal(stale.id, fence.id)
					}).pipe(Effect.provide(delegationSessionLayer(permission)))
				}),
		)
	}
	it.effect(
		"an interrupted limit check stays paused and can recover after takeover",
		() =>
			Effect.gen(function* () {
				const permission = yield* Ref.make(true)
				const entered = yield* Deferred.make<void>()
				const waiting = yield* Ref.make(true)
				const beforePolicy = Effect.gen(function* () {
					if (yield* Ref.get(waiting)) {
						yield* Deferred.succeed(entered, undefined)
						return yield* Effect.never
					}
				})
				yield* Effect.gen(function* () {
					const test = yield* setup("delegation-limit-interrupted")
					const commands = yield* DelegationCommands.DelegationCommands
					const session = yield* DelegationSessionModule.DelegationSession
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: (yield* test.submit("call")).executionId,
					})
					const receipt = yield* commands.submit(
						source,
						Execution.mainCall("call"),
						delegationInput,
					)
					const key = { namespace: source.namespace, id: receipt.executionId }
					const first = yield* test.store.takeOver(key)
					const task = yield* commands.start(first)
					const taskKey = { namespace: key.namespace, id: task.executionId }
					yield* saveTaskSteps(taskKey, 3)
					yield* commands.pause(first, {
						kind: "delegationLimit",
						turnExecutionId: task.executionId,
						epoch: 1,
					})
					const check = yield* session
						.continueWork(first)
						.pipe(Effect.forkChild)
					yield* Deferred.await(entered)
					yield* Fiber.interrupt(check)
					assert.equal(
						(yield* commands.load(key)).stored.delegation.status,
						"paused",
					)
					assert.ok(
						Schema.is(Admission.Paused)(
							yield* (yield* WorkAdmission.WorkAdmission)
								.check(taskKey, false)
								.pipe(Effect.flip),
						),
					)
					yield* Ref.set(waiting, false)
					const next = yield* test.store.takeOver(key)
					const resumed = yield* session.continueWork(next)
					assert.equal(resumed._tag, "Approval")
					assert.deepEqual(yield* session.continueWork(next), resumed)
					assert.equal(
						(yield* commands.load(key)).stored.delegation.status,
						"paused",
					)
				}).pipe(
					Effect.provide(delegationSessionLayer(permission, beforePolicy)),
				)
			}),
	)
	it.effect("a limit cannot use a source or a review Turn as its task", () =>
		Effect.gen(function* () {
			const test = yield* setup("delegation-limit-subject")
			const commands = yield* DelegationCommands.DelegationCommands
			const source = yield* test.store.takeOver({
				namespace: test.key.namespace,
				id: (yield* test.submit("call")).executionId,
			})
			const receipt = yield* commands.submit(
				source,
				Execution.mainCall("call"),
				delegationInput,
			)
			const fence = yield* test.store.takeOver({
				namespace: source.namespace,
				id: receipt.executionId,
			})
			const task = yield* commands.start(fence)
			const control: PolicyOrigin.Control = {
				kind: "delegationLimit",
				turnExecutionId: test.key.id,
				epoch: 1,
			}
			assert.ok(
				Schema.is(Execution.Forbidden)(
					yield* commands.pause(fence, control).pipe(Effect.flip),
				),
			)
			const child = yield* test.store.loadMember({
				namespace: source.namespace,
				id: task.executionId,
			})
			const reference = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ chat: Chat.Id, host: ChatHost.ChatHostState }),
			)(child.input)
			const review = yield* test.store.accept(
				source.namespace,
				Execution.CommandKey.make("review-subject"),
				{ actor: child.identity.actor, body: {} },
				(create) =>
					Effect.gen(function* () {
						const key = yield* create({
							workflow: "openbot.turn",
							resource: { kind: "Turn", id: "review" },
							ownerExecutionId: fence.id,
							identity: child.identity,
							input: {
								chat: reference.chat,
								host: { ...reference.host, kind: "review" },
							},
						})
						return { executionId: key.id, start: true }
					}),
			)
			assert.ok(
				Schema.is(Execution.Forbidden)(
					yield* commands
						.pause(fence, { ...control, turnExecutionId: review.executionId })
						.pipe(Effect.flip),
				),
			)
			assert.equal(
				(yield* commands.load(fence)).stored.delegation.status,
				"running",
			)
		}).pipe(Effect.provide(delegationLayer)),
	)

	it.effect(
		"a step limit stops the next task model and keeps its last tools and summary",
		() =>
			Effect.gen(function* () {
				const permission = yield* Ref.make(true)
				yield* Effect.gen(function* () {
					const test = yield* setup("delegation-send-limit")
					const commands = yield* DelegationCommands.DelegationCommands
					const admission = yield* WorkAdmission.WorkAdmission
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: (yield* test.submit("call")).executionId,
					})
					const submitted = yield* commands.submit(
						source,
						Execution.mainCall("call"),
						delegationInput,
					)
					const owner = yield* test.store.takeOver({
						namespace: source.namespace,
						id: submitted.executionId,
					})
					const first = yield* commands.start(owner)
					const task = yield* test.store.takeOver({
						namespace: owner.namespace,
						id: first.executionId,
					})
					yield* saveTaskSteps(task, 3)
					const model = yield* test.store.readAttempt(task, "next-model", {
						purpose: "turn",
					})
					const summary = yield* test.store.readAttempt(task, "summary", {
						purpose: "compaction",
					})
					const tool = yield* test.store.intent(task, {
						step: "last-tool",
						attempt: 0,
						retry: "never",
						input: {},
					})
					yield* admission.check(task, false)
					yield* admission.check(task, false, summary)
					yield* admission.check(task, false, tool)
					assert.deepInclude(
						yield* test.store
							.sending(task, model.id, admission.check(task, true, model))
							.pipe(Effect.flip),
						{ _tag: "ExecutionPaused", id: owner.id },
					)
					const calls = yield* test.store.calls(task)
					assert.equal(
						Option.getOrThrow(
							Arr.findFirst(calls, (call) => call.id === model.id),
						).status,
						"intended",
					)
					const taskState = yield* test.store.loadMember(task)
					const taskInput = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ chat: Chat.Id, host: ChatHost.ChatHostState }),
					)(taskState.input)
					const reviewReceipt = yield* test.store.submit(
						task.namespace,
						Execution.CommandKey.make("tool-review"),
						{
							workflow: "openbot.chat-turn",
							resource: { kind: "Turn", id: "review-turn" },
							identity: taskState.identity,
							ownerExecutionId: owner.id,
							input: {
								chat: "review-chat",
								host: { ...taskInput.host, kind: "review" },
							},
						},
					)
					const review = yield* test.store.takeOver({
						namespace: task.namespace,
						id: reviewReceipt.executionId,
					})
					const reviewModel = yield* test.store.readAttempt(
						review,
						"review-model",
						{ purpose: "turn" },
					)
					yield* admission.check(review, false, reviewModel)
					// A budget limit also stops tools; it uses confirmed saved costs.
					const db = yield* Db.make
					yield* db
						.update(usageEvents)
						.set({ status: "confirmed", costMicros: 100 })
						.where(eq(usageEvents.id, `${task.id}:model:0`))
					const records = yield* DelegationsModule.Delegations
					const saved = yield* commands.load(owner)
					yield* records.change(
						"org",
						saved.stored.delegation.id,
						["running"],
						(stored) => ({
							...stored,
							delegation: {
								...stored.delegation,
								limits: { timeMs: 3600000, budgetMicros: 100 },
							},
						}),
					)
					assert.deepInclude(
						yield* admission.check(task, false, tool).pipe(Effect.flip),
						{ _tag: "ExecutionPaused", id: owner.id },
					)
					assert.deepInclude(
						yield* admission
							.check(review, false, reviewModel)
							.pipe(Effect.flip),
						{ _tag: "ExecutionPaused", id: owner.id },
					)
				}).pipe(Effect.provide(delegationSessionLayer(permission)))
			}),
	)

	it.effect("a lost reservation reply keeps the same task step", () =>
		Effect.gen(function* () {
			const permission = yield* Ref.make(true)
			yield* Effect.gen(function* () {
				const test = yield* setup("reservation-lost-reply")
				const commands = yield* DelegationCommands.DelegationCommands
				const admission = yield* WorkAdmission.WorkAdmission
				const sql = yield* SqlClient.SqlClient
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: (yield* test.submit("call")).executionId,
				})
				const receipt = yield* commands.submit(
					source,
					Execution.mainCall("call"),
					{ ...delegationInput, limits: { timeMs: 3600000, steps: 1 } },
				)
				const owner = yield* test.store.takeOver({
					namespace: source.namespace,
					id: receipt.executionId,
				})
				const started = yield* commands.start(owner)
				const task = yield* test.store.takeOver({
					namespace: owner.namespace,
					id: started.executionId,
				})
				const call = yield* test.store.readAttempt(task, "model", {
					purpose: "turn",
				})
				yield* test.store.sending(task, call.id)
				const commits = yield* Ref.make(0)
				const sends = yield* Ref.make(0)
				const registry = Layer.mock(Registry, {
					get: () =>
						Effect.succeedSome({
							start: () => Effect.void,
							cancel: () => Effect.void,
							signal: () => Effect.void,
							authorize: () => Effect.void,
							admit: admission.check,
						}),
				})
				const lostReply = Layer.mock(SqlClient.SqlClient, {
					...sql,
					withTransaction: (work) =>
						sql.withTransaction(work).pipe(
							Effect.flatMap((value) =>
								Ref.updateAndGet(commits, (n) => n + 1).pipe(
									Effect.flatMap((count) =>
										count === 1
											? Effect.fail(
													SqlError.SqlError.make({
														reason: SqlError.ConnectionError.make({
															cause: "The commit reply was lost.",
														}),
													}),
												)
											: Effect.succeed(value),
									),
								),
							),
						),
				})
				yield* Effect.gen(function* () {
					const calls = yield* Calls
					yield* calls.reserve(task, call, saveTaskSteps(task, 1, call.id))
					yield* Ref.update(sends, (n) => n + 1)
				}).pipe(
					Effect.provide(
						CallsModule.layer.pipe(
							Layer.provide(Layer.mergeAll(registry, lostReply)),
							Layer.fresh,
						),
					),
				)
				assert.equal(yield* Ref.get(commits), 2)
				assert.equal(yield* Ref.get(sends), 1)
				assert.equal((yield* commands.view(owner)).delegation.usage?.steps, 1)
				yield* commands.pause(owner, {
					kind: "delegationLimit",
					epoch: 1,
					turnExecutionId: task.id,
				})
				assert.deepInclude(
					yield* admission.check(task, false, call).pipe(Effect.flip),
					{ _tag: "ExecutionPaused", id: owner.id },
				)
				yield* commands.resume(owner, {
					kind: "delegationLimit",
					epoch: 1,
					turnExecutionId: task.id,
				})
				// The next window still counts its own started calls.
				yield* saveTaskSteps(task, 1)

				const next = yield* test.store.readAttempt(task, "next-model", {
					purpose: "turn",
				})
				assert.deepInclude(
					yield* admission.check(task, false, next).pipe(Effect.flip),
					{ _tag: "ExecutionPaused", id: owner.id },
				)
			}).pipe(Effect.provide(delegationSessionLayer(permission)))
		}),
	)

	it.effect(
		"a late budget charge wakes a delegation from its saved cursor",
		() =>
			Effect.gen(function* () {
				const permission = yield* Ref.make(true)
				yield* Effect.gen(function* () {
					const test = yield* setup("delegation-late-budget")
					const commands = yield* DelegationCommands.DelegationCommands
					const admission = yield* WorkAdmission.WorkAdmission
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: (yield* test.submit("call")).executionId,
					})
					const receipt = yield* commands.submit(
						source,
						Execution.mainCall("call"),
						{
							...delegationInput,
							limits: { timeMs: 3600000, budgetMicros: 100 },
						},
					)
					const owner = yield* test.store.takeOver({
						namespace: source.namespace,
						id: receipt.executionId,
					})
					const started = yield* commands.start(owner)
					const task = yield* test.store.takeOver({
						namespace: owner.namespace,
						id: started.executionId,
					})
					yield* saveTaskSteps(task, 1)
					const pending = yield* test.store.readAttempt(task, "waiting-model", {
						purpose: "turn",
					})
					yield* test.store.sending(task, pending.id)
					const waiting = yield* commands.inspect(owner)
					assert.equal(waiting._tag, "Wait")
					const cursor = (yield* test.store.get(owner)).sequence
					// A late confirmed usage row can change costs without a new event on the old call.
					const db = yield* Db.make
					yield* db
						.update(usageEvents)
						.set({ status: "confirmed", costMicros: 100 })
						.where(eq(usageEvents.id, `${task.id}:model:0`))
					assert.deepEqual(yield* test.store.events(owner, cursor), [])
					const registry = Layer.mock(Registry, {
						get: () =>
							Effect.succeedSome({
								start: () => Effect.void,
								cancel: () => Effect.void,
								signal: () => Effect.void,
								authorize: () => Effect.void,
								admit: admission.check,
							}),
					})
					yield* Effect.gen(function* () {
						const calls = yield* Calls
						const stopped = yield* calls
							.reserve(
								task,
								pending,
								Effect.die("A blocked call cannot reserve usage."),
							)
							.pipe(Effect.flip)
						assert.deepInclude(stopped, {
							_tag: "ExecutionPaused",
							id: owner.id,
							wake: "limit:0:budget",
						})
					}).pipe(
						Effect.provide(
							CallsModule.layer.pipe(Layer.provide(registry), Layer.fresh),
						),
					)
					assert.deepEqual(
						Arr.map(
							yield* test.store.events(owner, cursor),
							(event) => event.body,
						),
						[{ _tag: "Wake", key: "limit:0:budget" }],
					)
					const next = yield* commands.inspect(owner)
					assert.equal(next._tag, "Limit")
					if (next._tag === "Limit") yield* commands.pause(owner, next.control)
					assert.equal(
						(yield* commands.load(owner)).stored.delegation.pause?.limit,
						"budget",
					)
				}).pipe(Effect.provide(delegationSessionLayer(permission)))
			}),
	)

	/** Use the real workflow, event log and deadline. Only the later decision stays open. */
	const timedDelegation = Effect.fn(function* (name: string) {
		const test = yield* setup(name)
		const commands = yield* DelegationCommands.DelegationCommands
		const source = yield* test.store.takeOver({
			namespace: test.key.namespace,
			id: (yield* test.submit("call")).executionId,
		})
		const receipt = yield* commands.submit(source, Execution.mainCall("call"), {
			...delegationInput,
			limits: { timeMs: 3000 },
		})
		const key = { namespace: source.namespace, id: receipt.executionId }
		const firstOwner = yield* test.store.takeOver(key)
		const started = yield* commands.start(firstOwner)
		const taskKey = { namespace: key.namespace, id: started.executionId }
		const waits = yield* Ref.make<
			ReadonlyArray<{
				readonly at: number
				readonly deadline: number | undefined
			}>
		>([])
		const firstWait = yield* Deferred.make<void>()
		const nextWait = yield* Deferred.make<void>()
		const paused = yield* Deferred.make<void>()
		const scopes = Layer.effect(
			RunScope.RunScope,
			Effect.gen(function* () {
				const original = yield* RunScope.RunScope
				return RunScope.RunScope.of({
					...original,
					run: (fence, phase, work, options) =>
						Effect.gen(function* () {
							if (Str.startsWith("task:")(phase)) {
								const at = yield* Clock.currentTimeMillis
								const current = yield* Ref.updateAndGet(
									waits,
									Arr.append({ at, deadline: options?.deadline }),
								)
								yield* Deferred.succeed(
									current.length === 1 ? firstWait : nextWait,
									undefined,
								)
							}
							return yield* original.run(fence, phase, work, options)
						}),
				})
			}),
		).pipe(Layer.provide(RunScope.layer), Layer.provide(Observation.layer))
		const base = Layer.mergeAll(
			CallsModule.layer,
			Observation.layer,
			scopes,
			Runner.layer.pipe(
				Layer.provide(
					Layer.mock(Billing, { releaseExecution: () => Effect.succeed(true) }),
				),
			),
		).pipe(
			Layer.provideMerge(Engine.layerRegistry),
			Layer.provideMerge(
				Records.layer.pipe(
					Layer.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				),
			),
			Layer.provideMerge(WorkflowEngine.layerMemory),
		)
		const runtime = DelegationWorkflow.layer.pipe(
			Layer.provide(
				Layer.mock(WorkAdmission.WorkAdmission, { check: () => Effect.void }),
			),
			Layer.provide(
				Layer.mock(DelegationSessionModule.DelegationSession, {
					advance: () => Effect.die("The saved task must not start again."),
					continueWork: () =>
						Deferred.succeed(paused, undefined).pipe(
							Effect.andThen(Effect.never),
						),
				}),
			),
			Layer.provideMerge(base),
		)
		return {
			test,
			commands,
			key,
			firstOwner,
			taskKey,
			waits,
			firstWait,
			nextWait,
			paused,
			runtime,
		}
	})

	it.effect(
		"a delegation early wake waits again until the saved time limit",
		() =>
			Effect.gen(function* () {
				yield* TestClock.adjust("1 second")
				const test = yield* timedDelegation("delegation-early-wake")
				yield* Effect.gen(function* () {
					yield* DelegationWorkflow.workflow.execute(test.key, {
						discard: true,
					})
					yield* Deferred.await(test.firstWait)
					yield* TestClock.adjust("1 second")
					yield* test.test.store.wake(test.taskKey, "early-wake")
					yield* Deferred.await(test.nextWait)
					assert.deepEqual(yield* Ref.get(test.waits), [
						{ at: 1000, deadline: 4000 },
						{ at: 2000, deadline: 4000 },
					])
					assert.equal(
						(yield* test.commands.load(test.key)).stored.delegation.status,
						"running",
					)
					yield* TestClock.adjust("2 seconds")
					yield* Deferred.await(test.paused)
					const saved = (yield* test.commands.load(test.key)).stored.delegation
					assert.equal(saved.status, "paused")
					assert.equal(saved.pause?.limit, "time")
					assert.equal(saved.pause?.at, 4000)
					assert.equal(saved.usage?.timeMs, 3000)
				}).pipe(Effect.provide(test.runtime))
			}).pipe(
				Effect.provide(
					delegationLayer.pipe(Layer.provideMerge(TestClock.layer())),
				),
			),
	)

	it.effect(
		"a delegation takeover past its time limit pauses without another wait",
		() =>
			Effect.gen(function* () {
				const test = yield* timedDelegation("delegation-overdue-takeover")
				yield* TestClock.adjust("5 seconds")
				yield* Effect.gen(function* () {
					yield* DelegationWorkflow.workflow.execute(test.key, {
						discard: true,
					})
					yield* Deferred.await(test.paused)
					const saved = yield* test.commands.load(test.key)
					assert.isAbove(saved.execution.generation, test.firstOwner.generation)
					assert.deepEqual(yield* Ref.get(test.waits), [])
					assert.equal(yield* Clock.currentTimeMillis, 5000)
					assert.equal(saved.stored.delegation.status, "paused")
					assert.equal(saved.stored.delegation.pause?.limit, "time")
					assert.equal(saved.stored.delegation.pause?.at, 5000)
					assert.equal(saved.stored.delegation.usage?.timeMs, 5000)
				}).pipe(Effect.provide(test.runtime))
			}).pipe(
				Effect.provide(
					delegationLayer.pipe(Layer.provideMerge(TestClock.layer())),
				),
			),
	)

	for (const mode of [
		"complete",
		"cancel",
		"time limit",
		"steps limit",
		"close failure",
	] as const) {
		it.effect(
			`a delegation workflow can ${mode} through saved task events`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`delegation-workflow-${mode}`)
					const commands = yield* DelegationCommands.DelegationCommands
					const inputs = yield* InputCommands
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: (yield* test.submit("call")).executionId,
					})
					const receipt = yield* commands.submit(
						source,
						Execution.mainCall("call"),
						{
							...delegationInput,
							limits: {
								timeMs: mode === "time limit" ? 1000 : 3600000,
								...(mode === "steps limit" ? { steps: 3 } : {}),
							},
						},
					)
					const key = { namespace: source.namespace, id: receipt.executionId }
					const started = yield* Deferred.make<Store.Key>()
					const paused = yield* Deferred.make<void>()
					const allow = yield* Deferred.make<void>()
					const base = Layer.mergeAll(
						CallsModule.layer,
						Observation.layer,
						RunScope.layer.pipe(Layer.provide(Observation.layer)),
						Runner.layer.pipe(
							Layer.provide(
								Layer.mock(Billing, {
									releaseExecution: () => Effect.succeed(true),
								}),
							),
						),
					).pipe(
						Layer.provideMerge(Engine.layerRegistry),
						Layer.provideMerge(
							Records.layer.pipe(
								Layer.provide(
									Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
								),
							),
						),
						Layer.provideMerge(WorkflowEngine.layerMemory),
					)
					const runtime = DelegationWorkflow.layer.pipe(
						Layer.provide(
							Layer.mock(WorkAdmission.WorkAdmission, {
								check: () => Effect.void,
							}),
						),
						Layer.provide(
							Layer.mock(DelegationSessionModule.DelegationSession, {
								advance: (fence) =>
									Effect.gen(function* () {
										const receipt = yield* commands.start(fence)
										const child = {
											namespace: fence.namespace,
											id: receipt.executionId,
										}
										yield* Deferred.succeed(started, child)
										return { _tag: "Started" as const, key: child }
									}),
								continueWork: (fence) =>
									Effect.gen(function* () {
										yield* Deferred.succeed(paused, undefined)
										yield* Deferred.await(allow)
										const saved = yield* commands.load(fence)
										const control: PolicyOrigin.Control = {
											kind: "delegationLimit",
											epoch: saved.stored.limitEpoch!,
											turnExecutionId: saved.stored.limitTurnExecutionId!,
										}
										yield* commands.resume(fence, control)
										return { _tag: "Continued" as const, epoch: control.epoch }
									}),
							}),
						),
						Layer.provideMerge(base),
					)
					yield* Effect.gen(function* () {
						yield* DelegationWorkflow.workflow.execute(key, { discard: true })
						const taskKey = yield* Deferred.await(started).pipe(
							Effect.timeout("5 seconds"),
						)
						const task = yield* test.store.takeOver(taskKey)
						const chat = (yield* commands.load(key)).stored.delegation.chat!
						if (mode === "steps limit") {
							yield* saveTaskSteps(task, 3)
							yield* test.store.readAttempt(task, "next-model", {
								purpose: "turn",
							})
						}
						if (mode === "time limit" || mode === "steps limit") {
							yield* Deferred.await(paused).pipe(Effect.timeout("5 seconds"))
							const state = (yield* commands.load(key)).stored.delegation
							assert.equal(state.status, "paused")
							assert.equal(
								state.pause?.limit,
								mode === "time limit" ? "time" : "steps",
							)
						}
						if (mode === "cancel") {
							const saved = yield* test.store.loadMember(key)
							yield* test.store.cancel(
								key,
								Execution.CommandKey.make("stop"),
								saved.identity.actor,
							)
							const registration = Option.getOrThrow(
								yield* (yield* Registry).get(DelegationCommands.workflowName),
							)
							yield* registration.cancel(
								key,
								(yield* test.store.loadMember(key)).cancelEpoch,
							)
							yield* (yield* Observation.Observation).observe(taskKey, 0).pipe(
								Stream.filter(
									(event) =>
										event.body._tag === "State" &&
										event.body.status === "cancelling",
								),
								Stream.take(1),
								Stream.runDrain,
								Effect.timeout("5 seconds"),
							)
							assert.equal((yield* test.store.get(key)).status, "cancelling")
							yield* inputs.finish(task, chat, {
								status: "cancelled",
								epoch: (yield* test.store.loadMember(taskKey)).cancelEpoch,
							})
						} else {
							yield* test.chats.modifyEffect({
								chat,
								update: (view) =>
									TurnState.end(view, {
										turn: view.chat.turn!.id,
										completedAt: 1,
										items: [],
										status: Turn.Status.Completed({
											result: { text: "Done", finishReason: "stop" },
										}),
									}).pipe(
										Effect.map(
											({ mutation }) =>
												[undefined, Option.some(mutation)] as const,
										),
									),
							})
							yield* inputs.finish(
								task,
								chat,
								mode === "close failure"
									? {
											status: "failed",
											failure: {
												category: "external",
												errorId: Execution.ErrorId.make("close-failed"),
											},
										}
									: { status: "completed" },
							)
							yield* Deferred.succeed(allow, undefined)
						}
						yield* DelegationWorkflow.workflow
							.execute(key)
							.pipe(Effect.timeout("5 seconds"))
						const view = yield* commands.view(key)
						assert.equal(
							view.status,
							mode === "cancel"
								? "cancelled"
								: mode === "close failure"
									? "failed"
									: "completed",
						)
						if (mode === "close failure")
							assert.equal(view.failure?.errorId, "close-failed")
						if (mode !== "cancel" && mode !== "close failure")
							assert.equal(view.delegation.result, "Done")
					}).pipe(Effect.provide(runtime))
				}).pipe(Effect.provide(delegationLayer)),
		)
	}

	it.effect(
		"a one-use limit Grant belongs to one pause and to the task Bot",
		() =>
			Effect.gen(function* () {
				const permission = yield* Ref.make(true)
				yield* Effect.gen(function* () {
					const test = yield* setup("delegation-limit-grant")
					const commands = yield* DelegationCommands.DelegationCommands
					const session = yield* DelegationSessionModule.DelegationSession
					const grants = yield* Grants
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: (yield* test.submit("call")).executionId,
					})
					const receipt = yield* commands.submit(
						source,
						Execution.mainCall("call"),
						delegationInput,
					)
					const key = { namespace: source.namespace, id: receipt.executionId }
					const fence = yield* test.store.takeOver(key)
					const task = yield* commands.start(fence)
					const saved = yield* commands.load(key)
					const capability = {
						action: "delegations.continue" as const,
						target: saved.stored.delegation.id,
						arguments: { limit: "steps" },
					}
					yield* grants.create("org", {
						bot: BotFixture.bot.id,
						capability,
						effect: "allow",
						scope: "lifetime",
						grantedBy: { _tag: "Person", userId: "speaker" },
					})
					const grant = yield* grants.create("org", {
						bot: delegationInput.bot,
						capability,
						effect: "allow",
						scope: "once",
						grantedBy: { _tag: "Person", userId: "speaker" },
					})
					const control: PolicyOrigin.Control = {
						kind: "delegationLimit",
						turnExecutionId: task.executionId,
						epoch: 1,
					}
					yield* saveTaskSteps(
						{ namespace: key.namespace, id: task.executionId },
						3,
					)
					yield* commands.pause(fence, control)
					assert.deepEqual(yield* session.continueWork(fence), {
						_tag: "Continued",
						epoch: 1,
					})
					assert.equal(
						Option.getOrThrow(yield* grants.find("org", grant.id)).status,
						"used",
					)
					const restored = yield* test.store.takeOver(key)
					assert.deepEqual(yield* session.continueWork(restored), {
						_tag: "Continued",
						epoch: 1,
					})
					yield* saveTaskSteps(
						{ namespace: key.namespace, id: task.executionId },
						6,
					)
					yield* commands.pause(restored, { ...control, epoch: 2 })
					assert.equal((yield* session.continueWork(restored))._tag, "Approval")
					assert.equal((yield* commands.load(key)).stored.limitEpoch, 2)
				}).pipe(Effect.provide(delegationSessionLayer(permission)))
			}),
	)

	const appInput: AppCommands.Input = {
		source: {
			connectionId: ConnectionId.make("notes"),
			connectionName: "Notes",
			cardUrl: "https://app.example",
			appName: "Notes",
			remoteIndex: 0,
			revision: 1,
			kind: "tool",
			name: "write",
			definition: {},
		},
		arguments: { text: "private App input" },
		toolName: "notes_write",
		reason: "Keep the note",
	}
	const appLayer = AppCommands.layer.pipe(
		Layer.provide(
			Layer.mock(ActionPolicy, { isRead: () => Effect.succeed(false) }),
		),
		Layer.provide(
			Layer.mock(TurnAccess, {
				admit: () => Effect.void,
				authorize: () => Effect.void,
			}),
		),
		Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	)
	it.effect(
		"one accepted App command keeps its tool source across replay",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("app-command-submit")
				const apps = yield* AppCommands.AppCommands
				const child = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: child.executionId,
				})
				const site = Execution.mainCall("call")
				const first = yield* apps.submit(source, site, appInput)
				assert.deepEqual(yield* apps.submit(source, site, appInput), first)
				const key = { namespace: source.namespace, id: first.executionId }
				const saved = yield* apps.load(key)
				assert.equal(saved.origin.toolKey.id, child.executionId)
				assert.deepEqual(saved.sourceKey, {
					namespace: source.namespace,
					id: source.id,
				})
				assert.deepEqual(saved.input.arguments, appInput.arguments)
				assert.notEqual(String(saved.id), String(first.executionId))
				assert.ok(
					Schema.is(Execution.KeyConflict)(
						yield* apps
							.submit(source, site, {
								...appInput,
								arguments: { text: "Changed note" },
							})
							.pipe(Effect.flip),
					),
				)
				const next = yield* test.store.takeOver(source)
				assert.deepEqual(yield* apps.submit(next, site, appInput), first)
				yield* test.store.commit(next, { status: "completed" }, Effect.void)
				assert.deepEqual(yield* apps.submit(next, site, appInput), first)
				assert.equal(
					Arr.filter(
						yield* test.store.events(source, 0),
						(event) => event.body._tag === "ChildExecution",
					).length,
					1,
				)
				assert.ok(
					Schema.is(Execution.Forbidden)(
						yield* apps.submit(test.parent, site, appInput).pipe(Effect.flip),
					),
				)
			}).pipe(Effect.provide(appLayer)),
	)

	for (const race of ["two keys", "same key"] as const) {
		it.effect(
			`an App input answer commits once with ${race} and keeps its actor after takeover`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`app-command-input-${race}`)
					const apps = yield* AppCommands.AppCommands
					const child = yield* test.submit("call")
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: child.executionId,
					})
					const receipt = yield* apps.submit(
						source,
						Execution.mainCall("call"),
						appInput,
					)
					const key = { namespace: source.namespace, id: receipt.executionId }
					const fence = yield* test.store.takeOver(key)
					const phase = yield* apps.current(fence)
					assert.equal(phase._tag, "Send")
					if (phase._tag !== "Send")
						return assert.fail("Expected the first App call")
					const first = yield* test.store.writeAttempt(
						fence,
						AppCall.stepId(0),
						yield* Schema.encodeEffect(Schema.toCodecJson(AppCall.Input))(
							phase.input,
						),
					)
					yield* test.store.sending(fence, first.id)
					const request = {
						resultType: "input_required",
						requestState: "private round state",
						inputRequests: {
							consent: {
								method: "elicitation/create",
								params: {
									message: "Confirm the write",
									requestedSchema: {
										type: "object",
										properties: { confirmed: { type: "boolean" } },
										required: ["confirmed"],
									},
								},
							},
						},
					}
					yield* test.store.finishCall(
						fence,
						first.id,
						yield* Schema.encodeEffect(Schema.toCodecJson(AppCalls.Outcome))({
							_tag: "InputRequired",
							request,
						}),
					)
					assert.deepEqual(
						yield* apps.current(fence).pipe(Effect.map(Struct.omit(["call"]))),
						{ _tag: "Input", round: 1, request },
					)
					yield* test.store.requestDecision(
						fence,
						AppCommands.inputDecision(1),
						["allow"],
					)
					const actor: Caller = {
						kind: "user_token",
						organizationId: "org",
						userId: "owner",
						tokenId: TokenId.make("input-token"),
					}
					const responses = {
						consent: { action: "accept", content: { confirmed: true } },
					}
					assert.ok(
						Schema.is(Execution.Conflict)(
							yield* apps
								.respond(key, actor, Execution.CommandKey.make("wrong"), 1, {
									wrong: {},
								})
								.pipe(Effect.flip),
						),
					)
					let success = "answer-one"
					if (race === "same key") {
						const waiting = yield* Deferred.make<void>()
						const release = yield* Deferred.make<void>()
						const delayed = yield* Effect.gen(function* () {
							const app = yield* AppCommands.AppCommands
							return yield* app.respond(
								key,
								actor,
								Execution.CommandKey.make(success),
								1,
								responses,
							)
						}).pipe(
							Effect.provide(Layer.fresh(appLayer)),
							Effect.provideService(Store.Store, {
								...test.store,
								receipt: (...args) =>
									test.store.receipt(...args).pipe(
										Effect.tap(() => Deferred.succeed(waiting, undefined)),
										Effect.tap(() => Deferred.await(release)),
									),
							}),
							Effect.forkScoped,
						)
						yield* Deferred.await(waiting)
						const firstAnswer = yield* apps.respond(
							key,
							actor,
							Execution.CommandKey.make(success),
							1,
							responses,
						)
						yield* Deferred.succeed(release, undefined)
						assert.deepEqual(yield* Fiber.join(delayed), firstAnswer)
					} else {
						const submitted = yield* Effect.all(
							[
								apps
									.respond(
										key,
										actor,
										Execution.CommandKey.make("answer-one"),
										1,
										responses,
									)
									.pipe(Effect.result),
								apps
									.respond(
										key,
										actor,
										Execution.CommandKey.make("answer-two"),
										1,
										responses,
									)
									.pipe(Effect.result),
							],
							{ concurrency: "unbounded" },
						)
						assert.equal(
							Arr.filter(submitted, (result) => result._tag === "Success")
								.length,
							1,
						)
						success =
							submitted[0]!._tag === "Success" ? "answer-one" : "answer-two"
					}
					const next = yield* test.store.takeOver(fence)
					const resumed = yield* apps.current(next)
					assert.equal(resumed._tag, "Send")
					if (resumed._tag !== "Send")
						return assert.fail("Expected the next App call")
					assert.deepEqual(resumed.input.continuation, { request, responses })
					assert.deepEqual(Option.getOrThrow(resumed.answer), {
						actor,
						responses,
					})
					const second = yield* test.store.writeAttempt(
						next,
						AppCall.stepId(1),
						yield* Schema.encodeEffect(Schema.toCodecJson(AppCall.Input))(
							resumed.input,
						),
					)
					yield* test.store.sending(next, second.id)
					yield* test.store.finishCall(
						next,
						second.id,
						yield* Schema.encodeEffect(Schema.toCodecJson(AppCalls.Outcome))({
							_tag: "Completed",
							result: { saved: true },
						}),
					)
					assert.deepEqual(
						yield* apps.current(next).pipe(Effect.map(Struct.omit(["call"]))),
						{
							_tag: "Done",
							round: 1,
							result: { _tag: "Completed", result: { saved: true } },
						},
					)
					assert.deepEqual(
						Option.getOrThrow((yield* apps.first(next)).outcome),
						{ _tag: "InputRequired", request },
					)
					const repeated = yield* apps.respond(
						key,
						actor,
						Execution.CommandKey.make(success),
						1,
						responses,
					)
					assert.equal(repeated.executionId, key.id)
					assert.ok(
						Schema.is(Execution.KeyConflict)(
							yield* apps
								.respond(key, actor, Execution.CommandKey.make(success), 1, {
									consent: { action: "cancel" },
								})
								.pipe(Effect.flip),
						),
					)
					const events = yield* test.store.events(key, 0)
					assert.equal(
						Arr.filter(events, (event) => event.body._tag === "DecisionMade")
							.length,
						1,
					)
					assert.notInclude(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(Schema.Array(Execution.Event)),
						)(events),
						"private",
					)
				}).pipe(Effect.provide(appLayer)),
		)
	}
	for (const mode of [
		"current",
		"revoked",
		"connection changed",
		"definition changed",
		"target missing",
		"read rule changed",
		"input actor current",
		"input actor revoked",
	] as const) {
		it.effect(
			`an App send checks ${mode} state after opening its connection`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`app-send-${mode}`)
					const allowed = yield* Ref.make(true)
					const readOnly = yield* Ref.make(true)
					const sends = yield* Ref.make(0)
					const openedCount = yield* Ref.make(0)
					const released = yield* Ref.make(0)
					const secrets = yield* Secrets.Secrets
					const db = yield* Db.make
					const declaration = {
						name: "write",
						inputSchema: { type: "object" as const },
					}
					const input = {
						...appInput,
						source: { ...appInput.source, definition: declaration },
					}
					const owner = StoredConnections.ownerKey({
						organizationId: "org",
						userId: "owner",
					})
					const connection = {
						connection: ProtocolStore.UserConnection.make({
							owner,
							connectionId: input.source.connectionId,
							cardUrl: input.source.cardUrl,
							endpoint: "https://app.example/mcp",
							remoteIndex: 0,
							configuration: Redacted.make({}),
							headers: Redacted.make({}),
							state: "Enabled",
							authorization: { _tag: "Unprotected" },
						}),
						name: "Notes",
						revision: 1,
						verification: null,
					}
					const saveConnection = (revision: number) =>
						Effect.gen(function* () {
							const body = yield* secrets.seal(
								yield* Schema.encodeEffect(
									Schema.fromJsonString(
										Schema.toCodecJson(StoredConnections.StoredConnection),
									),
								)({ ...connection, revision }),
								yield* Schema.encodeEffect(
									Schema.fromJsonString(Schema.Array(Schema.String)),
								)(["connection", owner, input.source.connectionId]),
							)
							yield* db
								.insert(appConnections)
								.values({
									owner,
									id: input.source.connectionId,
									name: "Notes",
									revision,
									body,
								})
								.onConflictDoUpdate({
									target: [appConnections.owner, appConnections.id],
									set: { revision, body },
								})
						})
					yield* saveConnection(1)
					const appPolicy = Layer.succeed(ActionPolicy, {
						isRead: () => Ref.get(readOnly),
					})
					const allow = Policy.define(Authorization.OpenBot)(function* (_) {
						yield* _.allow("*", "*")
					})
					const auth = Authorizer.layer(Authorization.Auth, {
						policy: (caller) =>
							Effect.gen(function* () {
								const yes = yield* Ref.get(allowed)
								return yes ||
									(mode === "input actor revoked" &&
										caller.userId !== "input-user")
									? allow
									: Authorization.emptyPolicy
							}),
					})
					const appsLayer = AppCommands.layer.pipe(Layer.provide(appPolicy))
					const base = CallsModule.layer.pipe(
						Layer.provideMerge(Records.layer),
						Layer.provideMerge(Engine.layerRegistry),
						Layer.provideMerge(WorkflowEngine.layerMemory),
					)
					const sessionLayer = AppSessionModule.layer.pipe(
						Layer.provideMerge(appsLayer),
						Layer.provideMerge(base),
						Layer.provide(
							Layer.mergeAll(
								auth,
								appPolicy,
								Layer.mock(Bots, {}),
								Layer.mock(Vaults, {}),
								Layer.mock(Grants, {}),
								Layer.mock(RequestsModule.Requests, {}),
								BotRecordsModule.layer,
								Layer.mock(Rules, {}),
								Layer.mock(Billing, {}),
								Layer.mock(ModelRegistry, { defaultModel: Option.none() }),
								Layer.mock(RequestCommands, {
									submitted: () => Effect.succeedSome({ _tag: "Allowed" }),
								}),
								Layer.mock(TurnContext.TurnContext, {
									prepare: (frame) =>
										Effect.gen(function* () {
											return {
												...frame,
												bot: BotFixture.bot,
												chain: ChatHost.chainForHost(
													frame.host,
													frame.identity,
												),
												deciders: frame.host.chain.bots,
											}
										}),
								}),
								Layer.succeed(ConnectionSessions, {
									open: () =>
										Effect.gen(function* () {
											yield* Ref.update(openedCount, (n) => n + 1)
											yield* Effect.addFinalizer(() =>
												Ref.update(released, (n) => n + 1),
											)
											if (mode === "revoked" || mode === "input actor revoked")
												yield* Ref.set(allowed, false)
											if (mode === "read rule changed")
												yield* Ref.set(readOnly, false)
											if (mode === "connection changed")
												yield* saveConnection(2).pipe(Effect.orDie)
											return {
												stored: connection,
												client: {
													...({} as Client.Client),
													resolve: (target, source) => {
														assert.deepEqual(target, {
															kind: "tool",
															name: "write",
														})
														assert.equal(source, "host")
														return Effect.succeed(
															mode === "target missing"
																? Option.none()
																: Option.some({
																		kind: "tool" as const,
																		definition:
																			mode === "definition changed"
																				? {
																						...declaration,
																						description: "Changed tool",
																					}
																				: declaration,
																		invoke: () =>
																			Ref.update(sends, (n) => n + 1).pipe(
																				Effect.as({
																					_tag: "Completed" as const,
																					result: { content: [] },
																				}),
																			),
																		resume: (next, responses) =>
																			Effect.gen(function* () {
																				assert.equal(next.method, "tools/call")
																				assert.deepEqual(responses, {
																					consent: {
																						action: "accept",
																						content: { confirmed: true },
																					},
																				})
																				yield* Ref.update(sends, (n) => n + 1)
																				return {
																					_tag: "Completed" as const,
																					result: { content: [] },
																				}
																			}),
																	}),
														)
													},
												},
											}
										}),
								}),
							),
						),
						Layer.provide(
							Layer.mock(TurnAccess, {
								admit: () => Effect.void,
								authorize: () => Effect.void,
							}),
						),
					)
					yield* Effect.gen(function* () {
						const apps = yield* AppCommands.AppCommands
						const child = yield* test.submit("call")
						const source = yield* test.store.takeOver({
							namespace: test.key.namespace,
							id: child.executionId,
						})
						const receipt = yield* apps.submit(
							source,
							Execution.mainCall("call"),
							input,
						)
						const key = { namespace: source.namespace, id: receipt.executionId }
						yield* (yield* Registry).register(
							AppWorkflow.workflow,
							apps.authorize,
							apps.decide,
						)
						const fence = yield* test.store.takeOver(key)
						if (
							mode === "input actor current" ||
							mode === "input actor revoked"
						) {
							const first = yield* apps.current(fence)
							if (first._tag !== "Send")
								return assert.fail("Expected the first call")
							const call = yield* test.store.readAttempt(
								fence,
								AppCall.stepId(0),
								yield* Schema.encodeEffect(Schema.toCodecJson(AppCall.Input))(
									first.input,
								),
							)
							yield* test.store.sending(fence, call.id)
							const request = {
								resultType: "input_required",
								requestState: "private input state",
								inputRequests: {
									consent: {
										method: "elicitation/create",
										params: {
											message: "Confirm",
											requestedSchema: {
												type: "object",
												properties: { confirmed: { type: "boolean" } },
												required: ["confirmed"],
											},
										},
									},
								},
							}
							yield* test.store.finishCall(
								fence,
								call.id,
								yield* Schema.encodeEffect(
									Schema.toCodecJson(AppCalls.Outcome),
								)({ _tag: "InputRequired", request }),
							)
							yield* apps.waitInput(fence, 1)
							yield* apps.respond(
								key,
								{
									kind: "user_token",
									organizationId: "org",
									userId: "input-user",
									tokenId: TokenId.make("input-token"),
								},
								Execution.CommandKey.make("answer"),
								1,
								{ consent: { action: "accept", content: { confirmed: true } } },
							)
							yield* apps.phase(fence, "running")
						}
						const session = yield* (yield* AppSession).open(fence)
						assert.equal((yield* apps.load(fence)).input.readOnly, true)
						assert.equal((yield* session.permission)._tag, "Ready")
						const result = yield* Effect.scoped(session.send).pipe(
							Effect.result,
						)
						if (mode === "current" && result._tag === "Failure")
							return yield* Effect.fail(result.failure)
						assert.equal(
							result._tag,
							mode === "current" || mode === "input actor current"
								? "Success"
								: "Failure",
						)
						assert.equal(
							yield* Ref.get(sends),
							mode === "current" || mode === "input actor current" ? 1 : 0,
						)
						assert.equal(yield* Ref.get(openedCount), 1)
						assert.equal(yield* Ref.get(released), 1)
						if (mode === "current") {
							yield* Effect.scoped(session.send)
							assert.equal(yield* Ref.get(openedCount), 1)
							assert.equal(yield* Ref.get(sends), 1)
						}
					}).pipe(Effect.provide(sessionLayer))
				}).pipe(
					Effect.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				),
		)
	}

	for (const mode of [
		"complete",
		"input",
		"retry",
		"stop",
		"cancel",
		"known failure",
		"close failure",
		"late complete",
		"late input",
		"approval storage retry",
	] as const) {
		it.effect(
			`the App workflow can ${mode} and close its connection scope`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`app-workflow-${mode}`)
					const apps = yield* AppCommands.AppCommands
					const child = yield* test.submit("call")
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: child.executionId,
					})
					const receipt = yield* apps.submit(
						source,
						Execution.mainCall("call"),
						appInput,
					)
					const key = { namespace: source.namespace, id: receipt.executionId }
					const actor = (yield* test.store.loadMember(key)).identity.actor
					const approval =
						mode === "approval storage retry"
							? Option.some(
									yield* test.store.submit(
										key.namespace,
										Execution.CommandKey.make("approval"),
										{
											workflow: "openbot.capability-request",
											resource: { kind: "Request", id: "request" },
											identity: {
												...(yield* test.store.loadMember(key)).identity,
												parentExecutionId: key.id,
											},
											input: {},
										},
									),
								)
							: Option.none()
					const failPhase = yield* Ref.make(mode === "approval storage retry")

					const sends = yield* Ref.make(0)
					const open = yield* Ref.make(0)
					const sent = yield* Deferred.make<void>()
					const closed = yield* Deferred.make<void>()
					const releaseClose = yield* Deferred.make<void>()
					const session = Layer.effect(
						AppSession,
						Effect.gen(function* () {
							const adapter = yield* AppCall.make
							return AppSession.of({
								open: (fence) =>
									Effect.succeed({
										permission: Effect.gen(function* () {
											if (Option.isSome(approval)) {
												const request = {
													namespace: key.namespace,
													id: approval.value.executionId,
												}
												if (
													(yield* test.store.get(request)).status !==
													"completed"
												)
													return { _tag: "Approval", key: request } as const
											}
											return { _tag: "Ready" } as const
										}),
										send: Effect.gen(function* () {
											const phase = yield* apps.current(fence)
											if (phase._tag !== "Send") return
											yield* Effect.acquireRelease(
												Ref.update(open, (n) => n + 1),
												() =>
													Ref.update(open, (n) => n - 1).pipe(
														Effect.andThen(Deferred.succeed(closed, undefined)),
														Effect.andThen(
															mode === "close failure"
																? Deferred.await(releaseClose).pipe(
																		Effect.andThen(
																			Effect.die("private close failure"),
																		),
																	)
																: Effect.void,
														),
													),
											)
											yield* adapter.invoke(
												fence,
												phase.input,
												Effect.gen(function* () {
													const count = yield* Ref.updateAndGet(
														sends,
														(n) => n + 1,
													)
													yield* Deferred.succeed(sent, undefined)
													if (mode === "cancel") return yield* Effect.never
													if (
														(mode === "retry" ||
															mode === "stop" ||
															mode === "late complete" ||
															mode === "late input") &&
														count === 1
													)
														return yield* Client.ClientError.make({
															reason: "Network",
															issue: "The reply was lost",
														})
													if (mode === "known failure")
														return yield* Client.ToolFailure.make({
															result: {
																content: [
																	{ type: "text", text: "private App error" },
																],
																isError: true,
															},
														})
													if (mode === "input" && count === 1)
														return {
															_tag: "InputRequired" as const,
															result: {
																resultType: "input_required",
																requestState: "private round state",
																inputRequests: {
																	consent: {
																		method: "elicitation/create",
																		params: {
																			message: "Confirm",
																			requestedSchema: {
																				type: "object",
																				properties: {
																					confirmed: { type: "boolean" },
																				},
																				required: Arr.make("confirmed"),
																			},
																		},
																	},
																},
															},
															respond: () =>
																Effect.die("A new scope must resume this call"),
															handle: Effect.die(
																"A new scope must resume this call",
															),
														} satisfies Client.OperationResult<unknown>
													if (mode === "input")
														assert.deepEqual(
															phase.input.continuation?.responses,
															{
																consent: {
																	action: "accept",
																	content: { confirmed: true },
																},
															},
														)
													return {
														_tag: "Completed" as const,
														result: { private: "saved App result" },
													}
												}),
												Effect.void,
											)
										}).pipe(
											Effect.catchTag("SchemaError", (cause) =>
												Effect.fail(Execution.StorageError.make({ cause })),
											),
										),
									}),
							})
						}),
					)
					const base = Layer.mergeAll(
						CallsModule.layer,
						RunScope.layer.pipe(Layer.provide(Observation.layer)),
						Observation.layer,
						Runner.layer.pipe(
							Layer.provide(
								Layer.mock(Billing, {
									releaseExecution: () => Effect.succeed(true),
								}),
							),
						),
					).pipe(
						Layer.provideMerge(Engine.layerRegistry),
						Layer.provideMerge(
							Records.layer.pipe(
								Layer.provide(
									Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
								),
							),
						),
						Layer.provideMerge(WorkflowEngine.layerMemory),
					)
					const runtime = AppWorkflow.layer.pipe(
						Layer.provide(
							Layer.succeed(AppCommands.AppCommands, {
								...apps,
								phase: (fence, status) =>
									Effect.gen(function* () {
										if (
											status === "running" &&
											(yield* Ref.getAndSet(failPhase, false))
										)
											return yield* Execution.StorageError.make({
												cause: "The ready state could not be saved",
											})
										yield* apps.phase(fence, status)
										yield* apps.phase(fence, status)
									}),
							}),
						),
						Layer.provideMerge(session.pipe(Layer.provideMerge(base))),
					)
					yield* Effect.gen(function* () {
						const registered = Option.getOrThrow(
							yield* (yield* Registry).get(AppCommands.workflowName),
						)
						const observation = yield* Observation.Observation
						yield* AppWorkflow.workflow.execute(key, { discard: true })
						if (Option.isSome(approval)) {
							yield* observation.observe(key, 0).pipe(
								Stream.filter(
									(event) =>
										event.body._tag === "State" &&
										event.body.status === "waiting",
								),
								Stream.runHead,
								Effect.timeout("5 seconds"),
							)
							assert.equal(yield* Ref.get(open), 0)
							const child = yield* test.store.takeOver({
								namespace: key.namespace,
								id: approval.value.executionId,
							})
							yield* test.store.commit(
								child,
								{ status: "completed" },
								Effect.void,
							)
						}
						yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))
						if (mode === "cancel") {
							yield* test.store.cancel(
								key,
								Execution.CommandKey.make("cancel"),
								actor,
							)
							yield* registered.cancel(
								key,
								(yield* test.store.loadMember(key)).cancelEpoch,
							)
						}
						if (
							mode === "input" ||
							mode === "retry" ||
							mode === "stop" ||
							mode === "cancel" ||
							mode === "late complete" ||
							mode === "late input"
						) {
							const currentEpoch = (yield* test.store.loadMember(key))
								.cancelEpoch
							const event = Option.getOrThrow(
								yield* observation.observe(key, 0).pipe(
									Stream.filter(
										(event) =>
											event.body._tag === "DecisionNeeded" &&
											(currentEpoch === 0 ||
												Str.endsWith(`:cancel:${currentEpoch}`)(
													event.body.decisionId,
												)),
									),
									Stream.runHead,
									Effect.timeout("5 seconds"),
								),
							)
							if (event.body._tag !== "DecisionNeeded")
								return assert.fail("Expected a decision")
							yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))
							assert.equal(yield* Ref.get(open), 0)
							const decisionId = event.body.decisionId
							if (mode === "late complete" || mode === "late input") {
								const call = Arr.findFirst(
									yield* test.store.calls(key),
									(call) => Execution.callDecisionId(call.id) === decisionId,
								)
								const state = yield* test.store.loadMember(key)
								const result: AppCalls.Outcome =
									mode === "late complete"
										? { _tag: "Completed", result: { late: true } }
										: {
												_tag: "InputRequired",
												request: {
													resultType: "input_required",
													requestState: "late private input",
													inputRequests: {
														consent: {
															method: "elicitation/create",
															params: {
																message: "Confirm",
																requestedSchema: {
																	type: "object",
																	properties: {
																		confirmed: { type: "boolean" },
																	},
																	required: ["confirmed"],
																},
															},
														},
													},
												},
											}
								yield* test.store.finishCall(
									{ ...key, generation: state.generation },
									Option.getOrThrow(call).id,
									yield* Schema.encodeEffect(
										Schema.toCodecJson(AppCalls.Outcome),
									)(result),
								)
								assert.equal(
									(yield* test.store.get(key)).status,
									"outcome_unknown",
								)
							}
							if (mode === "input") {
								assert.ok(
									Schema.is(Execution.Conflict)(
										yield* apps
											.decide(key, actor, {
												commandKey: Execution.CommandKey.make("wrong-route"),
												decisionId,
												answer: "allow",
											})
											.pipe(Effect.flip),
									),
								)
								yield* apps.respond(
									key,
									actor,
									Execution.CommandKey.make("input-answer"),
									1,
									{
										consent: { action: "accept", content: { confirmed: true } },
									},
								)
							} else if (mode !== "late complete" && mode !== "late input")
								yield* apps.decide(key, actor, {
									commandKey: Execution.CommandKey.make("decision"),
									decisionId,
									answer: mode === "retry" ? "retry" : "stop",
								})
							if (mode !== "late complete" && mode !== "late input")
								yield* registered.signal(key, decisionId)
						}
						if (mode === "late input") {
							yield* observation.observe(key, 0).pipe(
								Stream.filter(
									(event) =>
										event.body._tag === "DecisionNeeded" &&
										event.body.decisionId === "input:1",
								),
								Stream.runHead,
								Effect.timeout("5 seconds"),
							)
							assert.equal(yield* Ref.get(sends), 1)
							yield* apps.respond(
								key,
								actor,
								Execution.CommandKey.make("late-answer"),
								1,
								{ consent: { action: "accept", content: { confirmed: true } } },
							)
							yield* registered.signal(key, "input:1")
						}
						if (mode === "close failure") {
							yield* Deferred.await(closed)
							assert.ok(Option.isNone((yield* apps.first(key)).outcome))
							yield* Deferred.succeed(releaseClose, undefined)
						}
						yield* AppWorkflow.workflow
							.execute(key)
							.pipe(Effect.timeout("5 seconds"))
						assert.equal(
							(yield* test.store.get(key)).status,
							mode === "known failure" || mode === "close failure"
								? "failed"
								: mode === "stop" || mode === "cancel"
									? "interrupted"
									: "completed",
						)
						assert.equal(
							yield* Ref.get(sends),
							mode === "input" || mode === "retry" || mode === "late input"
								? 2
								: 1,
						)
						if (mode === "close failure") {
							const outcome = Option.getOrThrow(
								(yield* apps.first(key)).outcome,
							)
							assert.equal(outcome._tag, "Failed")
							if (outcome._tag === "Failed")
								assert.deepEqual(
									outcome.failure,
									(yield* test.store.get(key)).failure,
								)
						}
						assert.equal(yield* Ref.get(open), 0)
						assert.notInclude(
							yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.Array(Execution.Event)),
							)(yield* test.store.events(key, 0)),
							"private",
						)
					}).pipe(Effect.provide(runtime))
				}).pipe(Effect.provide(appLayer)),
		)
	}

	it.effect(
		"nested workflows keep the accepted tool frame after the Turn ends",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-origin-frame")
				const origins = yield* ToolOrigins.make
				const tool = yield* test.submit("call")
				const toolKey = { namespace: test.key.namespace, id: tool.executionId }
				const toolFence = yield* test.store.takeOver(toolKey)
				const identity = (yield* test.store.loadMember(toolKey)).identity
				const submit = (
					source: Store.Fence,
					name: string,
					path: ReadonlyArray<string>,
				) =>
					test.store.accept(
						test.key.namespace,
						Execution.CommandKey.make(name),
						{
							actor: identity.actor,
							body: { name },
						},
						(create) =>
							Effect.gen(function* () {
								const key = yield* create({
									workflow: "test.nested",
									resource: { kind: name, id: name },
									identity,
									input: {},
								})
								yield* origins.attach(source, key, { main: "call", path })
								return { executionId: key.id, start: true }
							}),
					)
				const code = yield* submit(toolFence, "CodeRun", ["code"])
				const codeFence = yield* test.store.takeOver({
					namespace: toolKey.namespace,
					id: code.executionId,
				})
				const app = yield* submit(codeFence, "AppCall", ["code", "2"])
				const appKey = { namespace: toolKey.namespace, id: app.executionId }
				const appFence = yield* test.store.takeOver(appKey)
				assert.equal(
					(yield* submit(codeFence, "AppCall", ["code", "2"])).executionId,
					app.executionId,
				)
				const linked = Option.getOrThrow(yield* origins.find(appKey))
				assert.equal(linked.toolKey.id, tool.executionId)
				assert.deepEqual(linked.path, ["code", "2"])
				yield* test.store.commit(
					test.parent,
					{ status: "completed" },
					Effect.void,
				)
				yield* test.chats.modifyEffect({
					chat: test.position.chat,
					update: (view) =>
						TurnState.end(view, {
							turn: test.position.turn,
							status: Turn.Status.Completed({
								result: { text: "Done", finishReason: "stop" },
							}),
							completedAt: 1,
							items: [],
						}).pipe(
							Effect.map(
								({ mutation }) => [undefined, Option.some(mutation)] as const,
							),
						),
				})
				yield* test.store.commit(
					toolFence,
					{ status: "completed" },
					Effect.void,
				)
				const frame = yield* CallFrame.make.pipe(
					Effect.provideService(
						TurnAccess,
						TurnAccess.of({
							...({} as typeof TurnAccess.Service),
							authorize: () => Effect.void,
						}),
					),
				)
				const saved = yield* frame.read(appFence, {
					main: "call",
					path: ["code", "2", "send"],
				})
				assert.deepEqual(saved.position, test.position)
				assert.deepEqual(saved.identity, identity)
				assert.deepEqual(saved.callPath, ["call", "code", "2", "send"])
				assert.isTrue(Option.isNone(saved.call))
				assert.equal(saved.parent, test.parent.id)
				for (const site of [
					{ main: "one", path: ["code", "2"] },
					{ main: "call", path: ["code", "3"] },
					{ main: "call", path: [] },
				])
					assert.equal(
						(yield* frame.read(appFence, site).pipe(Effect.flip))._tag,
						"ExecutionConflict",
					)
			}),
	)

	it.effect(
		"tool origin writes share the command transaction and keep the source fence",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-origin-write")
				const origins = yield* ToolOrigins.make
				const tool = yield* test.submit("call")
				const key = { namespace: test.key.namespace, id: tool.executionId }
				const source = yield* test.store.takeOver(key)
				const identity = (yield* test.store.loadMember(key)).identity
				const child = yield* test.store.submit(
					key.namespace,
					Execution.CommandKey.make("child"),
					{
						workflow: "test.code",
						resource: { kind: "CodeRun", id: "code" },
						identity,
						input: {},
					},
				)
				const childKey = { namespace: key.namespace, id: child.executionId }
				const site = { main: "call", path: ["code"] }
				const rolledBack = yield* test.store
					.accept(
						key.namespace,
						Execution.CommandKey.make("rollback"),
						{
							actor: identity.actor,
							body: {},
						},
						() =>
							origins
								.attach(source, childKey, site)
								.pipe(Effect.andThen(Effect.fail("Rollback"))),
					)
					.pipe(Effect.flip)
				assert.equal(rolledBack, "Rollback")
				assert.isTrue(Option.isNone(yield* origins.find(childKey)))
				const fresh = yield* test.store.takeOver(source)
				assert.equal(
					(yield* origins.attach(source, childKey, site).pipe(Effect.flip))
						._tag,
					"ExecutionConflict",
				)
				assert.isTrue(Option.isNone(yield* origins.find(childKey)))
				yield* origins.attach(fresh, childKey, site)
				yield* origins.attach(fresh, childKey, site)
				assert.equal(
					(yield* origins
						.attach(fresh, childKey, { ...site, path: ["other"] })
						.pipe(Effect.flip))._tag,
					"ExecutionConflict",
				)
				const nested = yield* test.store.takeOver(childKey)
				const target = yield* test.store.submit(
					key.namespace,
					Execution.CommandKey.make("target"),
					{
						workflow: "test.app",
						resource: { kind: "AppCall", id: "app" },
						identity,
						input: {},
					},
				)
				const targetKey = { namespace: key.namespace, id: target.executionId }
				for (const denied of [
					{ main: "one", path: ["code"] },
					{ main: "call", path: ["other"] },
					{ main: "call", path: [] },
				])
					assert.equal(
						(yield* origins.attach(nested, targetKey, denied).pipe(Effect.flip))
							._tag,
						"ExecutionForbidden",
					)
				assert.isTrue(Option.isNone(yield* origins.find(targetKey)))
				yield* test.store.takeOver(targetKey)
				assert.equal(
					(yield* origins.attach(nested, targetKey, site).pipe(Effect.flip))
						._tag,
					"ExecutionConflict",
				)
			}),
	)

	it.effect("a tool origin cannot change the actor or cross a namespace", () =>
		Effect.gen(function* () {
			const test = yield* setup("tool-origin-identity")
			const origins = yield* ToolOrigins.make
			const tool = yield* test.submit("call")
			const key = { namespace: test.key.namespace, id: tool.executionId }
			const source = yield* test.store.takeOver(key)
			const identity = (yield* test.store.loadMember(key)).identity
			for (const [namespace, nextIdentity] of [
				[
					key.namespace,
					{ ...identity, actor: { kind: "member", ...identity.owner } },
				],
				["another-origin-space", identity],
			] as const) {
				const child = yield* test.store.submit(
					namespace,
					Execution.CommandKey.make("child"),
					{
						workflow: "test.code",
						resource: { kind: "CodeRun", id: "code" },
						identity: nextIdentity,
						input: {},
					},
				)
				const childKey = { namespace, id: child.executionId }
				assert.equal(
					(yield* origins
						.attach(source, childKey, Execution.mainCall("call"))
						.pipe(Effect.flip))._tag,
					"ExecutionForbidden",
				)
				assert.isTrue(Option.isNone(yield* origins.find(childKey)))
			}
			assert.equal(
				(yield* origins
					.attach(source, test.key, Execution.mainCall("call"))
					.pipe(Effect.flip))._tag,
				"ExecutionForbidden",
			)
			assert.equal(
				(yield* origins
					.attach(source, source, Execution.mainCall("call"))
					.pipe(Effect.flip))._tag,
				"ExecutionForbidden",
			)
		}),
	)
	it.effect("execution tools keep Chat access and cancel only once", () =>
		Effect.gen(function* () {
			const actor: Caller = {
				kind: "user_token",
				organizationId: "org",
				userId: "speaker",
				tokenId: TokenId.make("token"),
			}
			const test = yield* setup("tool-controls", actor)
			const child = yield* test.submit("call")
			const key = { namespace: test.parent.namespace, id: child.executionId }
			const other = yield* setup("tool-controls", actor, "another")
			const stranger = yield* other.submit("call")
			const context = Bot.Context.of({
				options: { prompt: Prompt.empty },
				at: Effect.succeed(
					Chat.position((yield* test.chats.read(test.position.chat)).chat),
				),
				turn: Effect.succeed(test.position.turn),
				step: Effect.succeed(0),
				history: Effect.succeed(Prompt.empty),
			})
			const attempts = yield* Ref.make(0)
			const flaky = Store.Store.of({
				...test.store,
				cancel: (...args) =>
					Effect.gen(function* () {
						if ((yield* Ref.getAndUpdate(attempts, (n) => n + 1)) === 0)
							return yield* Execution.StorageError.make({
								cause: "The cancel write failed once.",
							})
						return yield* test.store.cancel(...args)
					}),
			})
			yield* Effect.gen(function* () {
				const controls = yield* ToolControls.ToolControls
				const intent = yield* test.store.writeAttempt(
					test.parent,
					"control-race",
					{},
					"idempotent",
				)
				yield* test.store.sending(test.parent, intent.id)
				const registered = yield* controls.register(test.parent)
				const toolkit = yield* Toolkit.make(
					...Rec.values(registered.tools),
				).pipe(Effect.provideContext(registered.handlers))
				const invoke = (
					name: (typeof ToolControls.names)[keyof typeof ToolControls.names],
					input: Schema.Json,
				) =>
					toolkit.handle(name, input, "cancel-call").pipe(
						Effect.flatMap(Stream.runCollect),
						Effect.map((items) => items[0]?.result),
						Effect.provideService(CallContext, {
							fence: test.parent,
							id: intent.id,
						}),
					)
				const result = yield* invoke(ToolControls.names.status, {
					executionId: child.executionId,
				})
				assert.equal(
					(yield* Schema.decodeUnknownEffect(
						Schema.Struct({ status: Schema.String }),
					)(result)).status,
					"queued",
				)
				const denied = yield* invoke(ToolControls.names.status, {
					executionId: stranger.executionId,
				})
				assert.property(denied, "failure")
				const cancelled = yield* invoke(ToolControls.names.cancel, {
					executionId: child.executionId,
				})
				yield* invoke(ToolControls.names.cancel, {
					executionId: child.executionId,
				})
				assert.equal(yield* Ref.get(attempts), 3)
				assert.equal((yield* test.store.loadMember(key)).cancelEpoch, 1)
				assert.equal((yield* test.store.get(key)).status, "cancelling")
				const waited = yield* invoke(ToolControls.names.wait, {
					executionIds: [child.executionId],
					timeoutMs: 0,
				})
				assert.equal(
					(yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							executions: Schema.Array(
								Schema.Struct({ status: Schema.String }),
							),
						}),
					)(waited)).executions[0]?.status,
					"cancelling",
				)
				const allowed = yield* Advance
				yield* Ref.set(allowed, false)
				const revoked = yield* invoke(ToolControls.names.status, {
					executionId: child.executionId,
				}).pipe(Effect.ensuring(Ref.set(allowed, true)))
				assert.property(revoked, "failure")
				const childOwner = yield* test.store.takeOver(key)
				yield* test.store.finishCancellation(
					childOwner,
					(yield* test.store.loadMember(key)).cancelEpoch,
				)
				const next = yield* test.store.takeOver(test.parent)
				const rebuilt = yield* controls.register(next)
				const nextTools = yield* Toolkit.make(
					...Rec.values(rebuilt.tools),
				).pipe(Effect.provideContext(rebuilt.handlers))
				const ended = yield* nextTools
					.handle(
						ToolControls.names.cancel,
						{ executionId: child.executionId },
						"cancel-call",
					)
					.pipe(
						Effect.flatMap(Stream.runCollect),
						Effect.map((parts) => parts[0]?.result),
						Effect.provideService(CallContext, { fence: next, id: intent.id }),
					)
				assert.deepEqual(ended, cancelled)
				const output = yield* Schema.decodeUnknownEffect(Schema.Json)(cancelled)
				assert.isFalse(
					yield* test.store.finishCall(test.parent, intent.id, output),
				)
				assert.isTrue(
					yield* test.store.finishCall(
						next,
						intent.id,
						yield* Schema.decodeUnknownEffect(Schema.Json)(ended),
					),
				)
			}).pipe(
				Effect.provide(
					ToolControls.layer.pipe(
						Layer.provide(Layer.succeed(Store.Store, flaky)),
						Layer.provide(Observation.layer),
						Layer.provide(
							Records.layer.pipe(
								Layer.provide(
									Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
								),
							),
						),
					),
				),
				Effect.provideService(Bot.Context, context),
			)
		}),
	)

	it.effect("a Turn waits for the child scope and can replay its result", () =>
		Effect.gen(function* () {
			const test = yield* setup("turn-tool-result")
			const child = yield* test.tools.submit(
				test.parent,
				test.position,
				test.call("call"),
				{ ...settings, budget: "10 seconds" },
			)
			const key = { namespace: test.parent.namespace, id: child.executionId }
			const fence = yield* test.store.takeOver(key)
			const call = yield* test.store.writeAttempt(
				fence,
				ToolSteps.stepId(test.position.item, "call"),
				{
					value: "input",
				},
			)
			yield* test.store.sending(fence, call.id)
			const output = {
				id: "call",
				name: "send",
				result: { value: "saved result" },
				isFailure: false,
				preliminary: false,
			}
			const encoded = yield* Schema.encodeEffect(ToolSteps.outputCodec)(output)
			yield* test.store.finishCall(fence, call.id, encoded, [
				{
					_tag: "ToolOutput",
					step: ToolSteps.stepId(test.position.item, "call"),
					attempt: 0,
					output: encoded,
				},
			])
			// A helper with a higher attempt must not supply the tool result.
			const helper = yield* test.store.intent(fence, {
				step: "judge",
				attempt: 3,
				retry: "read_only",
				input: {},
			})
			yield* test.store.sending(fence, helper.id)
			yield* test.store.finishCall(fence, helper.id, { verdict: "allow" })
			const seenResult = yield* Deferred.make<void>()
			const parts = yield* Ref.make<
				ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>
			>([])
			const events = yield* Layer.build(Observation.layer)
			const observation = Context.get(events, Observation.Observation)
			const bridge = TurnTools.layer.pipe(
				Layer.provide(ToolSteps.layer),
				Layer.provide(
					Layer.succeed(Observation.Observation, {
						observe: (key, after) =>
							observation
								.observe(key, after)
								.pipe(
									Stream.tap((event) =>
										event.body._tag === "StepCompleted"
											? Deferred.succeed(seenResult, undefined)
											: Effect.void,
									),
								),
					}),
				),
			)
			const toolkit = yield* Toolkit.make(
				Tool.make("send", {
					parameters: Schema.Struct({ secret: Schema.String }),
					success: Schema.Json,
				}),
			).pipe(
				Effect.provide(
					Toolkit.make(
						Tool.make("send", {
							parameters: Schema.Struct({ secret: Schema.String }),
							success: Schema.Json,
						}),
					).toLayer({
						send: () => Effect.die("The parent must not send a child call."),
					}),
				),
			)
			yield* Effect.gen(function* () {
				const tools = yield* TurnTools.TurnTools
				const run = tools.run(
					test.parent,
					test.position,
					{ call: test.call("call"), toolkit },
					settings,
					(part) => Ref.update(parts, Arr.append(part)),
				)
				const waiting = yield* run.pipe(Effect.forkScoped)
				yield* Deferred.await(seenResult).pipe(Effect.timeout("5 seconds"))
				assert.deepStrictEqual(yield* Ref.get(parts), [])
				// Only this terminal commit proves that the child has released its resources.
				yield* test.tools.finish(fence, { status: "completed" })
				yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"))
				const first = yield* Ref.get(parts)
				assert.equal(first.length, 1)
				assert.equal(first[0]?.type, "tool-result")
				yield* Ref.set(parts, [])
				yield* run.pipe(Effect.timeout("5 seconds"))
				assert.deepStrictEqual(yield* Ref.get(parts), first)
			}).pipe(
				Effect.provide(
					bridge.pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
				),
			)
		}),
	)
	it.effect("a detached child gives the same reference after completion", () =>
		Effect.gen(function* () {
			const test = yield* setup("turn-tool-detach")
			const definition = Toolkit.make(
				Tool.make("send", {
					parameters: Schema.Struct({ secret: Schema.String }),
					success: Schema.Json,
				}),
			)
			const toolkit = yield* definition.pipe(
				Effect.provide(
					definition.toLayer({
						send: () => Effect.die("A child owns the handler."),
					}),
				),
			)
			const parts = yield* Ref.make<
				ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>
			>([])
			yield* Effect.gen(function* () {
				const tools = yield* TurnTools.TurnTools
				const run = tools.run(
					test.parent,
					test.position,
					{ call: test.call("call"), toolkit },
					settings,
					(part) => Ref.update(parts, Arr.append(part)),
				)
				yield* run
				const first = yield* Ref.get(parts)
				assert.equal(first.length, 1)
				const [child] = yield* test.tools.list(
					test.parent.namespace,
					test.position.chat,
				)
				if (child === undefined)
					return yield* Effect.die("The child is missing.")
				assert.isTrue(child.detached)
				const fence = yield* test.store.takeOver({
					namespace: test.parent.namespace,
					id: child.executionId,
				})
				yield* test.tools.finish(fence, { status: "interrupted" })
				yield* Ref.set(parts, [])
				yield* run
				assert.deepStrictEqual(yield* Ref.get(parts), first)
				const links = Arr.filter(
					yield* test.store.events(test.parent, 0),
					(event) => event.body._tag === "ChildExecution",
				)
				assert.equal(links.length, 1)
			}).pipe(
				Effect.provide(
					TurnTools.layer.pipe(
						Layer.provide(ToolSteps.layer),
						Layer.provide(Observation.layer),
					),
				),
			)
		}),
	)
	it.effect("closing a Turn observer does not cancel the child", () =>
		Effect.gen(function* () {
			const test = yield* setup("turn-tool-observer")
			const child = yield* test.tools.submit(
				test.parent,
				test.position,
				test.call("call"),
				{ ...settings, budget: "1 hour" },
			)
			const definition = Toolkit.make(
				Tool.make("send", {
					parameters: Schema.Struct({ secret: Schema.String }),
					success: Schema.Json,
				}),
			)
			const toolkit = yield* definition.pipe(
				Effect.provide(
					definition.toLayer({
						send: () => Effect.die("A child owns the handler."),
					}),
				),
			)
			const subscribed = yield* Deferred.make<void>()
			const events = yield* Layer.build(Observation.layer)
			const observation = Context.get(events, Observation.Observation)
			yield* Effect.gen(function* () {
				const tools = yield* TurnTools.TurnTools
				const waiting = yield* tools
					.run(
						test.parent,
						test.position,
						{ call: test.call("call"), toolkit },
						settings,
						() => Effect.void,
					)
					.pipe(Effect.forkScoped)
				yield* Deferred.await(subscribed).pipe(Effect.timeout("5 seconds"))
				yield* Fiber.interrupt(waiting)
				assert.equal(
					(yield* test.store.get({
						namespace: test.parent.namespace,
						id: child.executionId,
					})).status,
					"queued",
				)
			}).pipe(
				Effect.provide(
					TurnTools.layer.pipe(
						Layer.provide(ToolSteps.layer),
						Layer.provide(
							Layer.succeed(Observation.Observation, {
								observe: (key, after) =>
									observation
										.observe(key, after)
										.pipe(
											Stream.tap(() => Deferred.succeed(subscribed, undefined)),
										),
							}),
						),
					),
				),
			)
		}),
	)

	for (const initial of ["foreground", "child"] as const)
		it.effect(
			`a saved ${initial} call keeps its route after the annotation changes`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`turn-tool-route-${initial}`)
					const sent = yield* Ref.make(0)
					const makeToolkit = (foreground: boolean) => {
						const tool = Tool.make("send", {
							parameters: Schema.Struct({ secret: Schema.String }),
							success: Schema.Json,
						})
						const definition = Toolkit.make(
							foreground ? tool.annotate(Operation.Budget, "foreground") : tool,
						)
						return definition.pipe(
							Effect.provide(
								definition.toLayer({
									send: () =>
										Ref.update(sent, (n) => n + 1).pipe(
											Effect.as({ done: true }),
										),
								}),
							),
						)
					}
					const bridge = TurnTools.layer.pipe(
						Layer.provideMerge(ToolSteps.layer),
						Layer.provide(Observation.layer),
						Layer.provideMerge(
							CallsModule.layer.pipe(
								Layer.provideMerge(Engine.layerRegistry),
								Layer.provide(
									Records.layer.pipe(
										Layer.provide(
											Secrets.layer(
												Redacted.make("test:" + Str.repeat(32)("11")),
											),
										),
									),
								),
							),
						),
					)
					yield* Effect.gen(function* () {
						const registry = yield* Registry
						yield* registry.register(
							Engine.define("openbot.chat-turn"),
							() => Effect.void,
						)
						yield* registry.register(ToolWorkflow.workflow, () => Effect.void)
						const tools = yield* TurnTools.TurnTools
						const steps = yield* ToolSteps.ToolSteps
						const parts = yield* Ref.make<
							ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>
						>([])
						const publish = (
							part: Response.StreamPart<Record<string, Tool.Any>>,
						) => Ref.update(parts, Arr.append(part))
						const toolkit = yield* makeToolkit(initial === "foreground")
						yield* tools.run(
							test.parent,
							test.position,
							{ call: test.call("call"), toolkit },
							settings,
							publish,
						)
						const first = yield* Ref.get(parts)
						if (initial === "child") {
							const [child] = yield* test.tools.list(
								test.parent.namespace,
								test.position.chat,
							)
							if (child === undefined)
								return yield* Effect.die("The child is missing.")
							const fence = yield* test.store.takeOver({
								namespace: test.parent.namespace,
								id: child.executionId,
							})
							yield* steps.run(
								fence,
								test.position,
								{ call: test.call("call"), toolkit },
								() => Effect.void,
							)
							yield* test.tools.finish(fence, { status: "completed" })
						}
						yield* Ref.set(parts, [])
						yield* ToolStep.run({
							position: test.position,
							call: test.call("call"),
							toolkit: yield* makeToolkit(initial !== "foreground"),
							prompt: Prompt.empty,
							execute: tools.executor(test.parent, settings),
						}).pipe(Stream.runForEach(publish))
						assert.deepStrictEqual(yield* Ref.get(parts), first)
						const withoutTool = yield* ToolStep.run({
							position: test.position,
							call: test.call("call"),
							toolkit: yield* Toolkit.make(),
							prompt: Prompt.empty,
							execute: tools.executor(test.parent, settings),
						}).pipe(Stream.runCollect)
						assert.deepStrictEqual(withoutTool, first)
						assert.equal(yield* Ref.get(sent), 1)
						assert.equal(
							(yield* test.tools.list(
								test.parent.namespace,
								test.position.chat,
							)).length,
							initial === "child" ? 1 : 0,
						)
					}).pipe(
						Effect.provide(
							bridge.pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
						),
					)
				}),
		)
	it.effect(
		"a child detached while a Turn waits keeps its background answer",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-tool-detach-race")
				const occupied = yield* test.submit("one")
				yield* test.tools.detach(test.parent, occupied.executionId)
				const child = yield* test.submit("call")
				const subscribed = yield* Deferred.make<void>()
				const definition = Toolkit.make(
					Tool.make("send", {
						parameters: Schema.Struct({ secret: Schema.String }),
						success: Schema.Json,
					}),
				)
				const toolkit = yield* definition.pipe(
					Effect.provide(
						definition.toLayer({
							send: () => Effect.die("A child owns the handler."),
						}),
					),
				)
				const events = yield* Layer.build(Observation.layer)
				const observation = Context.get(events, Observation.Observation)
				yield* Effect.gen(function* () {
					const tools = yield* TurnTools.TurnTools
					const parts = yield* Ref.make<
						ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>
					>([])
					const run = tools.run(
						test.parent,
						test.position,
						{ call: test.call("call"), toolkit },
						settings,
						(part) => Ref.update(parts, Arr.append(part)),
					)
					const waiting = yield* run.pipe(Effect.forkScoped)
					yield* Deferred.await(subscribed).pipe(Effect.timeout("5 seconds"))
					assert.isFalse(
						(yield* test.tools.load({
							namespace: test.parent.namespace,
							id: child.executionId,
						})).record.detached,
					)
					yield* test.tools.finish(
						yield* test.store.takeOver({
							namespace: test.parent.namespace,
							id: occupied.executionId,
						}),
						{ status: "interrupted" },
					)
					assert.isTrue(
						(yield* test.tools.detach(test.parent, child.executionId)).detached,
					)
					yield* test.tools.finish(
						yield* test.store.takeOver({
							namespace: test.parent.namespace,
							id: child.executionId,
						}),
						{ status: "interrupted" },
					)
					yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"))
					const first = yield* Ref.get(parts)
					assert.equal(first.length, 1)
					const part = first[0]
					assert.ok(part?.type === "tool-result")
					assert.deepStrictEqual(part.encodedResult, {
						background: true,
						toolExecutionId: child.id,
						executionId: child.executionId,
					})
					yield* Ref.set(parts, [])
					yield* run
					assert.deepStrictEqual(yield* Ref.get(parts), first)
				}).pipe(
					Effect.provide(
						TurnTools.layer.pipe(
							Layer.provide(ToolSteps.layer),
							Layer.provide(
								Layer.succeed(Observation.Observation, {
									observe: (key, after) =>
										observation
											.observe(key, after)
											.pipe(
												Stream.tap(() =>
													Deferred.succeed(subscribed, undefined),
												),
											),
								}),
							),
						),
					),
				)
			}),
	)
	it.effect("only the current parent can stop attached children", () =>
		Effect.gen(function* () {
			const test = yield* setup("turn-child-cancel")
			const first = yield* test.submit("one")
			const second = yield* test.submit("two")
			yield* test.tools.detach(test.parent, second.executionId)
			const current = yield* test.store.takeOver(test.parent)
			const stale = yield* test.tools
				.stopAttached(test.parent)
				.pipe(Effect.flip)
			assert.equal(stale._tag, "ExecutionConflict")
			const actor = (yield* test.store.loadMember(current)).identity.actor
			yield* test.store.cancel(
				current,
				Execution.CommandKey.make("stop-parent"),
				actor,
			)
			for (let i = 0; i < 2; i++) yield* test.tools.stopAttached(current)
			assert.equal(
				(yield* test.store.get({
					namespace: current.namespace,
					id: first.executionId,
				})).status,
				"cancelling",
			)
			assert.equal(
				(yield* test.store.get({
					namespace: current.namespace,
					id: second.executionId,
				})).status,
				"queued",
			)
			const child = yield* test.store.loadMember({
				namespace: current.namespace,
				id: first.executionId,
			})
			assert.equal(child.cancelEpoch, 1)
			assert.equal((yield* test.store.get(current)).status, "cancelling")
		}),
	)
	it.effect("a new parent cancel sends a new child cancel command", () =>
		Effect.gen(function* () {
			const test = yield* setup("turn-child-recancel")
			const child = yield* test.submit("call")
			const key = { namespace: test.parent.namespace, id: child.executionId }
			const fence = yield* test.store.takeOver(key)
			const actor = (yield* test.store.loadMember(test.parent)).identity.actor
			const pending = yield* Effect.forEach([fence, test.parent], (owner) =>
				Effect.gen(function* () {
					const call = yield* test.store.writeAttempt(owner, "outside", {})
					yield* test.store.sending(owner, call.id)
					return { owner, call }
				}),
			)
			for (const epoch of [1, 2]) {
				yield* test.store.cancel(
					test.parent,
					Execution.CommandKey.make(`cancel-${epoch}`),
					actor,
				)
				yield* test.tools.stopAttached(test.parent)
				assert.equal((yield* test.store.loadMember(key)).cancelEpoch, epoch)
				assert.equal((yield* test.store.get(key)).status, "cancelling")
				if (epoch === 1) {
					// A decision can resume unknown work. The next cancel is a new command.
					for (const { owner, call } of pending) {
						assert.equal(
							yield* test.store.finishCancellation(owner, 1),
							"outcome_unknown",
						)
						yield* test.store.requestDecision(
							owner,
							Execution.callDecisionId(
								call.id,
								(yield* test.store.loadMember(owner)).cancelEpoch,
							),
							["retry", "stop"],
						)
						yield* test.store.decide(
							owner,
							Execution.CommandKey.make(`retry:${call.id}`),
							Execution.callDecisionId(
								call.id,
								(yield* test.store.loadMember(owner)).cancelEpoch,
							),
							"retry",
							actor,
						)
						yield* test.store.retryCall(owner, call.id)
					}
				}
			}
		}),
	)

	for (const outcome of [
		"completed",
		"release failed",
		"denied",
		"cancelled",
	] as const)
		it.effect(
			`a Turn end keeps child status and known results after ${outcome}`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`turn-end-children-${outcome}`)
					yield* test.chats.modifyEffect({
						chat: test.position.chat,
						update: (view) => {
							const turn = view.chat.turn
							if (turn?.pendingStep === undefined)
								return Effect.die("The pending step is missing.")
							return Effect.succeed([
								undefined,
								Option.some({
									chat: {
										turn: {
											...turn,
											pendingStep: {
												...turn.pendingStep,
												input: Prompt.empty,
												before: turn.pendingStep.input,
											},
										},
									},
								}),
							] as const)
						},
					})
					const known = yield* test.submit("one")
					const detached = yield* test.submit("two")
					yield* test.tools.detach(test.parent, detached.executionId)
					const child = yield* test.store.takeOver({
						namespace: test.parent.namespace,
						id: known.executionId,
					})
					if (outcome !== "denied") {
						const call = yield* test.store.writeAttempt(
							child,
							ToolSteps.stepId(test.position.item, "one"),
							{},
						)
						yield* test.store.sending(child, call.id)
						yield* test.store.finishCall(child, call.id, {
							id: "one",
							name: "send",
							result: "saved",
							isFailure: false,
							preliminary: false,
						})
					}

					const actor = (yield* test.store.loadMember(test.parent)).identity
						.actor
					yield* test.store.cancel(
						test.parent,
						Execution.CommandKey.make("cancel"),
						actor,
					)
					yield* Effect.gen(function* () {
						const commands = yield* InputCommands
						const end = commands.finish(test.parent, test.position.chat, {
							status: "cancelled",
							epoch: 1,
						})
						assert.equal(
							(yield* end.pipe(Effect.flip))._tag,
							"ExecutionConflict",
						)
						assert.equal(
							(yield* test.store.get(test.parent)).status,
							"cancelling",
						)
						const failure: Execution.Failure = {
							errorId: Execution.ErrorId.make("child-error"),
							category: outcome === "denied" ? "forbidden" : "unavailable",
						}
						if (outcome === "completed")
							yield* test.tools.finish(child, { status: "completed" })
						else if (outcome === "cancelled") {
							yield* test.store.cancel(
								child,
								Execution.CommandKey.make("stop-child"),
								actor,
							)
							yield* test.tools.finish(child, { status: "cancelled", epoch: 1 })
						} else
							yield* test.tools.finish(child, { status: "failed", failure })
						yield* end
						const history = ChatState.promptOf(
							yield* test.chats.items(test.position.chat),
						)
						assert.equal(ToolStep.pending(history).length, 0)
						const results = Arr.flatMap(history.content, (message) =>
							message.role === "tool" ? message.content : [],
						)
						const first = Arr.findFirst(
							results,
							(part) => part.type === "tool-result" && part.id === "one",
						)
						const second = Arr.findFirst(
							results,
							(part) => part.type === "tool-result" && part.id === "two",
						)
						assert.ok(
							Option.isSome(first) && first.value.type === "tool-result",
						)
						assert.ok(
							Option.isSome(second) && second.value.type === "tool-result",
						)
						if (outcome === "completed")
							assert.equal(first.value.result, "saved")
						else {
							assert.isTrue(first.value.isFailure)
							assert.deepStrictEqual(first.value.result, {
								executionId: known.executionId,
								status: outcome === "cancelled" ? "cancelled" : "failed",
								failure: outcome === "cancelled" ? null : failure,
								...(outcome === "denied"
									? {}
									: {
											knownResult: {
												id: "one",
												name: "send",
												result: "saved",
												isFailure: false,
												preliminary: false,
											},
										}),
							})
						}
						assert.deepStrictEqual(second.value.result, {
							background: true,
							toolExecutionId: detached.id,
							executionId: detached.executionId,
						})
						assert.equal(
							(yield* test.store.get(test.parent)).status,
							"cancelled",
						)
					}).pipe(
						Effect.provide(
							InputCommandsModule.layer.pipe(
								Layer.provide(
									Layer.mock(TurnAccess, {
										admit: () => Effect.void,
									}),
								),
							),
						),
					)
				}),
		)

	for (const mode of [
		"complete",
		"retry",
		"late",
		"stop",
		"cancel",
		"cancel late",
		"deadline",
	] as const)
		it.effect(`the tool workflow can ${mode} with closed scopes`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`tool-workflow-${mode}`)
				const receipt = yield* test.tools.submit(
					test.parent,
					test.position,
					test.call("one"),
					{
						...settings,
						maxDuration: mode === "deadline" ? "500 millis" : "1 hour",
					},
				)
				const key = { namespace: test.key.namespace, id: receipt.executionId }
				if (mode === "complete") {
					const fence = yield* test.store.takeOver(key)
					const helper = yield* test.store.intent(fence, {
						step: "judge",
						attempt: 3,
						retry: "read_only",
						input: {},
					})
					yield* test.store.sending(fence, helper.id)
					yield* test.store.finishCall(fence, helper.id, { verdict: "allow" })
					assert.isTrue(
						Schema.is(Execution.Conflict)(
							yield* test.tools
								.finish(fence, { status: "completed" })
								.pipe(Effect.flip),
						),
					)
				}
				const sends = yield* Ref.make(0)
				const builds = yield* Ref.make(0)
				const open = yield* Ref.make(0)
				const firstSend = yield* Deferred.make<void>()
				const firstClose = yield* Deferred.make<void>()
				const mockSession = Layer.effect(
					ToolSession.ToolSession,
					Effect.gen(function* () {
						const calls = yield* Calls
						return ToolSession.ToolSession.of({
							run: (fence) =>
								Effect.gen(function* () {
									yield* Ref.update(builds, (n) => n + 1)
									yield* Effect.acquireRelease(
										Ref.update(open, (n) => n + 1),
										() =>
											Ref.update(open, (n) => n - 1).pipe(
												Effect.andThen(Deferred.succeed(firstClose, undefined)),
											),
									)
									const call = yield* test.store.writeAttempt(
										fence,
										ToolSteps.stepId(test.position.item, "one"),
										{
											private: "input",
										},
									)
									const result = yield* calls.invoke(fence, call, () =>
										Effect.gen(function* () {
											const count = yield* Ref.updateAndGet(sends, (n) => n + 1)
											yield* Deferred.succeed(firstSend, undefined)
											if (
												mode === "cancel" ||
												mode === "cancel late" ||
												mode === "deadline"
											)
												return yield* Effect.never
											if (mode !== "complete" && count === 1)
												return yield* Effect.fail("The reply was lost")
											return { private: "result" }
										}),
									)
									if (result._tag === "Unknown")
										return yield* Execution.OutcomeUnknown.make({
											callId: result.callId,
										})
									return result.result
								}),
						})
					}),
				)
				const base = Layer.mergeAll(
					CallsModule.layer,
					Observation.layer,
					Runner.layer.pipe(
						Layer.provide(
							Layer.mock(Billing, {
								releaseExecution: () => Effect.succeed(true),
							}),
						),
					),
					RunScope.layer.pipe(Layer.provide(Observation.layer)),
				).pipe(
					Layer.provideMerge(Engine.layerRegistry),
					Layer.provideMerge(
						Records.layer.pipe(
							Layer.provide(
								Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
							),
						),
					),
					Layer.provideMerge(WorkflowEngine.layerMemory),
				)
				const services = ToolWorkflow.layer.pipe(
					Layer.provide(
						Layer.succeed(ToolCommands.ToolCommands, {
							...test.tools,
							authorize: () => Effect.void,
						}),
					),
					Layer.provideMerge(mockSession.pipe(Layer.provideMerge(base))),
				)
				yield* Effect.gen(function* () {
					const registry = yield* Registry
					const registered = yield* registry.get(ToolCommands.workflowName)
					assert.ok(Option.isSome(registered))
					yield* ToolWorkflow.workflow.execute(key, { discard: true })
					yield* Deferred.await(firstSend).pipe(Effect.timeout("5 seconds"))
					if (mode === "cancel" || mode === "cancel late") {
						yield* test.store.cancel(key, Execution.CommandKey.make("cancel"), {
							kind: "member",
							organizationId: "org",
							userId: "speaker",
						})
						const state = yield* test.store.loadMember(key)
						yield* registered.value.cancel(key, state.cancelEpoch)
					}
					if (mode !== "complete") {
						const call = yield* Effect.gen(function* () {
							while (true) {
								const [call] = yield* test.store.calls(key)
								if (call !== undefined) {
									const decision = yield* test.store.decision(
										key,
										Execution.callDecisionId(
											call.id,
											(yield* test.store.loadMember(key)).cancelEpoch,
										),
									)
									if (Option.isSome(decision)) return call
								}
								yield* Effect.sleep("10 millis")
							}
						}).pipe(Effect.timeout("5 seconds"))
						// The decision is saved before the work scope has closed.
						yield* Deferred.await(firstClose).pipe(Effect.timeout("5 seconds"))
						assert.equal(yield* Ref.get(open), 0)
						assert.equal((yield* test.store.get(key)).status, "outcome_unknown")
						if (mode === "late" || mode === "cancel late") {
							const current = yield* test.store.loadMember(key)
							yield* test.store.finishCall(
								{ ...key, generation: current.generation },
								call.id,
								{ private: "late result" },
							)
						}
						if (mode !== "late" && mode !== "cancel late") {
							const decisionId = Execution.callDecisionId(
								call.id,
								(yield* test.store.loadMember(key)).cancelEpoch,
							)
							yield* test.store.decide(
								key,
								Execution.CommandKey.make("answer"),
								decisionId,
								mode === "retry" ? "retry" : "stop",
								{ kind: "member", organizationId: "org", userId: "speaker" },
							)
							yield* registered.value.signal(key, decisionId)
						}
					}
					yield* ToolWorkflow.workflow
						.execute(key)
						.pipe(Effect.timeout("5 seconds"))
					assert.equal(
						(yield* test.store.get(key)).status,
						mode === "complete" || mode === "retry" || mode === "late"
							? "completed"
							: mode === "cancel late"
								? "cancelled"
								: "interrupted",
					)
					assert.equal(yield* Ref.get(sends), mode === "retry" ? 2 : 1)
					assert.equal(yield* Ref.get(open), 0)
					if (mode === "late") assert.equal(yield* Ref.get(builds), 2)
				}).pipe(Effect.provide(services))
			}),
		)
	it.effect(
		"a tool rebuilds its scope with the saved Turn and fresh rights",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-scope")
				const first = yield* test.submit("one")
				const second = yield* test.submit("two")
				const guardedChild = yield* test.submit("private")
				const key = { namespace: test.key.namespace, id: first.executionId }
				const builds = yield* Ref.make(0)
				const open = yield* Ref.make(0)
				const sends = yield* Ref.make(0)
				const allowed = yield* Ref.make(true)
				const gate = yield* Ref.make<"none" | "approval" | "dynamic">("none")
				const missing = yield* Ref.make(false)
				const entered = yield* Deferred.make<void>()
				const toolkit = Toolkit.make(
					Tool.make("send", {
						parameters: Schema.Struct({ secret: Schema.String }),
						success: Schema.Json,
					}),
				)
				const featureLayer = Layer.mock(ExecutionFeatures, {
					open: () => Effect.die("A saved tool must not build the tool list."),
					restore: () => Option.none(),
					restoreTool: (fence, frame, { host: register, policy }) =>
						Effect.gen(function* () {
							const host = yield* register
							assert.equal(frame.identity.actor.userId, "speaker")
							assert.equal(frame.turn, test.position.turn)
							assert.notEqual(fence.id, test.parent.id)
							assert.isFalse(policy.plan)
							if (yield* Ref.get(missing))
								return { ...host, tools: {}, handlers: Context.empty() }
							const current = frame
							const context = yield* Bot.Context
							assert.equal(yield* context.turn, test.position.turn)
							assert.equal(
								(yield* context.at.pipe(Effect.orDie)).chat,
								test.position.chat,
							)
							assert.equal(current.identity.actor.userId, "speaker")
							assert.equal(current.identity.owner.userId, "owner")
							yield* Ref.update(builds, (n) => n + 1)
							yield* Effect.acquireRelease(
								Ref.update(open, (n) => n + 1),
								() => Ref.update(open, (n) => n - 1),
							)
							const handlers = yield* Layer.build(
								toolkit.toLayer({
									send: ({ secret }, call) =>
										Effect.gen(function* () {
											yield* Ref.update(sends, (n) => n + 1)
											if (call.toolCallId === "two") {
												yield* Deferred.succeed(entered, undefined)
												return yield* Effect.never
											}
											return { turn: current.turn, secret }
										}),
								}),
							)
							return {
								...host,
								tools: {
									send: toolkit.tools.send.setNeedsApproval(
										(yield* Ref.get(gate)) === "approval"
											? true
											: () =>
													Ref.get(gate).pipe(
														Effect.map((state) => state === "dynamic"),
													),
									),
								},
								handlers,
							}
						}),
				})
				const realCalls = CallsModule.layer.pipe(
					Layer.provide(
						Layer.mock(Registry, {
							get: () =>
								Effect.succeedSome({
									authorize: () =>
										Ref.get(allowed).pipe(
											Effect.flatMap((yes) =>
												yes
													? Effect.void
													: Effect.fail(Execution.Forbidden.make({})),
											),
										),
									start: () => Effect.void,
									cancel: () => Effect.void,
									signal: () => Effect.void,
								}),
						}),
					),
					Layer.provide(Records.layer),
					Layer.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				)
				const sessionLayer = ToolSession.layer.pipe(
					Layer.provide(ToolSteps.layer),
					Layer.provide(realCalls),
					Layer.provide(
						TurnContext.layer.pipe(
							Layer.provide(
								Layer.mock(Bots, {
									find: () => Effect.succeedSome(BotFixture.bot),
									ownerChain: () => Effect.succeed([BotFixture.bot.id]),
								}),
							),
							Layer.provide(layerEveryoneAdministrator),
						),
					),
					Layer.provide(featureLayer),
					Layer.provide(HostTools.none),
					Layer.provide(Layer.mock(InputCommands, {})),
				)
				// Neither the new settings nor the new Turn may replace the accepted frame.
				const view = yield* test.chats.read(test.position.chat)
				const original = Option.getOrThrow(
					Option.fromUndefinedOr(view.chat.turn),
				)
				yield* test.store.transition(test.parent, "completed")
				yield* test.chats.modifyEffect({
					chat: test.position.chat,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: {
									turn: {
										...original,
										id: Turn.Id.make("next"),
										settings: { mode: "plan" },
									},
								},
							}),
						] as const),
				})
				yield* Effect.gen(function* () {
					const session = yield* ToolSession.ToolSession
					const firstFence = yield* test.store.takeOver(key)
					const result = yield* session.run(firstFence).pipe(Effect.scoped)
					assert.equal(yield* Ref.get(open), 0)
					const nextFence = yield* test.store.takeOver(key)
					yield* Ref.set(missing, true)
					assert.deepStrictEqual(
						yield* session.run(nextFence).pipe(Effect.scoped),
						result,
					)
					assert.equal(yield* Ref.get(builds), 1)
					assert.equal(yield* Ref.get(sends), 1)
					assert.equal(yield* Ref.get(open), 0)
					yield* Ref.set(allowed, false)
					assert.isTrue(
						Schema.is(Execution.Forbidden)(
							yield* session.run(nextFence).pipe(Effect.scoped, Effect.flip),
						),
					)
					assert.equal(yield* Ref.get(builds), 1)
					yield* Ref.set(allowed, true)
					yield* Ref.set(missing, false)
					const guarded = yield* test.store.takeOver({
						namespace: key.namespace,
						id: guardedChild.executionId,
					})
					for (const policy of ["approval", "dynamic"] as const) {
						yield* Ref.set(gate, policy)
						assert.isTrue(
							Schema.is(Execution.Forbidden)(
								yield* session.run(guarded).pipe(Effect.scoped, Effect.flip),
							),
						)
						assert.equal(yield* Ref.get(sends), 1)
						assert.equal(yield* Ref.get(open), 0)
						assert.equal(
							(yield* test.store.calls(guarded))[0]?.status,
							"intended",
						)
					}
					yield* Ref.set(gate, "none")
					yield* session.run(guarded).pipe(Effect.scoped)
					assert.equal(yield* Ref.get(sends), 2)
					const other = yield* test.store.takeOver({
						namespace: key.namespace,
						id: second.executionId,
					})
					const running = yield* session
						.run(other)
						.pipe(Effect.scoped, Effect.forkScoped)
					yield* Deferred.await(entered)
					assert.equal(yield* Ref.get(open), 1)
					yield* Fiber.interrupt(running)
					assert.equal(yield* Ref.get(open), 0)
					const beforeRecovery = yield* Ref.get(builds)
					yield* Ref.set(missing, true)
					const nextOwner = yield* test.store.takeOver(other)
					assert.isTrue(
						Schema.is(Execution.OutcomeUnknown)(
							yield* session.run(nextOwner).pipe(Effect.scoped, Effect.flip),
						),
					)
					assert.equal((yield* test.store.get(other)).status, "outcome_unknown")
					assert.equal(yield* Ref.get(builds), beforeRecovery)
				}).pipe(Effect.provide(sessionLayer))
			}),
	)

	for (const mode of ["deliver", "revoke", "cancel"] as const)
		it.effect(`a tool notice can ${mode} without a second Chat input`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`tool-notice-${mode}`)
				const child = yield* test.submit("one")
				yield* test.tools.detach(test.parent, child.executionId)
				const source = { namespace: test.key.namespace, id: child.executionId }
				const owner = yield* test.store.takeOver(source)
				const call = yield* test.store.writeAttempt(
					owner,
					ToolSteps.stepId(test.position.item, "one"),
					{},
				)
				yield* test.store.sending(owner, call.id)
				yield* test.store.finishCall(owner, call.id, {
					result: "private result",
				})
				const helper = yield* test.store.intent(owner, {
					step: "judge",
					attempt: 3,
					retry: "read_only",
					input: {},
				})
				yield* test.store.sending(owner, helper.id)
				yield* test.store.finishCall(owner, helper.id, {
					verdict: "helper result",
				})
				yield* test.tools.finish(owner, { status: "completed" })
				const [pending] = Arr.filter(
					yield* test.store.pending([ToolCommands.noticeWorkflowName]),
					(row) => row.namespace === test.key.namespace,
				)
				assert.ok(pending !== undefined)
				const key = {
					namespace: test.key.namespace,
					id: Execution.Id.make(pending.executionId),
				}
				const actor = (yield* test.store.loadMember(key)).identity.actor
				const allowed = yield* Ref.make(true)
				const check = Effect.gen(function* () {
					if (!(yield* Ref.get(allowed)))
						return yield* Execution.Forbidden.make({})
				})
				const base = Layer.mergeAll(
					Runner.layer.pipe(
						Layer.provide(
							Layer.mock(Billing, {
								releaseExecution: () => Effect.succeed(true),
							}),
						),
					),
					ToolNotices.layer,
				).pipe(
					Layer.provideMerge(
						InputCommandsModule.layer.pipe(
							Layer.provide(
								Layer.mock(TurnAccess, {
									admit: () => Effect.void,
									input: () => check,
									notice: () => check.pipe(Effect.as(true)),
								}),
							),
						),
					),
					Layer.provide(
						Layer.succeed(ToolCommands.ToolCommands, {
							...test.tools,
							authorize: () => check,
						}),
					),
					Layer.provideMerge(
						Records.layer.pipe(
							Layer.provide(
								Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
							),
						),
					),
					Layer.provideMerge(Engine.layerRegistry),
					Layer.provideMerge(WorkflowEngine.layerMemory),
				)
				const services = ToolNoticeWorkflow.layer.pipe(Layer.provideMerge(base))
				yield* Effect.gen(function* () {
					const notices = yield* ToolNotices.ToolNotices
					if (mode === "deliver") {
						const fence = yield* test.store.takeOver(key)
						const sql = yield* PgClient.PgClient
						const rollback = { _tag: "TestRollback" } as const
						yield* sql
							.withTransaction(
								notices
									.deliver(fence)
									.pipe(Effect.andThen(Effect.fail(rollback))),
							)
							.pipe(
								Effect.catchIf(
									(error) => error === rollback,
									() => Effect.void,
								),
							)
						assert.equal((yield* test.store.get(key)).status, "running")
						assert.equal(
							(yield* test.chats.read(test.position.chat)).chat.inbox.length,
							0,
						)
					} else if (mode === "revoke") {
						yield* Ref.set(allowed, false)
					} else {
						yield* test.store.cancel(
							key,
							Execution.CommandKey.make("cancel"),
							actor,
						)
					}
					yield* ToolNoticeWorkflow.workflow
						.execute(key)
						.pipe(Effect.timeout("5 seconds"))
					yield* ToolNoticeWorkflow.workflow.execute(key)
					assert.equal(
						(yield* test.store.get(key)).status,
						mode === "deliver"
							? "completed"
							: mode === "cancel"
								? "cancelled"
								: "failed",
					)
					const inbox = (yield* test.chats.read(test.position.chat)).chat.inbox
					assert.equal(inbox.length, mode === "deliver" ? 1 : 0)
					if (mode === "deliver") {
						assert.equal(inbox[0]?.notice?.ref, source.id)
						assert.equal(inbox[0]?.notice?.kind, "tool")
						const text = yield* Schema.encodeEffect(
							Schema.fromJsonString(Schema.Unknown),
						)(inbox[0])
						assert.include(text, "private result")
						assert.notInclude(text, "helper result")
					}
				}).pipe(Effect.provide(services))
			}),
		)
	it.effect("a finish reads the result saved between its two reads", () =>
		Effect.gen(function* () {
			const test = yield* setup("tool-result-between-reads")
			const child = yield* test.submit("one")
			const key = { namespace: test.key.namespace, id: child.executionId }
			const fence = yield* test.store.takeOver(key)
			const call = yield* test.store.writeAttempt(
				fence,
				ToolSteps.stepId(test.position.item, "one"),
				{},
			)
			yield* test.store.sending(fence, call.id)
			yield* test.store.finishCall(fence, call.id, { result: "saved result" })
			const reads = yield* Ref.make(0)
			const store = {
				...test.store,
				loadMember: Effect.fn(function* (key: Store.Key) {
					if (
						key.id === fence.id &&
						(yield* Ref.updateAndGet(reads, (n) => n + 1)) === 2
					)
						yield* test.tools.finish(fence, { status: "completed" })
					return yield* test.store.loadMember(key)
				}),
			}
			const result = yield* Effect.gen(function* () {
				const tools = yield* ToolCommands.ToolCommands
				return yield* tools.finish(fence, { status: "completed" })
			}).pipe(
				Effect.provide(
					Layer.fresh(ToolCommands.layer).pipe(
						Layer.provide(Layer.succeed(Store.Store, store)),
						Layer.provide(Layer.mock(TurnAccess, {})),
					),
				),
			)
			assert.isAtLeast(yield* Ref.get(reads), 2)
			assert.equal(result.status, "completed")
		}),
	)
	it.effect("a detached result and its one notice commit together", () =>
		Effect.gen(function* () {
			const test = yield* setup("tool-result-notice")
			const child = yield* test.submit("one")
			yield* test.tools.detach(test.parent, child.executionId)
			const key = { namespace: test.key.namespace, id: child.executionId }
			const fence = yield* test.store.takeOver(key)
			const call = yield* test.store.writeAttempt(
				fence,
				ToolSteps.stepId(test.position.item, "one"),
				{},
			)
			yield* test.store.sending(fence, call.id)
			yield* test.store.finishCall(fence, call.id, { result: "private result" })
			const sql = yield* PgClient.PgClient
			const notices = sql<{
				count: number
			}>`select count(*)::int as count from openbot_execution_outbox o join openbot_executions e on e.id = o.execution_id where e.namespace = ${key.namespace} and e.workflow = ${ToolCommands.noticeWorkflowName}`.pipe(
				Effect.map((rows) => rows[0]?.count),
			)
			yield* sql
				.withTransaction(
					test.tools
						.finish(fence, { status: "completed" })
						.pipe(Effect.andThen(Effect.fail("rollback"))),
				)
				.pipe(Effect.flip)
			assert.equal((yield* test.store.get(key)).status, "running")
			assert.equal(yield* notices, 0)
			const records = yield* Effect.all(
				Arr.makeBy(20, () => test.tools.finish(fence, { status: "completed" })),
				{ concurrency: "unbounded" },
			)
			assert.isTrue(
				Arr.every(records, (record) => record.status === "completed"),
			)
			assert.equal(yield* notices, 1)
			assert.equal(
				Arr.filter(
					yield* test.store.events(key, 0),
					(event) => event.body._tag === "Result",
				).length,
				1,
			)
			assert.isTrue(
				(yield* test.tools.detach(test.parent, child.executionId)).detached,
			)
		}),
	)
	for (const retry of ["never", "idempotent"] as const)
		it.effect(`a failed release lets an unknown ${retry} tool end`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`tool-release-failure-${retry}`)
				const child = yield* test.submit("one")
				const key = { namespace: test.key.namespace, id: child.executionId }
				const fence = yield* test.store.takeOver(key)
				const call = yield* test.store.writeAttempt(
					fence,
					ToolSteps.stepId(test.position.item, "one"),
					{},
					retry,
				)
				yield* test.store.sending(fence, call.id)
				yield* test.store.uncertain(fence, call.id)
				const actor = (yield* test.store.loadMember(fence)).identity.actor
				if (retry === "never")
					yield* test.store.decide(
						fence,
						Execution.CommandKey.make("retry"),
						Execution.callDecisionId(
							call.id,
							(yield* test.store.loadMember(fence)).cancelEpoch,
						),
						"retry",
						actor,
					)
				const failure = {
					errorId: Execution.ErrorId.make("close-error"),
					category: "unavailable",
				} as const
				yield* test.store.failPhase(fence, failure)
				if (retry === "idempotent")
					yield* test.store.decide(
						fence,
						Execution.CommandKey.make("stop"),
						Execution.callDecisionId(
							call.id,
							(yield* test.store.loadMember(fence)).cancelEpoch,
						),
						"stop",
						actor,
					)
				const record = yield* test.tools.finish(fence, {
					status: "interrupted",
				})
				assert.equal(record.status, "interrupted")
				assert.deepEqual(record.failure, failure)
			}),
		)
	it.effect("an unknown write cannot publish a final Chat notice", () =>
		Effect.gen(function* () {
			const test = yield* setup("tool-unknown-notice")
			const child = yield* test.submit("one")
			yield* test.tools.detach(test.parent, child.executionId)
			const key = { namespace: test.key.namespace, id: child.executionId }
			const fence = yield* test.store.takeOver(key)
			const call = yield* test.store.writeAttempt(
				fence,
				ToolSteps.stepId(test.position.item, "one"),
				{},
			)
			yield* test.store.sending(fence, call.id)
			assert.isTrue(
				Schema.is(Execution.Conflict)(
					yield* test.tools
						.finish(fence, { status: "interrupted" })
						.pipe(Effect.flip),
				),
			)
			const saved = yield* test.store.loadMember(fence)
			yield* test.store.cancel(
				key,
				Execution.CommandKey.make("cancel"),
				saved.identity.actor,
			)
			const record = yield* test.tools.finish(fence, {
				status: "cancelled",
				epoch: 1,
			})
			assert.equal(record.status, "outcome_unknown")
			const sql = yield* PgClient.PgClient
			const rows = yield* sql<{
				count: number
			}>`select count(*)::int as count from openbot_executions where namespace = ${key.namespace} and workflow = ${ToolCommands.noticeWorkflowName}`
			assert.equal(rows[0]?.count, 0)
			assert.equal((yield* test.store.calls(key))[0]?.status, "outcome_unknown")
		}),
	)

	it.effect(
		"new work checks current rights while a saved child can be read again",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-policy")
				const first = yield* test.submit("one")
				const allowed = yield* Advance
				yield* Effect.acquireRelease(Ref.set(allowed, false), () =>
					Ref.set(allowed, true),
				)
				assert.deepStrictEqual(yield* test.submit("one"), first)
				assert.strictEqual(
					(yield* test.submit("two").pipe(Effect.flip))._tag,
					"ExecutionForbidden",
				)
				assert.strictEqual(
					(yield* test.tools.list(test.key.namespace, test.position.chat))
						.length,
					1,
				)
			}),
	)
	it.effect("a child must match an open call in the saved Turn step", () =>
		Effect.gen(function* () {
			const test = yield* setup("tool-saved-call")
			assert.strictEqual(
				(yield* test.submit("not-saved").pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			assert.strictEqual(
				(yield* test.tools
					.submit(
						test.parent,
						test.position,
						test.call("call", "other input"),
						settings,
					)
					.pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			assert.strictEqual(
				(yield* test.tools
					.submit(
						test.parent,
						{ ...test.position, step: 1 },
						test.call("call"),
						settings,
					)
					.pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			const first = yield* test.submit("call")
			// A committed result can clear the pending step. Re-reading the child still works.
			const current = (yield* test.chats.read(test.position.chat)).chat.turn
			if (current === undefined)
				return yield* Effect.die("The test Turn is missing.")
			yield* test.chats.modifyEffect({
				chat: test.position.chat,
				update: () =>
					Effect.succeed([
						undefined,
						Option.some({
							chat: {
								turn: Struct.omit(current, ["pendingStep"]),
							},
						}),
					] as const),
			})
			assert.deepStrictEqual(yield* test.submit("call"), first)
			const saved = yield* test.tools.load({
				namespace: test.key.namespace,
				id: first.executionId,
			})
			assert.deepStrictEqual(
				saved.input.context.prompt,
				Turn.stepPrompt(
					Option.getOrThrow(Option.fromUndefinedOr(current.pendingStep)),
				),
			)
			assert.deepStrictEqual(saved.input.context.settings, current.settings)
			assert.equal(saved.record.position.turn, current.id)
			assert.strictEqual(
				(yield* test.submit("one").pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
		}),
	)

	it.effect(
		"a saved tool call has one child and one command under concurrent replay",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-replay")
				const records = yield* Effect.all(
					Arr.replicate(test.submit("call"), 20),
					{ concurrency: "unbounded" },
				)
				const first = Arr.headNonEmpty(records)
				for (const record of records) assert.deepStrictEqual(record, first)
				assert.isFalse(String(first.id) === String(first.executionId))
				assert.strictEqual(first.parentExecutionId, test.parent.id)
				const next = yield* test.store.takeOver(test.key)
				const replay = yield* test.tools.submit(
					next,
					test.position,
					test.call("call"),
					{ ...settings, maxDuration: "2 hours" },
				)
				assert.deepStrictEqual(replay, first)
				const saved = yield* test.tools.load({
					namespace: next.namespace,
					id: first.executionId,
				})
				assert.strictEqual(saved.input.maxDurationMs, 3_600_000)
				assert.deepStrictEqual(
					saved.identity,
					(yield* test.store.loadMember(test.key)).identity,
				)
				assert.strictEqual(
					(yield* test.tools.list(next.namespace, test.position.chat)).length,
					1,
				)
				const sql = yield* PgClient.PgClient
				// Check this call's row; a delivery batch can contain earlier tests' work.
				const commands =
					yield* sql`select command_id from openbot_execution_outbox
					where namespace = ${next.namespace} and execution_id = ${first.executionId}
					and sent_at is null`
				assert.lengthOf(commands, 1)
				const conflict = yield* test.tools
					.submit(next, test.position, test.call("call", "changed"), settings)
					.pipe(Effect.flip)
				assert.strictEqual(conflict._tag, "ExecutionKeyConflict")
			}),
	)
	it.effect("stale or cancelling parents cannot create tool work", () =>
		Effect.gen(function* () {
			const test = yield* setup("tool-fence")
			const next = yield* test.store.takeOver(test.key)
			assert.strictEqual(
				(yield* test.submit("stale").pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			yield* test.store.cancel(test.key, Execution.CommandKey.make("cancel"), {
				kind: "member",
				organizationId: "org",
				userId: "owner",
			})
			assert.strictEqual(
				(yield* test.tools
					.submit(next, test.position, test.call("cancelled"), settings)
					.pipe(Effect.flip))._tag,
				"ExecutionConflict",
			)
			assert.deepStrictEqual(
				yield* test.tools.list(next.namespace, test.position.chat),
				[],
			)
		}),
	)
	it.effect(
		"child records and outbox commands roll back with their parent transaction",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-rollback")
				const sql = yield* PgClient.PgClient
				yield* sql
					.withTransaction(
						test.submit("call").pipe(Effect.andThen(Effect.fail("rollback"))),
					)
					.pipe(Effect.flip)
				assert.deepStrictEqual(
					yield* test.tools.list(test.key.namespace, test.position.chat),
					[],
				)
				const records = yield* sql<{
					count: string
				}>`select count(*)::text as count from openbot_executions where namespace = ${test.key.namespace}`
				assert.strictEqual(records[0]?.count, "1")
				const commands = yield* test.store.pending([ToolCommands.workflowName])
				assert.isFalse(
					Arr.some(
						commands,
						(command) => command.namespace === test.key.namespace,
					),
				)
				const retried = yield* test.submit("call")
				assert.strictEqual(retried.status, "queued")
			}),
	)
	it.effect(
		"background slots are shared and a child can finish after its parent",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-detach")
				const children = yield* Effect.all(
					[test.submit("one"), test.submit("two")],
					{ concurrency: "unbounded" },
				)
				const moved = yield* Effect.forEach(
					children,
					(child) => test.tools.detach(test.parent, child.executionId),
					{ concurrency: "unbounded" },
				)
				assert.strictEqual(
					Arr.filter(moved, (record) => record.detached).length,
					1,
				)
				const running = Option.getOrThrow(
					Arr.findFirst(moved, (record) => record.detached),
				)
				const waiting = Option.getOrThrow(
					Arr.findFirst(moved, (record) => !record.detached),
				)
				const child = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: running.executionId,
				})
				yield* test.store.transition(child, "completed")
				assert.isTrue(
					(yield* test.tools.detach(test.parent, waiting.executionId)).detached,
				)
				yield* test.store.transition(test.parent, "completed")
				const other = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: waiting.executionId,
				})
				yield* test.store.transition(other, "completed")
				assert.strictEqual(
					(yield* test.tools.load(other)).record.status,
					"completed",
				)
			}),
	)
	it.effect(
		"a finished call and a foreground call cannot move to the background",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-foreground")
				const first = yield* test.tools.submit(
					test.parent,
					test.position,
					test.call("foreground"),
					settings,
					"foreground",
				)
				assert.isFalse(
					(yield* test.tools.detach(test.parent, first.executionId)).detached,
				)
				const finished = yield* test.submit("finished")
				const fence = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: finished.executionId,
				})
				yield* test.store.transition(fence, "completed")
				assert.isFalse(
					(yield* test.tools.detach(test.parent, finished.executionId))
						.detached,
				)
				const later = yield* test.tools.submit(
					test.parent,
					test.position,
					test.call("later"),
					{ ...settings, budget: "1 hour" },
				)
				assert.isFalse(
					(yield* test.tools.detach(test.parent, later.executionId)).detached,
				)
			}),
	)
	for (const answered of [false, true]) {
		it.effect(
			`a saved child decision yields a foreground tool only while pending: ${answered}`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`tool-decision-${answered}`)
					const tool = yield* test.tools.submit(
						test.parent,
						test.position,
						test.call("foreground"),
						settings,
						"foreground",
					)
					const key = { namespace: test.key.namespace, id: tool.executionId }
					const toolFence = yield* test.store.takeOver(key)
					const identity = (yield* test.store.loadMember(key)).identity
					const child = yield* test.store.submit(
						key.namespace,
						Execution.CommandKey.make("decision-child"),
						{
							workflow: "test.decision",
							resource: { kind: "AppCall", id: "decision-child" },
							identity,
							input: null,
						},
					)
					const childKey = { namespace: key.namespace, id: child.executionId }
					const childFence = yield* test.store.takeOver(childKey)
					yield* test.store.requestDecision(childFence, "answer", [
						"allow",
						"deny",
					])
					const waiting = { path: [childKey.id], decisionId: "answer" }
					assert.ok(
						Schema.is(Execution.Forbidden)(
							yield* test.tools
								.detach(test.parent, key.id, waiting)
								.pipe(Effect.flip),
						),
					)
					yield* test.store.commit(
						toolFence,
						{
							events: [
								{
									_tag: "ChildExecution",
									executionId: childKey.id,
									step: "approval",
								},
							],
						},
						Effect.void,
					)
					if (answered)
						yield* test.store.decide(
							childKey,
							Execution.CommandKey.make("answered"),
							"answer",
							"allow",
							identity.actor,
						)
					const moved = yield* test.tools.detach(test.parent, key.id, waiting)
					assert.equal(moved.detached, !answered)
					assert.deepEqual(
						yield* test.tools.detach(test.parent, key.id, waiting),
						moved,
					)
				}),
		)
	}
	it.effect(
		"tool input is sealed and child control uses the parent policy",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-private")
				const child = yield* test.submit("private")
				const key = { namespace: test.key.namespace, id: child.executionId }
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					input: string
					identity: string
				}>`select input, identity from openbot_executions where id = ${child.executionId}`
				assert.isFalse(Str.includes("private tool input")(rows[0]?.input ?? ""))
				assert.isFalse(Str.includes("speaker")(rows[0]?.identity ?? ""))
				const result = yield* test.tools
					.authorize(
						key,
						{ kind: "member", organizationId: "org", userId: "owner" },
						"cancel",
					)
					.pipe(Effect.flip)
				assert.strictEqual(result._tag, "ExecutionForbidden")
			}),
	)
	it.effect("Code commands keep read failures and reject an old owner", () =>
		Effect.gen(function* () {
			const test = yield* setup("code-read-failure")
			const readable = yield* Ref.make(false)
			const runtime = CodeProgram.layer.pipe(
				Layer.provideMerge(CodeCommands.layer),
				Layer.provide(Layer.mock(AppCommands.AppCommands, {})),
				Layer.provide(Layer.mock(Vaults, {})),
				Layer.provide(
					Layer.mock(TurnAccess, {
						admit: () => Effect.void,
						authorize: () => Effect.void,
					}),
				),
				Layer.provide(
					Layer.mock(SettingsService, {
						platform: Effect.gen(function* () {
							if (!(yield* Ref.get(readable)))
								return yield* SettingsApi.SettingsUnavailable.make({})
							return Option.some({
								document: {
									publicOrigin: "https://openbot.example",
									authSecret: "test",
									identityProvider: null,
									organizationCreation: "anyone" as const,
									ceiling: Authorization.emptyPolicy,
									appRestrictions: [],
									codeMode: { ...SettingsApi.codeModeDefaults, enabled: true },
								},
								version: 1,
								updatedAt: 0,
							})
						}),
					}),
				),
				Layer.provideMerge(Layer.merge(CallsModule.layer, Observation.layer)),
				Layer.provideMerge(Engine.layerRegistry),
				Layer.provideMerge(Records.layer),
				Layer.provideMerge(WorkflowEngine.layerMemory),
				Layer.provide(SandboxModule.layer),
				Layer.provide(
					Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
				),
			)
			yield* Effect.gen(function* () {
				const code = yield* CodeCommands.CodeCommands
				const runner = yield* CodeProgram.CodeProgram
				yield* (yield* Registry).register(
					CodeWorkflow.workflow,
					code.authorize,
					code.decide,
				)
				const tool = yield* test.submit("call")
				const source = yield* test.store.takeOver({
					namespace: test.key.namespace,
					id: tool.executionId,
				})
				const input = {
					code: "return 1",
					reason: "Check the program",
					bindings: [],
					vault: [],
				}
				const submit = code.submit(source, Execution.mainCall("call"), input)
				const failed = yield* submit.pipe(Effect.flip)
				assert.equal(failed._tag, "ExecutionStorageError")
				assert.equal(
					(yield* code.enabled.pipe(Effect.flip))._tag,
					"SettingsUnavailable",
				)
				assert.equal(
					Arr.filter(
						yield* test.store.events(source, 0),
						(event) => event.body._tag === "ChildExecution",
					).length,
					0,
				)
				yield* Ref.set(readable, true)
				const receipt = yield* submit
				const key = { namespace: source.namespace, id: receipt.executionId }
				const first = yield* test.store.takeOver(key)
				yield* Ref.set(readable, false)
				const failure = yield* runner.run(first).pipe(Effect.flip)
				assert.isTrue(Schema.is(Execution.Failure)(failure))
				if (!Schema.is(Execution.Failure)(failure))
					return assert.fail("Expected a safe failure")
				assert.equal(failure.category, "external")
				assert.isNotEmpty(failure.errorId)
				assert.equal((yield* test.store.get(key)).status, "running")
				assert.isTrue(Option.isNone(yield* code.result(key)))
				yield* Ref.set(readable, true)
				const next = yield* test.store.takeOver(key)
				assert.equal(
					(yield* code.phase(first, "waiting").pipe(Effect.flip))._tag,
					"ExecutionConflict",
				)
				assert.deepEqual(yield* runner.run(next), {
					_tag: "Completed",
					value: 1,
					logs: [],
				})
				assert.equal(
					(yield* code.finish(first, { status: "completed" }).pipe(Effect.flip))
						._tag,
					"ExecutionConflict",
				)
				assert.equal((yield* test.store.get(key)).status, "running")
				yield* code.finish(next, { status: "completed" })
				assert.equal((yield* test.store.get(key)).status, "completed")
			}).pipe(Effect.provide(runtime), Effect.scoped)
		}),
	)
	for (const mode of [
		"complete",
		"restart",
		"changed call",
		"missing call",
		"input",
		"rejected",
		"submit storage retry",
		"result storage retry",
	] as const) {
		it.effect(`Code Mode can ${mode} with shared call records`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`code-program-${mode}`)
				const starts = yield* Ref.make(0)
				const closed = yield* Ref.make(0)
				const real = yield* SandboxModule.make
				const sandbox = Layer.succeed(SandboxModule.Sandbox, {
					run: (program, answer) =>
						Effect.gen(function* () {
							const count = yield* Ref.updateAndGet(starts, (n) => n + 1)
							if (mode === "changed call" || mode === "missing call") {
								if (mode === "missing call" && count > 1)
									return { _tag: "Done" as const, value: null, logs: [] }
								const result = yield* answer([
									{
										index: 0,
										binding: "notes.write",
										arguments: count === 1 ? "{}" : '{"changed":true}',
									},
								])
								return Option.isNone(result)
									? { _tag: "Stopped" as const }
									: { _tag: "Done" as const, value: null, logs: [] }
							}
							return yield* real.run(program, answer)
						}).pipe(Effect.ensuring(Ref.update(closed, (n) => n + 1))),
				})
				const failOnce = yield* Ref.make(true)
				const appCommands = Layer.effect(
					AppCommands.AppCommands,
					Effect.gen(function* () {
						const original = yield* AppCommands.AppCommands
						return AppCommands.AppCommands.of({
							...original,
							submit: (...args) =>
								Effect.gen(function* () {
									const result = yield* original.submit(...args)
									if (
										mode === "submit storage retry" &&
										(yield* Ref.getAndSet(failOnce, false))
									)
										return yield* Execution.StorageError.make({
											cause: "The command reply was lost",
										})
									return result
								}),
							first: (key) =>
								Effect.gen(function* () {
									const result = yield* original.first(key)
									if (
										mode === "result storage retry" &&
										Option.isSome(result.outcome) &&
										(yield* Ref.getAndSet(failOnce, false))
									)
										return yield* Execution.StorageError.make({
											cause: "The App result could not be read",
										})
									return result
								}),
						})
					}),
				).pipe(Layer.provide(AppCommands.layer))
				const commands = Layer.mergeAll(CodeCommands.layer, appCommands).pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.mock(TurnAccess, {
								admit: () => Effect.void,
								authorize: () => Effect.void,
							}),
							Layer.succeed(ActionPolicy, {
								isRead: () => Effect.succeed(true),
							}),
							Layer.mock(Vaults, { usable: () => Effect.succeed([]) }),
							Layer.mock(SettingsService, {
								platform: Effect.succeedSome({
									document: {
										publicOrigin: "https://openbot.example",
										authSecret: "test",
										identityProvider: null,
										organizationCreation: "anyone" as const,
										ceiling: Authorization.emptyPolicy,
										appRestrictions: [],
										codeMode: {
											...SettingsApi.codeModeDefaults,
											enabled: true,
										},
									},
									version: 1,
									updatedAt: 0,
								}),
							}),
						),
					),
				)
				const base = Layer.mergeAll(CallsModule.layer, Observation.layer).pipe(
					Layer.provideMerge(Engine.layerRegistry),
					Layer.provideMerge(Records.layer),
					Layer.provideMerge(WorkflowEngine.layerMemory),
				)
				const runtime = CodeProgram.layer.pipe(
					Layer.provide(Layer.mock(Vaults, {})),
					Layer.provideMerge(commands),
					Layer.provideMerge(base),
					Layer.provide(sandbox),
					Layer.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				)
				yield* Effect.gen(function* () {
					const code = yield* CodeCommands.CodeCommands
					const apps = yield* AppCommands.AppCommands
					const registry = yield* Registry
					yield* registry.register(
						CodeWorkflow.workflow,
						code.authorize,
						code.decide,
					)
					yield* registry.register(
						AppWorkflow.workflow,
						apps.authorize,
						apps.decide,
					)
					const tool = yield* test.submit("call")
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: tool.executionId,
					})
					const input = {
						code:
							mode === "rejected"
								? 'try { await apps.call("missing", {}); } catch (error) { return error.name; }'
								: mode === "input"
									? "try { await apps.notes.write({}); } catch (error) { return error.name; }"
									: "return await apps.notes.write({ random: Math.random(), clock: Date.now() });",
						reason: "Read notes",
						vault: [],
						bindings: [
							{
								alias: "notes.write",
								source: {
									...appInput.source,
									definition: {
										name: "write",
										inputSchema: { type: "object" },
									},
								},
							},
						],
					}
					const receipt = yield* code.submit(
						source,
						Execution.mainCall("call"),
						input,
					)
					assert.deepEqual(
						yield* code.submit(source, Execution.mainCall("call"), input),
						receipt,
					)
					assert.ok(
						Schema.is(Execution.KeyConflict)(
							yield* code
								.submit(source, Execution.mainCall("call"), {
									...input,
									code: "return 1",
								})
								.pipe(Effect.flip),
						),
					)
					const key = { namespace: source.namespace, id: receipt.executionId }
					const fence = yield* test.store.takeOver(key)
					const runner = yield* CodeProgram.CodeProgram
					let fiber = yield* Effect.forkScoped(runner.run(fence))
					if (mode === "rejected") {
						const result = yield* Fiber.join(fiber)
						assert.deepEqual(result, {
							_tag: "Completed",
							value: "TypeError",
							logs: [],
						})
						assert.equal(
							Arr.filter(
								yield* test.store.events(key, 0),
								(event) => event.body._tag === "ChildExecution",
							).length,
							0,
						)
						return
					}
					const observation = yield* Observation.Observation
					const event = Option.getOrThrow(
						yield* observation.observe(key, 0).pipe(
							Stream.filter((event) => event.body._tag === "ChildExecution"),
							Stream.runHead,
							Effect.timeout("5 seconds"),
						),
					)
					if (event.body._tag !== "ChildExecution")
						return assert.fail("Expected an App child")
					const appKey = {
						namespace: key.namespace,
						id: event.body.executionId,
					}
					yield* observation.observe(key, 0).pipe(
						Stream.filter(
							(event) =>
								event.body._tag === "State" && event.body.status === "waiting",
						),
						Stream.runHead,
						Effect.timeout("5 seconds"),
					)
					assert.equal(yield* Ref.get(closed), 1)
					let next = fence
					const restart =
						mode === "restart" ||
						mode === "changed call" ||
						mode === "missing call" ||
						mode === "input"
					if (restart) {
						yield* Fiber.interrupt(fiber)
						next = yield* test.store.takeOver(key)
					}
					const appFence = yield* test.store.takeOver(appKey)
					const first = yield* apps.current(appKey)
					if (first._tag !== "Send") return assert.fail("Expected a send")
					const call = yield* test.store.readAttempt(
						appFence,
						AppCall.stepId(0),
						yield* Schema.encodeEffect(Schema.toCodecJson(AppCall.Input))(
							first.input,
						),
					)
					yield* test.store.sending(appFence, call.id)
					const answer: AppCalls.Outcome =
						mode === "input"
							? {
									_tag: "InputRequired",
									request: {
										resultType: "input_required",
										requestState: "private state",
										inputRequests: {},
									},
								}
							: { _tag: "Completed", result: first.input.arguments }
					yield* test.store.finishCall(
						appFence,
						call.id,
						yield* Schema.encodeEffect(Schema.toCodecJson(AppCalls.Outcome))(
							answer,
						),
					)
					if (mode === "input") {
						assert.ok(Option.isNone((yield* apps.first(appKey)).outcome))
						yield* apps.waitInput(appFence, 1)
					} else yield* apps.finish(appFence, { status: "completed" })
					if (restart) fiber = yield* Effect.forkScoped(runner.run(next))
					const result = yield* Fiber.join(fiber).pipe(
						Effect.timeout("5 seconds"),
					)
					if (mode === "changed call" || mode === "missing call") {
						assert.equal(result._tag, "Failed")
						if (result._tag === "Failed")
							assert.equal(result.reason, "ReplayMismatch")
					} else {
						assert.equal(result._tag, "Completed")
						if (result._tag === "Completed")
							assert.deepEqual(
								result.value,
								mode === "input" ? "AppInputRequired" : first.input.arguments,
							)
					}
					assert.equal(
						Arr.filter(
							yield* test.store.events(key, 0),
							(event) => event.body._tag === "ChildExecution",
						).length,
						1,
					)
					assert.equal(
						Arr.filter(
							yield* test.store.calls(appKey),
							(call) => call.step === AppCall.stepId(0),
						).length,
						1,
					)
					const count = yield* Ref.get(starts)
					assert.deepEqual(yield* runner.run(next), result)
					assert.equal(yield* Ref.get(starts), count)
					if (mode === "input")
						assert.equal((yield* test.store.get(appKey)).status, "waiting")
					const view = yield* code.view(key)
					assert.deepEqual(view.result, result)
				}).pipe(Effect.provide(runtime), Effect.scoped)
			}),
		)
	}

	for (const mode of ["complete", "cancel child", "replay mismatch"] as const) {
		it.effect(`the Code workflow can ${mode} after its App child`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`code-workflow-${mode}`)
				const starts = yield* Ref.make(0)
				const real = yield* SandboxModule.make
				const sandbox = Layer.succeed(SandboxModule.Sandbox, {
					run: (program, answer) =>
						Effect.gen(function* () {
							const count = yield* Ref.updateAndGet(starts, (n) => n + 1)
							if (mode !== "replay mismatch")
								return yield* real.run(program, answer)
							if (count > 1)
								return { _tag: "Done" as const, value: null, logs: [] }
							yield* answer([
								{ index: 0, binding: "notes.write", arguments: "{}" },
							])
							return { _tag: "Stopped" as const }
						}),
				})
				const commandLayers = Layer.mergeAll(
					CodeCommands.layer,
					AppCommands.layer,
				).pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.mock(TurnAccess, {
								admit: () => Effect.void,
								authorize: () => Effect.void,
							}),
							Layer.succeed(ActionPolicy, {
								isRead: () => Effect.succeed(true),
							}),
							Layer.mock(Vaults, { usable: () => Effect.succeed([]) }),
							Layer.mock(SettingsService, {
								platform: Effect.succeedSome({
									document: {
										publicOrigin: "https://openbot.example",
										authSecret: "test",
										identityProvider: null,
										organizationCreation: "anyone" as const,
										ceiling: Authorization.emptyPolicy,
										appRestrictions: [],
										codeMode: {
											...SettingsApi.codeModeDefaults,
											enabled: true,
										},
									},
									version: 1,
									updatedAt: 0,
								}),
							}),
						),
					),
				)
				const base = Layer.mergeAll(
					CallsModule.layer,
					Observation.layer,
					RunScope.layer.pipe(Layer.provide(Observation.layer)),
					Runner.layer.pipe(
						Layer.provide(
							Layer.mock(Billing, {
								releaseExecution: () => Effect.succeed(true),
							}),
						),
					),
				).pipe(
					Layer.provideMerge(Engine.layerRegistry),
					Layer.provideMerge(Records.layer),
					Layer.provideMerge(WorkflowEngine.layerMemory),
				)
				const runtime = CodeWorkflow.layer.pipe(
					Layer.provideMerge(
						CodeProgram.layer.pipe(Layer.provide(Layer.mock(Vaults, {}))),
					),
					Layer.provideMerge(commandLayers),
					Layer.provideMerge(base),
					Layer.provide(sandbox),
					Layer.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				)
				yield* Effect.gen(function* () {
					const code = yield* CodeCommands.CodeCommands
					const apps = yield* AppCommands.AppCommands
					const registry = yield* Registry
					yield* registry.register(
						AppWorkflow.workflow,
						apps.authorize,
						apps.decide,
					)
					const tool = yield* test.submit("call")
					const source = yield* test.store.takeOver({
						namespace: test.key.namespace,
						id: tool.executionId,
					})
					const receipt = yield* code.submit(
						source,
						Execution.mainCall("call"),
						{
							code: "return await apps.notes.write({ text: 'private input' });",
							reason: "Write a note",
							vault: [],
							bindings: [
								{
									alias: "notes.write",
									source: {
										...appInput.source,
										definition: {
											name: "write",
											inputSchema: { type: "object" },
										},
									},
								},
							],
						},
					)
					const key = { namespace: source.namespace, id: receipt.executionId }
					const observation = yield* Observation.Observation
					if (mode === "replay mismatch") {
						const fence = yield* test.store.takeOver(key)
						const fiber = yield* (yield* CodeProgram.CodeProgram)
							.run(fence)
							.pipe(Effect.forkScoped)
						yield* observation.observe(key, 0).pipe(
							Stream.filter(
								(event) =>
									event.body._tag === "State" &&
									event.body.status === "waiting",
							),
							Stream.runHead,
							Effect.timeout("5 seconds"),
						)
						yield* Fiber.interrupt(fiber)
					}
					yield* CodeWorkflow.workflow.execute(key, { discard: true })
					const event = Option.getOrThrow(
						yield* observation.observe(key, 0).pipe(
							Stream.filter((event) => event.body._tag === "ChildExecution"),
							Stream.runHead,
							Effect.timeout("5 seconds"),
						),
					)
					if (event.body._tag !== "ChildExecution")
						return assert.fail("Expected an App child")
					const child = { namespace: key.namespace, id: event.body.executionId }
					if (mode !== "complete") {
						if (mode === "cancel child") {
							const record = yield* test.store.loadMember(key)
							yield* test.store.cancel(
								key,
								Execution.CommandKey.make("stop-code"),
								record.identity.actor,
							)
							yield* Option.getOrThrow(
								yield* registry.get(CodeCommands.workflowName),
							).cancel(key, (yield* test.store.loadMember(key)).cancelEpoch)
						}
						yield* observation.observe(child, 0).pipe(
							Stream.filter(
								(event) =>
									event.body._tag === "State" &&
									event.body.status === "cancelling",
							),
							Stream.runHead,
							Effect.timeout("5 seconds"),
						)
						assert.equal(
							Execution.isTerminal((yield* test.store.get(key)).status),
							false,
						)
						const childFence = yield* test.store.takeOver(child)
						yield* apps.finish(childFence, {
							status: "cancelled",
							epoch: (yield* test.store.loadMember(child)).cancelEpoch,
						})
					} else {
						const childFence = yield* test.store.takeOver(child)
						const phase = yield* apps.current(child)
						if (phase._tag !== "Send")
							return assert.fail("Expected the App send")
						const call = yield* test.store.readAttempt(
							childFence,
							AppCall.stepId(0),
							yield* Schema.encodeEffect(Schema.toCodecJson(AppCall.Input))(
								phase.input,
							),
						)
						yield* test.store.sending(childFence, call.id)
						yield* test.store.finishCall(childFence, call.id, {
							_tag: "Completed",
							result: { saved: true },
						})
						assert.ok(Option.isNone((yield* apps.first(child)).outcome))
						yield* apps.finish(childFence, { status: "completed" })
					}
					yield* observation
						.observe(key, 0)
						.pipe(Stream.runDrain, Effect.timeout("5 seconds"))
					assert.equal(
						(yield* test.store.get(key)).status,
						mode === "complete"
							? "completed"
							: mode === "cancel child"
								? "cancelled"
								: "failed",
					)
					if (mode === "complete")
						assert.deepEqual(Option.getOrThrow(yield* code.result(key)), {
							_tag: "Completed",
							value: { saved: true },
							logs: [],
						})
					const sql = yield* PgClient.PgClient
					const rows = yield* sql<{
						input: string
					}>`select input from openbot_executions where id = ${key.id}`
					assert.notInclude(rows[0]!.input, "private input")
					const events = yield* Schema.encodeEffect(
						Schema.fromJsonString(Schema.Array(Execution.Event)),
					)(yield* test.store.events(key, 0))
					assert.notInclude(events, "private input")
				}).pipe(Effect.provide(runtime), Effect.scoped)
			}),
		)
	}
	for (const workflow of [
		AppCommands.workflowName,
		CodeCommands.workflowName,
		requestWorkflowName,
	] as const) {
		for (const end of ["cancel", "fail", "deadline"] as const) {
			it.effect(`a tool waits for its ${workflow} child on ${end}`, () =>
				Effect.gen(function* () {
					const test = yield* setup(`tool-owned-${workflow}-${end}`)
					const receipt = yield* test.tools.submit(
						test.parent,
						test.position,
						test.call("one"),
						{
							...settings,
							maxDuration: end === "deadline" ? "500 millis" : "1 hour",
						},
					)
					const key = { namespace: test.key.namespace, id: receipt.executionId }
					const sent = yield* Deferred.make<Store.Key>()
					const closed = yield* Deferred.make<void>()
					const session = Layer.effect(
						ToolSession.ToolSession,
						Effect.gen(function* () {
							const calls = yield* Calls
							return ToolSession.ToolSession.of({
								run: (fence) =>
									Effect.gen(function* () {
										yield* Effect.addFinalizer(() =>
											Deferred.succeed(closed, undefined),
										)
										const call = yield* test.store.writeAttempt(
											fence,
											ToolSteps.stepId(test.position.item, "one"),
											null,
											"local",
										)
										const result = yield* calls.invoke(fence, call, () =>
											Effect.gen(function* () {
												const child = yield* test.store.accept(
													key.namespace,
													Execution.CommandKey.make(`owned:${key.id}`),
													{
														actor: (yield* test.store.loadMember(fence))
															.identity.actor,
														body: null,
													},
													(create) =>
														test.store.commit(
															fence,
															{
																events: (child) => [
																	{
																		_tag: "ChildExecution",
																		executionId: child.executionId,
																		step: "child",
																	},
																],
															},
															Effect.gen(function* () {
																const child = yield* create({
																	workflow,
																	resource: { kind: "Test", id: "child" },
																	identity: (yield* test.store.loadMember(
																		fence,
																	)).identity,
																	input: null,
																})
																return { executionId: child.id, start: true }
															}),
														),
												)
												yield* Deferred.succeed(sent, {
													namespace: key.namespace,
													id: child.executionId,
												})
												if (end === "fail")
													return yield* Effect.fail("The local tool failed")
												return yield* Effect.never
											}),
										)
										return result._tag === "Completed" ? result.result : null
									}),
							})
						}),
					)
					const base = Layer.mergeAll(
						CallsModule.layer,
						Observation.layer,
						RunScope.layer.pipe(Layer.provide(Observation.layer)),
						Runner.layer.pipe(
							Layer.provide(
								Layer.mock(Billing, {
									releaseExecution: () => Effect.succeed(true),
								}),
							),
						),
					).pipe(
						Layer.provideMerge(Engine.layerRegistry),
						Layer.provideMerge(Records.layer),
						Layer.provideMerge(WorkflowEngine.layerMemory),
					)
					const runtime = ToolWorkflow.layer.pipe(
						Layer.provide(
							Layer.succeed(ToolCommands.ToolCommands, {
								...test.tools,
								authorize: () => Effect.void,
							}),
						),
						Layer.provideMerge(session.pipe(Layer.provideMerge(base))),
						Layer.provide(
							Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
						),
					)
					yield* Effect.gen(function* () {
						yield* ToolWorkflow.workflow.execute(key, { discard: true })
						const child = yield* Deferred.await(sent).pipe(
							Effect.timeout("5 seconds"),
						)
						if (end === "cancel") {
							yield* test.store.cancel(
								key,
								Execution.CommandKey.make("stop"),
								(yield* test.store.loadMember(key)).identity.actor,
							)
							yield* Option.getOrThrow(
								yield* (yield* Registry).get(ToolCommands.workflowName),
							).cancel(key, (yield* test.store.loadMember(key)).cancelEpoch)
						}
						const observation = yield* Observation.Observation
						yield* observation.observe(child, 0).pipe(
							Stream.filter(
								(event) =>
									event.body._tag === "State" &&
									event.body.status === "cancelling",
							),
							Stream.runHead,
							Effect.timeout("5 seconds"),
						)
						yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))
						assert.isFalse(
							Execution.isTerminal((yield* test.store.get(key)).status),
						)
						const childFence = yield* test.store.takeOver(child)
						yield* test.store.finishCancellation(
							childFence,
							(yield* test.store.loadMember(child)).cancelEpoch,
						)
						yield* observation
							.observe(key, 0)
							.pipe(Stream.runDrain, Effect.timeout("5 seconds"))
						const saved = yield* test.tools.load(key)
						assert.equal(
							saved.record.status,
							end === "cancel"
								? "cancelled"
								: end === "fail"
									? "failed"
									: "interrupted",
						)
						const output = yield* ToolResults.output(
							{ ...saved.record, calls: yield* test.store.calls(key) },
							saved.input.call,
						)
						assert.notProperty(
							yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
								output.result,
							),
							"outcome",
						)
					}).pipe(Effect.provide(runtime), Effect.scoped)
				}),
			)
		}
	}

	for (const discovery of ["missing", "background", "foreground"] as const) {
		it.effect(
			`an unknown model tool gives an error with ${discovery} discovery`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`unknown-model-tool-${discovery}`)
					const model = yield* test.store.readAttempt(
						test.parent,
						`model:${test.position.item}`,
						{ tools: [] },
					)
					yield* test.store.sending(test.parent, model.id)
					yield* test.store.finishCall(test.parent, model.id, null)
					const runtime = TurnTools.layer.pipe(
						Layer.provideMerge(ToolSteps.layer),
						Layer.provideMerge(
							Layer.merge(CallsModule.layer, Observation.layer),
						),
						Layer.provideMerge(Engine.layerRegistry),
						Layer.provideMerge(Records.layer),
						Layer.provideMerge(WorkflowEngine.layerMemory),
						Layer.provide(
							Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
						),
					)
					yield* Effect.gen(function* () {
						yield* (yield* Registry).register(
							Engine.define("openbot.chat-turn"),
							() => Effect.void,
						)
						const tools = yield* TurnTools.TurnTools
						const tool = Tool.dynamic("send", {
							parameters: { type: "object" },
							success: Schema.Json,
						})
						const toolkit = Toolkit.make(
							discovery === "foreground"
								? tool.annotate(Operation.Budget, "foreground")
								: tool,
						)
						const handlers = yield* toolkit.toHandlers({
							send: () => Effect.die("The tool was not in the model request"),
						})
						const ready = yield* toolkit.pipe(Effect.provideContext(handlers))
						const input = {
							position: test.position,
							call: test.call("call"),
							prompt: test.pending.input,
							execute: tools.executor(test.parent, settings),
						}
						const parts = yield* (
							discovery !== "missing"
								? ToolStep.run({ ...input, toolkit: ready })
								: ToolStep.run({ ...input, toolkit: yield* Toolkit.make() })
						).pipe(Stream.runCollect, Effect.provideContext(handlers))
						assert.equal(parts.length, 1)
						const part = parts[0]!
						if (part.type !== "tool-result")
							return assert.fail("Expected a tool result")
						assert.isTrue(part.isFailure)
						assert.equal(
							(yield* test.tools.list(test.key.namespace, test.position.chat))
								.length,
							0,
						)
					}).pipe(Effect.provide(runtime), Effect.scoped)
				}),
		)
	}
	for (const kind of ["app", "code"] as const) {
		it.effect(
			`the ${kind} tool keeps its selected data across owner loss`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`tool-selected-${kind}`)
					const commandLayers = Layer.mergeAll(
						CodeCommands.layer,
						AppCommands.layer,
					).pipe(
						Layer.provide(
							Layer.mergeAll(
								Layer.mock(TurnAccess, {
									admit: () => Effect.void,
									authorize: () => Effect.void,
								}),
								Layer.succeed(ActionPolicy, {
									isRead: () => Effect.succeed(true),
								}),
								Layer.mock(SettingsService, {
									platform: Effect.succeedSome({
										document: {
											publicOrigin: "https://openbot.example",
											authSecret: "test",
											identityProvider: null,
											organizationCreation: "anyone" as const,
											ceiling: Authorization.emptyPolicy,
											appRestrictions: [],
											codeMode: {
												...SettingsApi.codeModeDefaults,
												enabled: true,
											},
										},
										version: 1,
										updatedAt: 0,
									}),
								}),
							),
						),
					)
					const base = TurnTools.layer.pipe(
						Layer.provideMerge(ToolSteps.layer),
						Layer.provideMerge(
							Layer.merge(CallsModule.layer, Observation.layer),
						),
						Layer.provideMerge(Engine.layerRegistry),
						Layer.provideMerge(Records.layer),
						Layer.provideMerge(WorkflowEngine.layerMemory),
					)
					const runtime = Layer.mergeAll(commandLayers, base).pipe(
						Layer.provide(
							Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
						),
					)
					yield* Effect.gen(function* () {
						const workflows = yield* WorkflowTools.make
						const code = yield* CodeCommands.CodeCommands
						const apps = yield* AppCommands.AppCommands
						const registry = yield* Registry
						yield* registry.register(
							Engine.define("openbot.chat-turn"),
							() => Effect.void,
						)
						yield* registry.register(ToolWorkflow.workflow, () => Effect.void)
						yield* registry.register(
							AppWorkflow.workflow,
							apps.authorize,
							apps.decide,
						)
						yield* registry.register(
							CodeWorkflow.workflow,
							code.authorize,
							code.decide,
						)
						const binding = {
							name: "send",
							source: {
								...appInput.source,
								definition: { name: "write", inputSchema: { type: "object" } },
							},
							schema: { type: "object" as const },
							description: "Write a note",
							needsDecision: true,
							readOnly: false,
						}
						const entry = (fence: Store.Fence, revision: number) => {
							const description = {
								...binding,
								source: { ...binding.source, revision },
							}
							return kind === "app"
								? workflows.app(fence, description)
								: Option.getOrThrow(
										Arr.findFirst(
											workflows.program(
												fence,
												[description],
												[
													{
														alias: "login",
														usable: {
															vaultName: "Team",
															item: {
																id: VaultDomain.VaultItemId.make(
																	`item-${revision}`,
																),
																vault: VaultDomain.VaultId.make("vault"),
																name: "login",
																description: "",
																source: { _tag: "Builtin" },
																fields: ["token"],
																exits: [],
																version: 0,
																createdAt: 0,
																updatedAt: 0,
															},
														},
													},
												],
												[],
											),
											(entry) => entry.tool.name === codeNames.run,
										),
									)
						}
						const selected = entry(test.parent, 1)
						const inputState = Context.get(
							selected.tool.annotations,
							InputState,
						)
						assert.isDefined(inputState)
						const call = Prompt.makePart("tool-call", {
							id: "selected",
							name: selected.tool.name,
							providerExecuted: false,
							params:
								kind === "app"
									? { text: "private text" }
									: { code: "return 1", reason: "Read a value" },
						})
						yield* test.chats.modifyEffect({
							chat: test.position.chat,
							update: (view) =>
								Effect.succeed([
									undefined,
									Option.some({
										chat: {
											turn: {
												...Option.getOrThrow(
													Option.fromUndefinedOr(view.chat.turn),
												),
												pendingStep: {
													...test.pending,
													input: Prompt.make([
														{ role: "assistant", content: [call] },
													]),
												},
											},
										},
									}),
								] as const),
						})
						const modelCall = yield* test.store.readAttempt(
							test.parent,
							`model:${test.position.item}`,
							{ tools: [yield* ToolDefinitions.capture(selected.tool)] },
						)
						yield* test.store.sending(test.parent, modelCall.id)
						yield* test.store.finishCall(test.parent, modelCall.id, null)
						// The model result is saved, but no tool command exists when this owner stops.
						const resumedParent = yield* test.store.takeOver(test.key)
						const changed = entry(resumedParent, 2)
						const fixed = Option.getOrThrow(
							yield* ToolDefinitions.selected(
								test.store,
								resumedParent,
								test.position,
								call.name,
								changed.tool,
							),
						)
						assert.deepEqual(
							fixed,
							yield* ToolDefinitions.capture(selected.tool),
						)
						const routes = yield* TurnTools.TurnTools
						const emptyTools = yield* Toolkit.make()
						const resumed = yield* routes.executor(resumedParent, settings)
							.resume!(test.position, { call, toolkit: emptyTools })
						assert.isTrue(Option.isSome(resumed))
						yield* Option.getOrThrow(resumed).pipe(Stream.runDrain)
						const receipt = Option.getOrThrow(
							Arr.head(
								yield* test.tools.list(test.key.namespace, test.position.chat),
							),
						)
						const key = {
							namespace: test.key.namespace,
							id: receipt.executionId,
						}
						const first = yield* test.store.takeOver(key)
						// An accepted tool can restore its child even when discovery and Chat setup are gone.
						const invoke = (fence: Store.Fence) =>
							Effect.gen(function* () {
								const session = yield* ToolSession.ToolSession
								return yield* session.run(fence)
							}).pipe(
								Effect.provide(
									ToolSession.layer.pipe(
										Layer.provide(
											Layer.mergeAll(
												Layer.succeed(ExecutionFeatures, {
													open: () => Effect.die("Must restore the saved tool"),
													restoreTool: () =>
														Effect.die("Must use the saved App or Code tool."),
													restore: workflows.restore,
												}),
												Layer.mock(TurnContext.TurnContext, {}),
												HostTools.none,
												Layer.mock(InputCommands, {}),
											),
										),
									),
								),
							)
						const fiber = yield* invoke(first).pipe(Effect.forkScoped)
						const observation = yield* Observation.Observation
						const event = Option.getOrThrow(
							yield* observation.observe(key, 0).pipe(
								Stream.filter((event) => event.body._tag === "ChildExecution"),
								Stream.runHead,
								Effect.timeout("5 seconds"),
							),
						)
						if (event.body._tag !== "ChildExecution")
							return assert.fail("Expected a child")
						const child = {
							namespace: key.namespace,
							id: event.body.executionId,
						}
						yield* Fiber.interrupt(fiber)
						const owner = yield* test.store.takeOver(key)
						const childFence = yield* test.store.takeOver(child)
						if (kind === "app") {
							const phase = yield* apps.current(child)
							if (phase._tag !== "Send")
								return assert.fail("Expected an App call")
							assert.equal(phase.input.source.revision, 1)
							const call = yield* test.store.readAttempt(
								childFence,
								AppCall.stepId(0),
								yield* Schema.encodeEffect(Schema.toCodecJson(AppCall.Input))(
									phase.input,
								),
							)
							yield* test.store.sending(childFence, call.id)
							yield* test.store.finishCall(childFence, call.id, {
								_tag: "Completed",
								result: { saved: true },
							})
							yield* apps.finish(childFence, { status: "completed" })
						} else {
							const input = (yield* code.load(child)).input
							assert.equal(input.bindings[0]!.source.revision, 1)
							assert.deepEqual(input.vault, [
								{
									alias: "login",
									item: VaultDomain.VaultItemId.make("item-1"),
									fields: ["token"],
								},
							])
							const call = yield* test.store.intent(childFence, {
								step: CodeCommands.programStep,
								attempt: 0,
								retry: "local",
								input: null,
							})
							yield* test.store.sending(childFence, call.id)
							yield* test.store.finishCall(childFence, call.id, {
								_tag: "Completed",
								value: 1,
								logs: [],
							})
							yield* code.finish(childFence, { status: "completed" })
						}
						const output = yield* invoke(owner).pipe(
							Effect.timeout("5 seconds"),
						)
						const decoded = yield* Schema.decodeEffect(ToolSteps.outputCodec)(
							output,
						)
						const value = yield* Schema.decodeUnknownEffect(
							Schema.Struct({ executionId: Execution.Id }),
						)(decoded.result)
						assert.equal(value.executionId, child.id)
						assert.equal(
							Arr.filter(
								yield* test.store.events(key, 0),
								(event) => event.body._tag === "ChildExecution",
							).length,
							1,
						)
						assert.deepEqual(yield* invoke(owner), output)
					}).pipe(Effect.provide(runtime), Effect.scoped)
				}),
		)
	}

	it.effect(
		"an App tool returns the same input handoff that ended its wait",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("tool-first-handoff")
				const execution = yield* test.store.get(test.key)
				const reads = yield* Ref.make(0)
				const outcome: AppCalls.Outcome = {
					_tag: "InputRequired",
					request: { consent: true },
				}
				const services = Layer.mergeAll(
					Layer.mock(AppCommands.AppCommands, {
						submit: () =>
							Effect.succeed({
								executionId: test.key.id,
								commandKey: Execution.CommandKey.make("app"),
								sequence: 1,
							}),
						first: () =>
							Ref.updateAndGet(reads, (count) => count + 1).pipe(
								Effect.map((count) => ({
									id: AppCalls.AppOperationId.make("app"),
									execution: {
										...execution,
										status: count === 1 ? "waiting" : "cancelling",
									},
									outcome: count === 1 ? Option.some(outcome) : Option.none(),
								})),
							),
					}),
					Layer.mock(CodeCommands.CodeCommands, {}),
					Layer.mock(Observation.Observation, {
						observe: () =>
							Stream.succeed({
								namespace: test.key.namespace,
								executionId: test.key.id,
								sequence: 1,
								createdAt: 0,
								body: { _tag: "State", status: "waiting", failure: null },
							}),
					}),
					Layer.mock(Records.Records, {}),
				)
				const workflows = yield* WorkflowTools.make.pipe(
					Effect.provide(services),
				)
				const entry = workflows.app(test.parent, {
					name: "send",
					source: appInput.source,
					schema: { type: "object" },
					description: "Send",
					needsDecision: true,
					readOnly: false,
				})
				const output = yield* entry
					.handle({}, { toolCallId: "call", preliminary: () => Effect.void })
					.pipe(
						Effect.provideService(CallContext, {
							fence: test.parent,
							id: Execution.CallId.make("call"),
							inputState: Option.getOrThrow(
								Option.fromUndefinedOr(
									Context.get(entry.tool.annotations, InputState),
								),
							),
						}),
					)
				const saved = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ outcome: AppCalls.Outcome }),
				)(output)
				assert.deepEqual(saved.outcome, outcome)
				assert.equal(yield* Ref.get(reads), 1)
			}),
	)
})
