import * as Resolve from "../src/capabilities/Resolve.ts"
import * as DelegationsModule from "../src/bots/Delegations.ts"
import * as GrantUse from "../src/capabilities/GrantUse.ts"
import { ChatModelInvalid } from "@openbot-build/domain"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as ToolCommands from "../src/chats/ToolCommands.ts"
import { SavedResult } from "../src/plugins/ToolEntry.ts"
import * as Calls from "../src/execution/Calls.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"
import * as ReviewTools from "../src/capabilities/ReviewTools.ts"
import { CallContext } from "../src/execution/CallContext.ts"
import { Billing } from "../src/billing/Billing.ts"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import {
	Chat,
	Config,
	Model,
	Turn,
	Item,
	ChatStoreRepository,
	Store as CoreStore,
	TurnState,
} from "@openbot-build/core"
import {
	AppCalls,
	CodeRuns as CodeDomain,
	ConnectionId,
	Authorization,
	BotId,
	TokenId,
	type Caller,
	Execution,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Deferred,
	Exit,
	Fiber,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	Schedule,
	String as Str,
	Stream,
	Record as Rec,
} from "effect"
import * as Audit from "../src/audit/AuditLogPostgres.ts"
import * as BotRecords from "../src/bots/BotRecords.ts"
import * as Gate from "../src/capabilities/Gate.ts"
import * as Approvals from "../src/capabilities/Approvals.ts"
import * as Grants from "../src/capabilities/Grants.ts"
import * as Requests from "../src/capabilities/Requests.ts"
import * as Rules from "../src/capabilities/Rules.ts"
import * as Decisions from "../src/capabilities/RequestCommands.ts"
import * as BotDecisions from "../src/capabilities/BotDecisions.ts"
import * as CapabilityAccess from "../src/capabilities/CapabilityAccess.ts"
import { Judge } from "../src/capabilities/Judge.ts"
import * as Notices from "../src/capabilities/RequestNotices.ts"
import * as AppApprovals from "../src/apps/AppApprovals.ts"
import * as StoredInvocations from "../src/apps/StoredInvocations.ts"
import * as StoredConnections from "../src/apps/StoredConnections.ts"
import { appConnections, appInvocations } from "../src/database/Schema.ts"
import { Store as ProtocolStore } from "@openbot-build/protocol"
import * as Reviews from "../src/capabilities/RequestReviews.ts"
import * as RequestWorkflow from "../src/capabilities/RequestWorkflow.ts"
import * as Inputs from "../src/chats/InputCommands.ts"
import { Bots } from "../src/bots/Bots.ts"
import * as Runner from "../src/execution/Runner.ts"
import * as RunScope from "../src/execution/RunScope.ts"
import * as Records from "../src/errors/Records.ts"

import { Prompt, Response, Toolkit } from "effect/ai"
import { TurnContext } from "../src/chats/TurnContext.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import * as Db from "../src/database/Database.ts"
import * as BotFixture from "./BotFixture.ts"
import { TurnAccess } from "../src/chats/TurnAccess.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Commands from "../src/execution/Commands.ts"
import * as Engine from "../src/execution/Engine.ts"
import { WorkflowEngine } from "effect/workflow"
import * as Observation from "../src/execution/Observation.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Fixture from "./OrganizationFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

class Access extends Context.Service<
	Access,
	Ref.Ref<{ readonly source: boolean; readonly resolve: boolean }>
>()("@openbot-build/openbot/test/RequestCommands.test/Access") {}
const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const allowed = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("*", "*")
})
const policy = Layer.unwrap(
	Effect.map(Access, (state) =>
		Authorizer.layer(Authorization.Auth, {
			policy: () =>
				Effect.map(Ref.get(state), (state) =>
					state.resolve ? allowed : Authorization.emptyPolicy,
				),
		}),
	),
)
const source = Layer.unwrap(
	Effect.map(Access, (state) =>
		Layer.mock(TurnAccess, {
			admit: () => Effect.void,
			input: () => Effect.void,
			notice: () => Effect.succeed(true),
			authorize: () =>
				Effect.flatMap(Ref.get(state), (state) =>
					state.source
						? Effect.void
						: Effect.fail(Execution.Forbidden.make({})),
				),
		}),
	),
)
const registry = Layer.effectDiscard(
	Effect.gen(function* () {
		const registry = yield* Engine.Registry
		const decisions = yield* Decisions.RequestCommands
		yield* registry.register(
			Engine.define(Decisions.workflowName),
			decisions.authorize,
			decisions.decide,
		)
	}),
).pipe(
	Layer.provideMerge(Engine.layerRegistry),
	Layer.provideMerge(Decisions.layer),
	Layer.provide(WorkflowEngine.layerMemory),
)
const services = Commands.layer.pipe(
	Layer.provideMerge(Observation.layer),
	Layer.provideMerge(registry),
	Layer.provideMerge(
		Requests.layer.pipe(
			Layer.provideMerge(Layer.mergeAll(Grants.layer, Rules.layer)),
		),
	),
	Layer.provideMerge(
		DelegationsModule.layer.pipe(Layer.provide(BotRecords.layer)),
	),
	Layer.provideMerge(
		Layer.mergeAll(
			Store.layer,
			BotRecords.layer,
			Audit.layer,
			Records.layer,
			policy,
			source,
			Layer.mock(Bots, {}),
		),
	),
	Layer.provideMerge(
		Layer.effect(
			Access,
			Ref.make<{ readonly source: boolean; readonly resolve: boolean }>({
				source: true,
				resolve: true,
			}),
		),
	),
	Layer.provideMerge(
		Layer.mock(TurnContext, {
			prepare: (input) =>
				Effect.gen(function* () {
					return {
						...input,
						bot: { ...BotFixture.bot, id: input.host.bot },
						chain: ChatHost.chainForHost(input.host, input.identity),
						deciders: input.host.chain.bots,
					}
				}),
		}),
	),
	Layer.provide(Fixture.layerDefaultSettings),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(
		Layer.mock(ModelRegistry, {
			catalog: () =>
				Effect.succeed({
					providers: [
						{ id: DevelopmentModel.selection.provider, name: "Test" },
					],
					models: [
						Config.Model.make({
							provider: DevelopmentModel.selection.provider,
							id: DevelopmentModel.selection.model,
							name: "Test",
							reasoningEfforts: [],
							serviceTiers: [],
						}),
					],
				}),
			defaultModel: Option.some(DevelopmentModel.selection),
		}),
	),
	Layer.provideMerge(NodeServices.layer),
)
const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const setup = Effect.fn(function* (
	namespace: string,
	ask: Requests.Ask = { person: true },
	options: {
		readonly reviewer?: BotId
		readonly caller?: Caller
		readonly owner?: string
		readonly input?: Partial<Decisions.Input>
	} = {},
) {
	const caller: Caller = options.caller ?? actor
	const store = yield* Store.Store
	const bot = BotId.make(`bot-${namespace}`)
	const chat = Chat.Id.make(`chat-${namespace}`)
	const turn = Turn.Id.make(`turn-${namespace}`)
	const identity = {
		owner: {
			organizationId: caller.organizationId,
			userId: options.owner ?? caller.userId,
		},
		actor: caller,
		botId: bot,
	}
	const source = yield* store.submit(
		namespace,
		Execution.CommandKey.make("source"),
		{
			workflow: "openbot.chat-turn",
			resource: { kind: "Turn", id: turn },
			identity,
			input: { chat },
		},
	)

	const db = yield* Db.make
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore },
		schemaVersion: "chat/1",
	})
	const chats = yield* ChatStoreRepository.make({
		definition,
		persistence: StoredChats.persistence(db, namespace),
	})
	yield* chats.create({
		id: chat,
		business: {
			[ChatHost.chatHostId]: {
				bot,
				kind: options.owner === undefined ? "direct" : "channel",
				chain: {
					...(options.owner === undefined ? {} : { owner: options.owner }),
					organizationId: caller.organizationId,
					userId: caller.userId,
					...(caller.tokenId === undefined ? {} : { tokenId: caller.tokenId }),
					bots:
						options.reviewer === undefined ? [bot] : [options.reviewer, bot],
					chats: [],
				},
			},
		},
	})
	const entry = {
		id: Item.Id.make("input"),
		kind: "message" as const,
		content: Prompt.make("Write a note."),
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
				Effect.map((change) => [undefined, Option.some(change)] as const),
			),
	})
	const parent = yield* store.takeOver({ namespace, id: source.executionId })
	const commands = yield* Decisions.RequestCommands
	const submission = {
		continuation: "chat" as const,
		capability: { action: "tools.call" as const, target: "write" },
		reason: "Write a note.",
		toolCallId: "call",
		ask,
		call: { name: "write", params: { text: "A note." } },
		...options.input,
	}
	const receipt = yield* commands.submit(
		parent,
		Execution.CommandKey.make("request"),
		submission,
	)
	const key = { namespace, id: receipt.executionId }
	const stored = (yield* commands.load(key)).stored
	const fence = yield* store.takeOver(key)

	const input = {
		commandKey: Execution.CommandKey.make("allow"),
		decisionId: Decisions.decisionId(stored.request),
		answer: "allow" as const,
	}
	return { key, stored, bot, input, fence, parent, submission, receipt, chats }
})
layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	const noticeLayer = Notices.layer.pipe(
		Layer.provide(Inputs.layer),
		Layer.provide(AppApprovals.layer),
		Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	)
	const finishForReply = Effect.fn(function* (
		test: Effect.Success<ReturnType<typeof setup>>,
	) {
		const commands = yield* Decisions.RequestCommands
		yield* commands.decide(test.key, actor, test.input)
		const receipt = yield* commands.finish(test.fence, { status: "completed" })
		return yield* (yield* Store.Store).takeOver({
			namespace: test.key.namespace,
			id: receipt.executionId,
		})
	})
	it.effect("workflow requests leave result delivery to their caller", () =>
		Effect.gen(function* () {
			const test = yield* setup(
				"request-owned",
				{ person: true },
				{ input: { continuation: "workflow" } },
			)
			const commands = yield* Decisions.RequestCommands
			yield* commands.decide(test.key, actor, test.input)
			const receipt = yield* commands.finish(test.fence, {
				status: "completed",
			})
			assert.equal(receipt.executionId, test.key.id)
			const sql = yield* PgClient.PgClient
			assert.equal(
				(yield* sql`select id from openbot_executions where namespace = ${test.key.namespace} and resource_kind = 'RequestNotice'`)
					.length,
				0,
			)
			assert.equal(
				(yield* (yield* Store.Store).get(test.key)).status,
				"completed",
			)
		}),
	)
	it.effect("a request reply steers the source identity only once", () =>
		Effect.gen(function* () {
			const test = yield* setup("request-reply")
			const fence = yield* finishForReply(test)
			const notices = yield* Notices.RequestNotices
			yield* Effect.forEach(Arr.range(1, 10), () => notices.deliver(fence), {
				concurrency: 5,
			})
			const view = yield* test.chats.read(test.stored.request.chat)
			assert.equal(view.chat.inbox.length, 1)
			assert.equal(view.chat.inbox[0]?.kind, "steer")
			assert.deepStrictEqual(view.chat.inbox[0]?.approved, {
				id: `approved_${test.stored.request.id}`,
				name: "write",
				params: { text: "A note." },
			})
			const events = yield* (yield* Store.Store).events(fence, 0)
			assert.equal(
				Arr.filter(events, (event) => event.body._tag === "Result").length,
				1,
			)
		}).pipe(Effect.provide(noticeLayer)),
	)
	it.effect("plan mode and input roll back when the notice cannot end", () =>
		Effect.gen(function* () {
			const test = yield* setup(
				"request-plan",
				{ person: true },
				{ input: { capability: { action: "plans.run", target: "plan" } } },
			)
			yield* test.chats.modifyEffect({
				chat: test.stored.request.chat,
				update: (view) =>
					Effect.succeed([
						undefined,
						Option.some({
							chat: { settings: { ...view.chat.settings, mode: "plan" } },
						}),
					] as const),
			})
			const fence = yield* finishForReply(test)
			const notices = yield* Notices.RequestNotices
			const sql = yield* PgClient.PgClient
			yield* sql`create function reject_reply_end() returns trigger language plpgsql as $$ begin if NEW.resource_kind = 'RequestNotice' and NEW.status = 'completed' then raise exception 'Fixture reply failure'; end if; return NEW; end $$`
			yield* sql`create trigger reject_reply_end before update on openbot_executions for each row execute function reject_reply_end()`
			yield* Effect.addFinalizer(() =>
				sql`drop trigger if exists reject_reply_end on openbot_executions`.pipe(
					Effect.andThen(sql`drop function if exists reject_reply_end()`),
					Effect.orDie,
				),
			)
			assert.ok(
				Schema.is(Execution.StorageError)(
					yield* notices.deliver(fence).pipe(Effect.flip),
				),
			)
			let view = yield* test.chats.read(test.stored.request.chat)
			assert.equal(view.chat.settings.mode, "plan")
			assert.equal(view.chat.inbox.length, 0)
			assert.equal((yield* (yield* Store.Store).get(fence)).status, "running")
			yield* sql`drop trigger reject_reply_end on openbot_executions`
			yield* notices.deliver(fence)
			view = yield* test.chats.read(test.stored.request.chat)
			assert.equal(view.chat.settings.mode, "build")
			assert.equal(view.chat.inbox.length, 1)
			assert.equal(view.chat.inbox[0]?.kind, "message")
			assert.equal(view.chat.inbox[0]?.approved, undefined)
		}).pipe(Effect.provide(noticeLayer)),
	)
	for (const blocked of ["stale", "rights", "cancelled"] as const) {
		it.effect(`a ${blocked} request notice cannot start work`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`request-reply-${blocked}`)
				const fence = yield* finishForReply(test)
				const store = yield* Store.Store
				const access = yield* Access
				if (blocked === "stale") yield* store.takeOver(fence)
				if (blocked === "cancelled")
					yield* store.cancel(
						fence,
						Execution.CommandKey.make("cancel-reply"),
						actor,
					)
				if (blocked === "rights") {
					yield* Ref.update(access, (state) => ({ ...state, source: false }))
					yield* Effect.addFinalizer(() =>
						Ref.update(access, (state) => ({ ...state, source: true })),
					)
				}
				const error = yield* (yield* Notices.RequestNotices)
					.deliver(fence)
					.pipe(Effect.flip)
				assert.ok(
					blocked === "rights"
						? Schema.is(Execution.Forbidden)(error)
						: Schema.is(Execution.Conflict)(error),
				)
				assert.equal(
					(yield* test.chats.read(test.stored.request.chat)).chat.inbox.length,
					0,
				)
			}).pipe(Effect.provide(noticeLayer)),
		)
	}

	it.effect("a reply to closed work records history without a new action", () =>
		Effect.gen(function* () {
			const test = yield* setup(
				"request-closed-reply",
				{ person: true },
				{ input: { capability: { action: "plans.run", target: "plan" } } },
			)
			yield* test.chats.modifyEffect({
				chat: test.stored.request.chat,
				update: (view) =>
					Effect.succeed([
						undefined,
						Option.some({
							chat: { settings: { ...view.chat.settings, mode: "plan" } },
						}),
					] as const),
			})
			const fence = yield* finishForReply(test)
			const services = Notices.layer.pipe(
				Layer.provide(Inputs.layer),
				Layer.provide(AppApprovals.layer),
				Layer.provide(
					Layer.mock(TurnAccess, {
						admit: () => Effect.void,
						notice: () => Effect.succeed(false),
					}),
				),
				Layer.provide(
					Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
				),
			)
			yield* Notices.RequestNotices.use((notices) =>
				notices.deliver(fence),
			).pipe(Effect.provide(services))
			const view = yield* test.chats.read(test.stored.request.chat)
			assert.equal(view.chat.settings.mode, "plan")
			assert.equal(view.chat.inbox.length, 0)
			const items = yield* test.chats.items(test.stored.request.chat, {
				turn: test.stored.request.turn,
			})
			const added = Arr.filter(
				items,
				(item) => item.origin?.notice?.ref === test.stored.request.id,
			)
			assert.equal(added.length, 1)
			assert.equal(added[0]?.origin?.turn, test.stored.request.turn)
			assert.equal((yield* (yield* Store.Store).get(fence)).status, "completed")
		}),
	)
	for (const changed of [false, true]) {
		it.effect(
			`an App reply ${changed ? "rejects a changed connection" : "commits its approval with its input"}`,
			() =>
				Effect.gen(function* () {
					const namespace = `request-app-${changed}`
					const secrets = yield* Secrets.Secrets
					const db = yield* Db.make
					const app: AppCalls.Invocation = {
						id: AppCalls.AppOperationId.make(`app-${namespace}`),
						chat: Chat.Id.make(`chat-${namespace}`),
						turn: Turn.Id.make(`turn-${namespace}`),
						callId: "call",
						toolName: "write",
						arguments: { text: "A note." },
						readOnly: false,
						round: 0,
						status: "PendingApproval",
						result: null,
						source: {
							connectionId: ConnectionId.make("connection"),
							connectionName: "Notes",
							cardUrl: "https://example.test/card",
							appName: "Notes",
							remoteIndex: 0,
							revision: 1,
							kind: "tool",
							name: "write",
						},
					}
					const connection = {
						connection: ProtocolStore.UserConnection.make({
							owner: namespace,
							connectionId: "connection",
							cardUrl: app.source.cardUrl,
							endpoint: "https://example.test/mcp",
							remoteIndex: 0,
							configuration: Redacted.make({}),
							headers: Redacted.make({}),
							state: "Enabled",
							authorization: { _tag: "Unprotected" },
						}),
						name: "Notes",
						revision: changed ? 2 : 1,
						verification: null,
					}
					yield* db.insert(appConnections).values({
						owner: namespace,
						id: "connection",
						name: "Notes",
						revision: connection.revision,
						body: yield* secrets.seal(
							yield* Schema.encodeEffect(
								Schema.fromJsonString(
									Schema.toCodecJson(StoredConnections.StoredConnection),
								),
							)(connection),
							yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.Array(Schema.String)),
							)(["connection", namespace, "connection"]),
						),
					})
					yield* db.insert(appInvocations).values({
						owner: namespace,
						id: app.id,
						chat: app.chat,
						status: app.status,
						body: yield* StoredInvocations.seal(secrets, namespace, app),
					})
					const test = yield* setup(
						namespace,
						{ person: true },
						{ input: { app } },
					)
					const fence = yield* finishForReply(test)
					const notices = yield* Notices.RequestNotices
					const sql = yield* PgClient.PgClient
					if (!changed) {
						yield* sql`create function reject_app_reply_end() returns trigger language plpgsql as $$ begin if NEW.resource_kind = 'RequestNotice' and NEW.status = 'completed' then raise exception 'Fixture App reply failure'; end if; return NEW; end $$`
						yield* sql`create trigger reject_app_reply_end before update on openbot_executions for each row execute function reject_app_reply_end()`
						yield* Effect.addFinalizer(() =>
							sql`drop trigger if exists reject_app_reply_end on openbot_executions`.pipe(
								Effect.andThen(
									sql`drop function if exists reject_app_reply_end()`,
								),
								Effect.orDie,
							),
						)
						assert.ok(
							Schema.is(Execution.StorageError)(
								yield* notices.deliver(fence).pipe(Effect.flip),
							),
						)
						assert.equal(
							(yield* StoredInvocations.get(db, secrets, namespace, app.id))
								.status,
							"PendingApproval",
						)
						assert.equal(
							(yield* test.chats.read(app.chat)).chat.inbox.length,
							0,
						)
						yield* sql`drop trigger reject_app_reply_end on openbot_executions`
					}
					yield* notices.deliver(fence)
					yield* notices.deliver(fence)
					const view = yield* test.chats.read(app.chat)
					assert.equal(view.chat.inbox.length, 1)
					assert.equal(
						view.chat.inbox[0]?.approved?.name,
						changed ? undefined : "write",
					)
					assert.equal(
						(yield* StoredInvocations.get(db, secrets, namespace, app.id))
							.status,
						changed ? "PendingApproval" : "Approved",
					)
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							noticeLayer,
							Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
						),
					),
				),
		)
	}

	it.effect("a detached tool can ask for a decision after its Turn ends", () =>
		Effect.gen(function* () {
			const test = yield* setup("detached-tool-request")
			const store = yield* Store.Store
			const commands = yield* Decisions.RequestCommands
			const tools = yield* ToolCommands.ToolCommands
			const view = yield* test.chats.read(test.stored.request.chat)
			const turn = view.chat.turn!
			const call = Prompt.makePart("tool-call", {
				id: "background-code",
				name: "run_code",
				params: {},
				providerExecuted: false,
			})
			const item = Item.Id.make("background-step")
			yield* test.chats.modifyEffect({
				chat: view.chat.id,
				update: () =>
					Effect.succeed([
						undefined,
						Option.some({
							chat: {
								turn: {
									...turn,
									pendingStep: {
										item,
										step: 0,
										input: Prompt.make([
											{ role: "assistant", content: [call] },
										]),
										before: Prompt.empty,
										after: Prompt.empty,
									},
								},
							},
						}),
					] as const),
			})
			const submitted = yield* tools.submit(
				test.parent,
				{ chat: view.chat.id, turn: turn.id, item, step: 0 },
				call,
				{ budget: "0 millis", maxDuration: "1 hour", limit: 2 },
			)
			assert.isTrue(
				(yield* tools.detach(test.parent, submitted.executionId)).detached,
			)
			yield* store.commit(
				test.parent,
				{ status: "completed" },
				test.chats.modifyEffect({
					chat: view.chat.id,
					update: (view) =>
						TurnState.end(view, {
							turn: turn.id,
							status: Turn.Status.Completed({
								result: {
									text: "The tool runs in the background.",
									finishReason: "stop",
								},
							}),
							completedAt: 1,
							items: [],
						}).pipe(
							Effect.map(
								({ mutation }) => [undefined, Option.some(mutation)] as const,
							),
						),
				}),
			)
			const tool = yield* store.takeOver({
				namespace: test.parent.namespace,
				id: submitted.executionId,
			})
			const input = {
				...test.submission,
				continuation: "workflow" as const,
				toolCallId: "code-write",
			}
			const command = Execution.CommandKey.make("background-request")
			const receipt = yield* commands.submit(tool, command, input)
			assert.deepEqual(yield* commands.submit(tool, command, input), receipt)
			const key = { namespace: tool.namespace, id: receipt.executionId }
			const saved = yield* commands.load(key)
			assert.equal(saved.sourceKey.id, tool.id)
			assert.equal(saved.stored.request.turn, turn.id)
			assert.deepEqual(saved.execution.identity.actor, actor)
			assert.equal(saved.continuation, "workflow")
			const next = yield* store.takeOver(tool)
			assert.deepEqual(yield* commands.submit(tool, command, input), receipt)
			assert.isTrue(
				Schema.is(Execution.Conflict)(
					yield* commands
						.submit(tool, Execution.CommandKey.make("stale-source"), input)
						.pipe(Effect.flip),
				),
			)
			const access = yield* Access
			yield* Ref.update(access, (state) => ({ ...state, source: false }))
			assert.isTrue(
				Schema.is(Execution.Forbidden)(
					yield* commands.submit(next, command, input).pipe(Effect.flip),
				),
			)
			yield* Ref.update(access, (state) => ({ ...state, source: true }))
			yield* commands.decide(key, actor, {
				commandKey: Execution.CommandKey.make("allow-background"),
				decisionId: Decisions.decisionId(saved.stored.request),
				answer: "allow",
			})
			const requestOwner = yield* store.takeOver(key)
			assert.equal(
				(yield* commands.finish(requestOwner, { status: "completed" }))
					.executionId,
				key.id,
			)
			yield* store.cancel(next, Execution.CommandKey.make("stop-tool"), actor)
			assert.isTrue(
				Schema.is(Execution.Conflict)(
					yield* commands
						.submit(next, Execution.CommandKey.make("cancelled-source"), input)
						.pipe(Effect.flip),
				),
			)
		}).pipe(
			Effect.provide(
				ToolCommands.layer.pipe(
					Layer.provide(
						Layer.mock(Calls.Calls, {
							authorize: () => Effect.void,
							ready: () => Effect.void,
						}),
					),
				),
			),
		),
	)

	for (const answer of [
		"grant",
		"rule",
		"pass",
		"deny",
		"revoked",
		"changed-rule",
	] as const) {
		it.effect(`a Bot review records ${answer} with its durable decision`, () =>
			Effect.gen(function* () {
				const reviewer = BotId.make(`decider-${answer}`)
				const test = yield* setup(`request-bot-${answer}`, {}, { reviewer })
				const grants = yield* Grants.Grants
				const rules = yield* Rules.Rules
				const store = yield* Store.Store
				const judgments = yield* Ref.make(0)
				const grant =
					answer === "grant" || answer === "revoked"
						? Option.some(
								yield* grants.create(actor.organizationId, {
									bot: reviewer,
									capability: test.submission.capability,
									effect: "allow",
									scope: "lifetime",
									grantedBy: { _tag: "Person", userId: actor.userId },
								}),
							)
						: Option.none()
				const rule =
					answer === "rule" || answer === "changed-rule"
						? Option.some(
								yield* rules.create(actor.organizationId, {
									bot: reviewer,
									author: { _tag: "Person", userId: actor.userId },
									text: "Allow this write.",
									status: "active",
								}),
							)
						: Option.none()
				const policy = Layer.effect(
					CapabilityAccess.CapabilityAccess,
					Effect.gen(function* () {
						const actual = yield* CapabilityAccess.CapabilityAccess
						return {
							...actual,
							holding: (input: CapabilityAccess.HoldingInput) =>
								actual.holding(input).pipe(
									Effect.tap(() =>
										Effect.gen(function* () {
											if (answer === "revoked" && Option.isSome(grant))
												yield* grants.revoke(
													actor.organizationId,
													reviewer,
													grant.value.id,
												)
											if (answer === "changed-rule" && Option.isSome(rule))
												yield* rules.update(
													actor.organizationId,
													reviewer,
													rule.value.id,
													{ expected: rule.value.version, status: "retired" },
												)
										}).pipe(Effect.orDie),
									),
								),
						}
					}),
				).pipe(Layer.provide(CapabilityAccess.layer))
				const services = Layer.mergeAll(
					BotDecisions.layer.pipe(Layer.provideMerge(policy)),
					Reviews.layer.pipe(Layer.provide(Inputs.layer)),
				).pipe(
					Layer.provideMerge(
						Layer.mock(Bots, {
							find: () =>
								Effect.succeedSome({ ...BotFixture.bot, id: reviewer }),
						}),
					),
					Layer.provide(
						Layer.mock(Judge, {
							decide: (input) =>
								Ref.update(judgments, (n) => n + 1).pipe(
									Effect.as({
										decision: input.rules.length === 0 ? "no_match" : "allow",
										citations: Arr.map(input.rules, (rule) => ({
											rule: rule.id,
											quote: rule.text,
										})),
										explanation: "The Rule allows this.",
									}),
								),
						}),
					),
				)
				yield* Effect.gen(function* () {
					const reviews = yield* Reviews.RequestReviews
					const key = Option.getOrThrow(yield* reviews.start(test.fence, 0))
					const fence = yield* store.takeOver(key)
					const decisions = yield* BotDecisions.BotDecisions
					const input = {
						allow: answer !== "deny",
						...(answer === "deny"
							? {
									reason: "The decider has a question.",
									question: "Which note?",
								}
							: { scope: "once" as const }),
					}
					const command = Execution.CommandKey.make(
						`review-tool:bot-answer-${answer}`,
					)
					assert.deepEqual(yield* decisions.forReview(fence), test.key)
					if (answer === "pass") {
						const reader = yield* BotDecisions.make.pipe(
							Effect.provideService(Store.Store, {
								...store,
								receipt: (...args) =>
									decisions
										.decide(test.key, fence, command, input)
										.pipe(Effect.andThen(store.receipt(...args))),
							}),
						)
						const raced = yield* reader.readDecision(
							test.key,
							fence,
							command,
							input,
						)
						assert.isTrue(Option.isSome(raced))
						assert.equal(Option.getOrThrow(raced).outcome, "passed")
					}
					const registered = yield* ReviewTools.register(fence)
					const toolkit = yield* Toolkit.make(
						...Rec.values(registered.tools),
					).pipe(Effect.provideContext(registered.handlers))
					const resultParts = yield* toolkit
						.handle(
							answer === "deny"
								? ReviewTools.names.ask
								: ReviewTools.names.approve,
							answer === "deny"
								? { question: "Which note?" }
								: { scope: "once" },
							"model-call",
						)
						.pipe(
							Effect.flatMap(Stream.runCollect),
							Effect.provideService(CallContext, {
								fence,
								id: Execution.CallId.make(`bot-answer-${answer}`),
							}),
						)
					assert.notProperty(resultParts[0]?.result, "failure")
					const next = yield* store.takeOver(key)
					const rebuilt = yield* ReviewTools.register(next)
					const name =
						answer === "deny"
							? ReviewTools.names.ask
							: ReviewTools.names.approve
					const read = Context.get(rebuilt.tools[name].annotations, SavedResult)
					if (read === undefined)
						return yield* Effect.die("The command has no saved result reader.")
					const raw =
						answer === "deny" ? { question: "Which note?" } : { scope: "once" }
					assert.deepEqual(
						yield* read(Execution.CallId.make(`bot-answer-${answer}`), raw),
						Option.some(resultParts[0]!.result),
					)
					assert.isTrue(
						Option.isNone(
							yield* read(Execution.CallId.make("missing-command"), raw),
						),
					)
					const result = yield* decisions.decide(
						test.key,
						fence,
						command,
						input,
					)
					assert.deepEqual(
						resultParts[0]?.result,
						result.outcome === "passed"
							? { passedUp: true }
							: { decided: result.outcome },
					)
					const count = yield* Ref.get(judgments)
					assert.deepStrictEqual(
						yield* decisions.decide(test.key, fence, command, input),
						result,
					)
					assert.equal(yield* Ref.get(judgments), count)
					assert.equal(
						result.outcome,
						answer === "grant" || answer === "rule"
							? "allowed"
							: answer === "deny"
								? "denied"
								: "passed",
					)
					const request = (yield* (yield* Decisions.RequestCommands).load(
						test.key,
					)).stored.request
					assert.equal(request.revision, 1)
					if (result.outcome === "passed") {
						assert.equal(request.approver._tag, "Person")
						assert.equal(request.endorsements.length, 1)
						assert.ok(
							Option.isSome(
								yield* store.decision(test.key, Decisions.decisionId(request)),
							),
						)
						assert.equal(
							(yield* grants.list(actor.organizationId, test.bot)).length,
							0,
						)
					} else assert.equal(request.status, result.outcome)
					if (answer === "deny")
						assert.equal(request.decision?.question, "Which note?")
					assert.ok(
						Schema.is(Execution.KeyConflict)(
							yield* decisions
								.decide(test.key, fence, command, {
									...input,
									reason: "Other data.",
								})
								.pipe(Effect.flip),
						),
					)
					const sql = yield* PgClient.PgClient
					assert.equal(
						(yield* sql`select * from openbot_audit_logs where resource = ${request.id} and action = 'capability.decided'`)
							.length,
						1,
					)
				}).pipe(Effect.provide(services))
			}),
		)
	}
	it.effect(
		"a rule proposal, audit and receipt commit once after a failed write",
		() =>
			Effect.gen(function* () {
				const reviewer = BotId.make("proposal-reviewer")
				const test = yield* setup("request-rule-proposal", {}, { reviewer })
				const store = yield* Store.Store
				const rules = yield* Rules.Rules
				const services = Layer.mergeAll(
					ReviewTools.layer.pipe(
						Layer.provide(Calls.layer),
						Layer.provide(
							Layer.mock(ModelRegistry, { defaultModel: Option.none() }),
						),
						Layer.provide(Layer.mock(Billing, {})),
					),
					BotDecisions.layer.pipe(Layer.provide(CapabilityAccess.layer)),
					Reviews.layer.pipe(Layer.provide(Inputs.layer)),
				).pipe(
					Layer.provide(
						Layer.mock(Bots, {
							find: () =>
								Effect.succeedSome({ ...BotFixture.bot, id: reviewer }),
						}),
					),
					Layer.provide(
						Layer.mock(Judge, {
							decide: () => Effect.die("A proposal needs no model."),
						}),
					),
				)
				yield* Effect.gen(function* () {
					const key = Option.getOrThrow(
						yield* (yield* Reviews.RequestReviews).start(test.fence, 0),
					)
					const fence = yield* store.takeOver(key)
					const decisions = yield* BotDecisions.BotDecisions
					const sql = yield* PgClient.PgClient
					const command = Execution.CommandKey.make("review-tool:rule-proposal")
					const input = { text: "The Bot may read these notes." }
					yield* sql`create function reject_proposal_receipt() returns trigger language plpgsql as $$ begin if NEW.key = 'review-tool:rule-proposal' then raise exception 'Fixture receipt failure'; end if; return NEW; end $$`
					yield* sql`create trigger reject_proposal_receipt before insert on openbot_execution_commands for each row execute function reject_proposal_receipt()`
					yield* Effect.addFinalizer(() =>
						sql`drop trigger if exists reject_proposal_receipt on openbot_execution_commands`.pipe(
							Effect.andThen(
								sql`drop function if exists reject_proposal_receipt()`,
							),
							Effect.orDie,
						),
					)
					const failure = yield* decisions
						.propose(test.key, fence, command, input)
						.pipe(Effect.flip)
					assert.isTrue(Schema.is(Execution.StorageError)(failure))
					assert.equal(
						(yield* rules.list(actor.organizationId, test.bot)).length,
						0,
					)
					const audits = sql`select * from openbot_audit_logs where resource = ${test.bot} and action = 'rule.created'`
					assert.equal((yield* audits).length, 0)
					yield* sql`drop trigger reject_proposal_receipt on openbot_execution_commands`
					const results = yield* Effect.forEach(
						Arr.range(1, 8),
						() => decisions.propose(test.key, fence, command, input),
						{ concurrency: 4 },
					)
					const first = results[0]!
					assert.isTrue(
						Arr.every(results, (result) => result.ruleId === first.ruleId),
					)
					const saved = yield* rules.list(actor.organizationId, test.bot)
					assert.equal(saved.length, 1)
					assert.equal(saved[0]?.id, first.ruleId)
					assert.equal(saved[0]?.status, "proposed")
					assert.deepEqual(saved[0]?.author, { _tag: "Bot", bot: reviewer })
					assert.equal((yield* audits).length, 1)
					const clash = yield* decisions
						.propose(test.key, fence, command, { text: "Other notes." })
						.pipe(Effect.flip)
					assert.isTrue(Schema.is(Execution.KeyConflict)(clash))
					const next = yield* store.takeOver(key)
					const registered = yield* (yield* ReviewTools.ReviewTools).register(
						next,
					)
					const toolkit = yield* Toolkit.make(
						...Rec.values(registered.tools),
					).pipe(Effect.provideContext(registered.handlers))
					const invoke = (owner: Store.Fence) =>
						toolkit
							.handle(ReviewTools.names.proposeRule, input, "provider-call")
							.pipe(
								Effect.flatMap(Stream.runCollect),
								Effect.map((parts) => parts[0]?.result),
								Effect.provideService(CallContext, {
									fence: owner,
									id: Execution.CallId.make("rule-proposal"),
								}),
							)
					assert.deepEqual(yield* invoke(next), { proposed: first.ruleId })
					assert.property(yield* invoke(fence), "failure")
					assert.deepEqual(
						yield* decisions.propose(test.key, next, command, input),
						first,
					)
					const stale = yield* decisions
						.propose(
							test.key,
							fence,
							Execution.CommandKey.make("stale-proposal"),
							input,
						)
						.pipe(Effect.flip)
					assert.isTrue(Schema.is(Execution.Conflict)(stale))
					const access = yield* Access
					yield* Ref.update(access, (state) => ({ ...state, source: false }))
					const denied = yield* decisions
						.propose(test.key, next, command, input)
						.pipe(Effect.flip)
					assert.isTrue(Schema.is(Execution.Forbidden)(denied))
					yield* Ref.update(access, (state) => ({ ...state, source: true }))
					yield* store.cancel(
						test.key,
						Execution.CommandKey.make("cancel-before-proposal"),
						actor,
					)
					const cancelled = yield* decisions
						.propose(
							test.key,
							next,
							Execution.CommandKey.make("cancelled-proposal"),
							input,
						)
						.pipe(Effect.flip)
					assert.isTrue(Schema.is(Execution.Conflict)(cancelled))
					assert.equal(
						(yield* rules.list(actor.organizationId, test.bot)).length,
						1,
					)
				}).pipe(Effect.provide(services))
			}),
	)

	for (const choice of [
		"bot",
		"default",
		"linked",
		"missing",
		"invalid",
	] as const) {
		it.effect(`a review uses the ${choice} model rule`, () =>
			Effect.gen(function* () {
				const reviewer = BotId.make(`model-reviewer-${choice}`)
				const test = yield* setup(`review-model-${choice}`, {}, { reviewer })
				const reads = yield* Ref.make(0)
				const first = DevelopmentModel.selection
				const second = Config.Selection.make({
					...first,
					model: Model.Id.make("second"),
				})
				const missing = Config.Selection.make({
					...first,
					model: Model.Id.make("missing"),
				})
				const catalog = {
					providers: [{ id: first.provider, name: "Test" }],
					models: Arr.map([first, second], (model) =>
						Config.Model.make({
							provider: model.provider,
							id: model.model,
							name: "Test",
							reasoningEfforts: [],
							serviceTiers: [],
						}),
					),
				}
				const services = Reviews.layer.pipe(
					Layer.provide(Inputs.layer),
					Layer.provide(
						Layer.mergeAll(
							Layer.mock(Bots, {
								find: () =>
									Effect.succeedSome({
										...BotFixture.bot,
										id: reviewer,
										...(choice === "bot"
											? { model: second }
											: choice === "linked" || choice === "invalid"
												? { model: missing }
												: {}),
										...(choice === "linked"
											? { source: { organizationId: "outside", bot: reviewer } }
											: {}),
									}),
							}),
							Layer.mock(ModelRegistry, {
								defaultModel:
									choice === "missing" ? Option.none() : Option.some(first),
								catalog: () =>
									Ref.updateAndGet(reads, (count) => count + 1).pipe(
										Effect.flatMap((count) =>
											count === 1
												? Effect.succeed(catalog)
												: Effect.fail(
														Config.ModelConfigurationError.make({
															reason: "model-not-found",
															message: "The catalog is not available.",
														}),
													),
										),
									),
							}),
						),
					),
				)
				yield* Effect.gen(function* () {
					const reviews = yield* Reviews.RequestReviews
					if (choice === "missing" || choice === "invalid") {
						assert.isTrue(
							Schema.is(ChatModelInvalid)(
								yield* reviews.start(test.fence, 0).pipe(Effect.flip),
							),
						)
						const sql = yield* PgClient.PgClient
						assert.lengthOf(
							yield* sql`select id from openbot_chats where id = ${`chat_review_${test.key.id}_0`}`,
							0,
						)
						assert.lengthOf(
							Arr.filter(
								yield* (yield* Store.Store).events(test.key, 0),
								(event) => event.body._tag === "ChildExecution",
							),
							0,
						)
						return
					}
					const started = yield* reviews.start(test.fence, 0)
					assert.isTrue(Option.isSome(started))
					if (Option.isNone(started)) return
					const db = yield* Db.make
					const chat = yield* StoredChats.ref(
						db,
						started.value.namespace,
						Chat.Id.make(`chat_review_${test.key.id}_0`),
					)
					assert.deepEqual(
						Option.getOrThrow(chat).settings.model,
						choice === "bot" ? second : first,
					)
					assert.deepEqual(yield* reviews.start(test.fence, 0), started)
					assert.equal(yield* Ref.get(reads), 1)
				}).pipe(Effect.provide(services))
			}),
		)
	}

	for (const mode of [
		"pending",
		"deny",
		"once",
		"rollback",
		"ask wins",
		"allow wins",
		"answer write failure",
		"check answer failure",
		"nested requests",
		"nested grants",
		"pending rights revoked",
		"approved rights revoked",
	] as const) {
		it.effect(`the durable gate keeps its call through ${mode}`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`durable-gate-${mode}`)
				const store = yield* Store.Store
				const grants = yield* Grants.Grants
				const records = yield* Requests.Requests
				const turns = yield* TurnContext
				const view = yield* test.chats.read(test.stored.request.chat)
				const turn = view.chat.turn!
				const call = Prompt.makePart("tool-call", {
					id: "gate-call",
					name: "write",
					params: { text: "A private note." },
					providerExecuted: false,
				})
				yield* test.chats.modifyEffect({
					chat: view.chat.id,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: {
									turn: {
										...turn,
										action: {
											name: "write",
											arguments: {},
											source: { view: "private-view" },
										},
										pendingStep: {
											item: Item.Id.make("gate-step"),
											step: 0,
											input: Prompt.empty,
											before: Prompt.make([
												{ role: "assistant", content: [call] },
											]),
											after: Prompt.empty,
										},
									},
								},
							}),
						] as const),
				})
				const identity = (yield* store.loadMember(test.parent)).identity
				const current = yield* turns.prepare({
					identity,
					namespace: test.parent.namespace,
					chat: view.chat.id,
					turn: turn.id,
					host: ChatHost.hostState(view.chat),
				})
				const build = (fence: Store.Fence) =>
					Gate.durable(fence, current).pipe(
						Effect.provide(
							Layer.mergeAll(
								Layer.mock(Bots, {}),
								Layer.mock(Billing, {}),
								Layer.mock(Calls.Calls, {
									authorize: () => Effect.void,
									ready: () => Effect.void,
								}),
							),
						),
					)
				const attempt = {
					capability: test.submission.capability,
					reason: "Write this note.",
					site: { main: call.id, path: [] },
				}
				if (mode === "nested requests" || mode === "nested grants") {
					if (mode === "nested grants")
						yield* grants.create(actor.organizationId, {
							bot: test.bot,
							capability: attempt.capability,
							effect: "allow",
							scope: "once",
							grantedBy: { _tag: "Person", userId: actor.userId },
						})
					const gate = yield* build(test.parent)
					const nested = (index: number): Gate.Attempt => ({
						...attempt,
						site: { main: call.id, path: ["code", String(index)] },
						code: {
							run: CodeDomain.CodeRunId.make("program"),
							index,
							code: "return await apps.write({})",
						},
					})
					const first = yield* gate.check(nested(0))
					const second = yield* gate.check(nested(1))
					assert.equal(
						first._tag,
						mode === "nested grants" ? "Allow" : "Pending",
					)
					assert.equal(second._tag, "Pending")
					if (first._tag === "Pending" && second._tag === "Pending")
						assert.notEqual(first.request, second.request)
					assert.deepEqual(yield* gate.check(nested(0)), first)
					assert.deepEqual(yield* gate.check(nested(1)), second)
					assert.isTrue(Option.isNone(yield* gate.answer(call.id)))
					const resumed = yield* build(yield* store.takeOver(test.parent))
					assert.deepEqual(yield* resumed.check(nested(0)), first)
					assert.deepEqual(yield* resumed.check(nested(1)), second)
					const pending = Arr.filter(
						yield* records.forChat(actor.organizationId, view.chat.id),
						(saved) => saved.request.code !== undefined,
					)
					assert.lengthOf(pending, mode === "nested grants" ? 1 : 2)
					assert.isTrue(
						Arr.every(pending, (saved) => saved.request.toolCallId === call.id),
					)
					return
				}
				if (
					mode === "pending rights revoked" ||
					mode === "approved rights revoked"
				) {
					const gate = yield* build(test.parent)
					const first = yield* gate.check(attempt)
					if (first._tag !== "Pending") return assert.fail("Expected a request")
					if (mode === "approved rights revoked")
						yield* records.decide(actor.organizationId, first.request, {
							by: { _tag: "Person", userId: actor.userId },
							allow: true,
						})
					const grant = yield* grants.create(actor.organizationId, {
						bot: test.bot,
						capability: attempt.capability,
						effect: "allow",
						scope: "once",
						grantedBy: { _tag: "Person", userId: actor.userId },
					})
					const rights = yield* Access
					yield* Effect.addFinalizer(() =>
						Ref.update(rights, (state) => ({ ...state, resolve: true })),
					)
					yield* Ref.update(rights, (state) => ({ ...state, resolve: false }))
					assert.equal((yield* gate.check(attempt))._tag, "Deny")
					const resumed = yield* build(yield* store.takeOver(test.parent))
					assert.equal((yield* resumed.check(attempt))._tag, "Deny")
					yield* Ref.update(rights, (state) => ({ ...state, resolve: true }))
					assert.deepEqual(yield* resumed.check(attempt), first)
					assert.equal(
						Option.getOrThrow(
							yield* grants.match({
								organizationId: actor.organizationId,
								bot: test.bot,
								capability: attempt.capability,
								chat: view.chat.id,
							}),
						).id,
						grant.id,
					)
					assert.lengthOf(
						yield* records.forChat(actor.organizationId, view.chat.id),
						2,
					)
					return
				}

				if (mode === "once" || mode === "deny")
					yield* grants.create(actor.organizationId, {
						bot: test.bot,
						capability: attempt.capability,
						effect: mode === "once" ? "allow" : "deny",
						scope: "once",
						grantedBy: { _tag: "Person", userId: actor.userId },
					})
				if (
					mode === "answer write failure" ||
					mode === "check answer failure"
				) {
					const unavailable = yield* Ref.make(mode === "answer write failure")
					const commands = yield* Decisions.RequestCommands
					if (mode === "check answer failure")
						yield* grants.create(actor.organizationId, {
							bot: test.bot,
							capability: attempt.capability,
							effect: "allow",
							scope: "lifetime",
							grantedBy: { _tag: "Person", userId: actor.userId },
						})
					const reachedApproval = yield* Ref.make(false)
					const gate = yield* build(test.parent).pipe(
						Effect.provideService(Decisions.RequestCommands, {
							...commands,
							admit: (fence, key, input) =>
								commands
									.admit(fence, key, input)
									.pipe(Effect.tap(() => Ref.set(unavailable, true))),
						}),
						Effect.provideService(Store.Store, {
							...store,
							loadMember: (key) =>
								Ref.getAndSet(unavailable, false).pipe(
									Effect.flatMap((fail) =>
										fail
											? Effect.die("The saved call cannot be read.")
											: store.loadMember(key),
									),
								),
						}),
					)
					const result = yield* (
						mode === "check answer failure"
							? gate.check(attempt)
							: gate.remember(
									call.id,
									Gate.Answer.Deny({ reason: "The App is closed." }),
								)
					).pipe(
						Effect.andThen(Ref.set(reachedApproval, true)),
						Effect.andThen(
							Approvals.durable(gate).decide({
								chat: view.chat.id,
								turn: turn.id,
								approvalId: "approval",
								toolCall: call,
							}),
						),
						Effect.exit,
					)
					assert.isTrue(Exit.isFailure(result))
					assert.isFalse(yield* Ref.get(reachedApproval))
					assert.isFalse(yield* Ref.get(unavailable))
					assert.lengthOf(
						yield* records.forChat(actor.organizationId, view.chat.id),
						1,
					)
					// A new attempt can save the denial once storage is back.
					yield* gate.remember(
						call.id,
						Gate.Answer.Deny({ reason: "The App is closed." }),
					)
					assert.equal(
						(yield* Approvals.durable(gate).decide({
							chat: view.chat.id,
							turn: turn.id,
							approvalId: "approval",
							toolCall: call,
						}))._tag,
						"Deny",
					)
					return
				}
				const waiting = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const checks = yield* Ref.make(0)
				const race = mode === "ask wins" || mode === "allow wins"
				const commands = yield* Decisions.RequestCommands
				const gate = yield* build(test.parent).pipe(
					Effect.provideService(Decisions.RequestCommands, {
						...commands,
						submitted: (fence, key, input) =>
							Effect.gen(function* () {
								const prior = yield* commands.submitted(fence, key, input)
								if (
									race &&
									(yield* Ref.getAndUpdate(checks, (n) => n + 1)) === 0
								) {
									yield* Deferred.succeed(waiting, undefined)
									yield* Deferred.await(release)
								}
								return prior
							}),
					}),
				)
				if (race) {
					const allow = grants.create(actor.organizationId, {
						bot: test.bot,
						capability: attempt.capability,
						effect: "allow",
						scope: "lifetime",
						grantedBy: { _tag: "Person", userId: actor.userId },
					})
					const delayed = yield* gate.check(attempt).pipe(Effect.forkScoped)
					yield* Deferred.await(waiting)
					const grant =
						mode === "allow wins" ? Option.some(yield* allow) : Option.none()
					const first = yield* gate.check(attempt)
					if (Option.isSome(grant))
						yield* grants.revoke(actor.organizationId, test.bot, grant.value.id)
					else yield* allow
					yield* Deferred.succeed(release, undefined)
					const second = yield* Fiber.join(delayed)
					assert.equal(first._tag, mode === "ask wins" ? "Pending" : "Allow")
					assert.equal(second._tag, mode === "ask wins" ? "Pending" : "Deny")
					assert.lengthOf(
						yield* records.forChat(actor.organizationId, view.chat.id),
						mode === "ask wins" ? 2 : 1,
					)
					return
				}
				const sql = yield* PgClient.PgClient
				if (mode === "rollback") {
					yield* sql`create function reject_gate_command() returns trigger language plpgsql as $$ begin if NEW.key like 'request:%' then raise exception 'Fixture gate write failure'; end if; return NEW; end $$`
					yield* sql`create trigger reject_gate_command before insert on openbot_execution_commands for each row execute function reject_gate_command()`
					yield* Effect.addFinalizer(() =>
						sql`drop trigger if exists reject_gate_command on openbot_execution_commands`.pipe(
							Effect.orDie,
						),
					)
					assert.equal((yield* gate.check(attempt))._tag, "Deny")
					assert.lengthOf(
						yield* records.forChat(actor.organizationId, view.chat.id),
						1,
					)
					yield* sql`drop trigger reject_gate_command on openbot_execution_commands`
				}
				const first = yield* gate.check(attempt)
				assert.equal(
					first._tag,
					mode === "once" ? "Allow" : mode === "deny" ? "Deny" : "Pending",
				)
				const approval = yield* Approvals.durable(gate).decide({
					chat: view.chat.id,
					turn: turn.id,
					approvalId: "approval",
					toolCall: call,
				})
				assert.equal(approval._tag, first._tag)
				if (first._tag !== "Allow" && first.request !== undefined) {
					const saved = Option.getOrThrow(
						yield* records.find(actor.organizationId, first.request),
					)
					assert.deepEqual(saved.call, {
						name: call.name,
						params: { text: "A private note." },
						source: { view: "private-view" },
					})
				}
				// A new allow Grant must not run a call that a saved request will deliver.
				if (mode === "pending" || mode === "rollback")
					yield* grants.create(actor.organizationId, {
						bot: test.bot,
						capability: attempt.capability,
						effect: "allow",
						scope: "lifetime",
						grantedBy: { _tag: "Person", userId: actor.userId },
					})
				const next = yield* store.takeOver(test.parent)
				const resumed = yield* build(next)
				assert.deepEqual(yield* resumed.check(attempt), first)
				assert.lengthOf(
					yield* records.forChat(actor.organizationId, view.chat.id),
					mode === "once" ? 1 : 2,
				)
				// A second model step may reuse the ID with new parameters.
				const latest = (yield* test.chats.read(view.chat.id)).chat.turn!
				const reused = Prompt.makePart("tool-call", {
					...call,
					params: { text: "A new note." },
				})
				yield* test.chats.modifyEffect({
					chat: view.chat.id,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: {
									turn: {
										...latest,
										pendingStep: {
											...latest.pendingStep!,
											item: Item.Id.make("next-gate-step"),
											step: 1,
											before: Prompt.make([
												{ role: "assistant", content: [reused] },
											]),
										},
									},
								},
							}),
						] as const),
				})
				const nextApproval = yield* Approvals.durable(resumed).decide({
					chat: view.chat.id,
					turn: turn.id,
					approvalId: "next-approval",
					toolCall: reused,
				})
				assert.equal(
					nextApproval._tag,
					mode === "once" ? "Pending" : mode === "deny" ? "Deny" : "Allow",
				)
				assert.lengthOf(
					yield* records.forChat(actor.organizationId, view.chat.id),
					mode === "deny" ? 3 : 2,
				)

				const access = yield* Access
				yield* Effect.addFinalizer(() =>
					Ref.update(access, (state) => ({ ...state, source: true })),
				)
				yield* Ref.update(access, (state) => ({ ...state, source: false }))
				assert.isTrue(
					Exit.isFailure(yield* resumed.check(attempt).pipe(Effect.exit)),
				)
				const failures =
					yield* sql`select cause from openbot_execution_failures where execution_id = ${test.parent.id}`
				assert.isAbove(failures.length, 0)
				assert.notInclude(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
						failures,
					),
					"A private note.",
				)
			}),
		)
	}

	for (const action of ["submit", "admit"] as const) {
		it.effect(
			`request ${action} checks access after waiting for its Chat lock`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`request-lock-${action}`)
					const commands = yield* Decisions.RequestCommands
					const sql = yield* PgClient.PgClient
					const db = yield* Db.make
					const access = yield* Access
					yield* Effect.addFinalizer(() =>
						Ref.update(access, (state) => ({ ...state, source: true })),
					)
					const held = yield* Deferred.make<number>()
					const release = yield* Deferred.make<void>()
					const holder = yield* sql
						.withTransaction(
							Effect.gen(function* () {
								yield* StoredChats.lock(
									db,
									test.parent.namespace,
									test.stored.request.chat,
								)
								yield* Deferred.succeed(
									held,
									(yield* sql<{
										pid: number
									}>`select pg_backend_pid() as pid`)[0]!.pid,
								)
								yield* Deferred.await(release)
							}),
						)
						.pipe(Effect.forkScoped)
					const holderPid = yield* Deferred.await(held)
					const write = yield* commands[action](
						test.parent,
						Execution.CommandKey.make("wait-for-chat"),
						test.submission,
					).pipe(Effect.forkScoped)
					yield* sql<{
						waiting: boolean
					}>`select exists(select 1 from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))) as waiting`.pipe(
						Effect.map((rows) => rows[0]?.waiting === true),
						Effect.repeat({
							while: (waiting) => !waiting,
							schedule: Schedule.spaced("10 millis"),
						}),
						Effect.timeout("5 seconds"),
					)
					yield* Ref.update(access, (state) => ({ ...state, source: false }))
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(holder)
					assert.isTrue(
						Schema.is(Execution.Forbidden)(
							yield* Fiber.join(write).pipe(Effect.flip),
						),
					)
					assert.lengthOf(
						yield* sql`select * from openbot_execution_commands where namespace = ${test.parent.namespace} and key = 'wait-for-chat'`,
						0,
					)
					assert.lengthOf(
						yield* (yield* Requests.Requests).forChat(
							actor.organizationId,
							test.stored.request.chat,
						),
						1,
					)
				}),
		)
	}

	it.effect("revoking a parent waits for a child Grant use", () =>
		Effect.gen(function* () {
			const test = yield* setup("grant-use-revoke-race")
			const grants = yield* Grants.Grants
			const root = yield* grants.create(actor.organizationId, {
				bot: test.bot,
				capability: test.submission.capability,
				effect: "allow",
				scope: "lifetime",
				grantedBy: { _tag: "Person", userId: actor.userId },
			})
			const child = yield* grants.create(actor.organizationId, {
				...root,
				parent: root.id,
				scope: "once",
			})
			const read = yield* Deferred.make<void>()
			const resume = yield* Deferred.make<void>()
			const revokeReady = yield* Deferred.make<void>()
			const held = yield* Ref.make(false)
			const records = yield* BotRecords.BotRecords
			const observed = BotRecords.BotRecords.of({
				...records,
				collection: (kind, schema, status) => {
					const collection = records.collection(kind, schema, status)
					return {
						...collection,
						find: (organizationId, id) =>
							collection.find(organizationId, id).pipe(
								Effect.tap(() =>
									Effect.gen(function* () {
										if (
											id === child.id &&
											!(yield* Ref.getAndSet(held, true))
										) {
											yield* Deferred.succeed(read, undefined)
											yield* Deferred.await(resume)
										}
									}),
								),
							),
					}
				},
				lock: (key) =>
					Effect.gen(function* () {
						if (key === `grant:${actor.organizationId}:${child.id}`)
							yield* Deferred.succeed(revokeReady, undefined)
						yield* records.lock(key)
					}),
			})
			const concurrent = yield* Grants.make.pipe(
				Effect.provideService(BotRecords.BotRecords, observed),
			)
			const use = yield* concurrent
				.use(actor.organizationId, child)
				.pipe(Effect.forkScoped)
			yield* Deferred.await(read)
			const revoke = yield* concurrent
				.revoke(actor.organizationId, test.bot, root.id)
				.pipe(
					Effect.ensuring(Deferred.succeed(revokeReady, undefined)),
					Effect.forkScoped,
				)
			// Wait for the child lock, or completion in the broken implementation.
			yield* Deferred.await(revokeReady)
			yield* Deferred.succeed(resume, undefined)
			assert.isTrue(yield* Fiber.join(use))
			yield* Fiber.join(revoke)
			assert.equal(
				Option.getOrThrow(yield* grants.find(actor.organizationId, child.id))
					.status,
				"revoked",
			)
			assert.isFalse(yield* grants.use(actor.organizationId, child))
		}),
	)

	for (const mode of [
		"replay",
		"params",
		"call",
		"notice",
		"deny race",
		"step",
		"revoke",
		"deny",
	] as const) {
		it.effect(`a saved approval checks its call through ${mode}`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`approval-use-${mode}`)
				const reply = yield* finishForReply(test)
				yield* (yield* Notices.RequestNotices).deliver(reply)
				const view = yield* test.chats.read(test.stored.request.chat)
				const turn = view.chat.turn!
				const items = yield* TurnState.inputs(
					() => Effect.succeed("approval-item"),
					view.chat.id,
					turn.id,
					0,
					view.chat.inbox,
				)
				const approved = view.chat.inbox[0]!.approved!
				const call = Prompt.toolCallPart({
					...approved,
					id: mode === "call" ? "another-call" : approved.id,
					params:
						mode === "params" ? { text: "Another note." } : approved.params,
					providerExecuted: false,
				})
				const pendingStep = {
					item: Item.Id.make("approval-step"),
					step: 0,
					input: Prompt.empty,
					before: Prompt.make([{ role: "assistant", content: [call] }]),
					after: Prompt.empty,
				}
				yield* test.chats.modifyEffect({
					chat: view.chat.id,
					update: (current) =>
						Effect.succeed([
							undefined,
							Option.some({
								...TurnState.append(
									current,
									mode === "notice"
										? Arr.map(items, (item) => ({
												...item,
												origin: { chat: view.chat.id, turn: turn.id, step: 0 },
											}))
										: items,
								),
								chat: { inbox: [], turn: { ...turn, pendingStep } },
							}),
						] as const),
				})
				const use = yield* GrantUse.make
				const check = () =>
					use.check(
						test.parent,
						Execution.mainCall(call.id),
						test.submission.capability,
					)
				const commands = yield* Decisions.RequestCommands
				const saved = (yield* commands.load(test.key)).stored
				const grantId = saved.approvalGrant!
				assert.isDefined(grantId)
				const grants = yield* Grants.Grants
				if (mode === "deny race") {
					const read = yield* Deferred.make<void>()
					const resume = yield* Deferred.make<void>()
					const count = yield* Ref.make(0)
					const raced = yield* GrantUse.make.pipe(
						Effect.provideService(Grants.Grants, {
							...grants,
							match: (input) =>
								grants.match(input).pipe(
									Effect.tap(() =>
										Effect.gen(function* () {
											if ((yield* Ref.getAndUpdate(count, (n) => n + 1)) !== 0)
												return
											yield* Deferred.succeed(read, undefined)
											yield* Deferred.await(resume)
										}),
									),
								),
						}),
					)
					const running = yield* raced
						.check(
							test.parent,
							Execution.mainCall(call.id),
							test.submission.capability,
						)
						.pipe(Effect.forkScoped)
					yield* Deferred.await(read)
					yield* grants.create(actor.organizationId, {
						bot: test.bot,
						capability: test.submission.capability,
						effect: "deny",
						scope: "lifetime",
						grantedBy: { _tag: "Person", userId: actor.userId },
					})
					yield* Deferred.succeed(resume, undefined)
					assert.equal(
						Option.getOrThrow(yield* Fiber.join(running)).effect,
						"deny",
					)
					const sql = yield* PgClient.PgClient
					assert.lengthOf(
						yield* sql`select * from openbot_grant_uses where organization_id = ${actor.organizationId} and grant_id = ${grantId}`,
						0,
					)
					return
				}
				if (mode === "params") {
					assert.isTrue(
						Schema.is(Execution.Forbidden)(yield* check().pipe(Effect.flip)),
					)
					return
				}
				if (mode === "call" || mode === "notice") {
					assert.isTrue(Option.isNone(yield* check()))
					return
				}
				if (mode === "revoke")
					yield* grants.revoke(actor.organizationId, test.bot, grantId)
				if (mode === "deny")
					yield* grants.create(actor.organizationId, {
						bot: test.bot,
						capability: test.submission.capability,
						effect: "deny",
						scope: "lifetime",
						grantedBy: { _tag: "Person", userId: actor.userId },
					})
				const result = Option.getOrThrow(yield* check())
				assert.equal(
					result.effect,
					mode === "revoke" || mode === "deny" ? "deny" : "allow",
				)
				if (mode === "revoke" || mode === "deny") return
				assert.equal(result.id, grantId)
				assert.equal(Option.getOrThrow(yield* check()).id, grantId)
				if (mode === "step") {
					yield* test.chats.modifyEffect({
						chat: view.chat.id,
						update: () =>
							Effect.succeed([
								undefined,
								Option.some({
									chat: {
										turn: {
											...turn,
											pendingStep: {
												...pendingStep,
												item: Item.Id.make("another-step"),
												step: 1,
											},
										},
									},
								}),
							] as const),
					})
					assert.isTrue(
						Schema.is(Execution.Forbidden)(yield* check().pipe(Effect.flip)),
					)
				} else {
					const next = yield* (yield* Store.Store).takeOver(test.parent)
					assert.equal(
						Option.getOrThrow(
							yield* use.check(
								next,
								Execution.mainCall(call.id),
								test.submission.capability,
							),
						).id,
						grantId,
					)
				}
				const sql = yield* PgClient.PgClient
				assert.lengthOf(
					yield* sql`select * from openbot_grant_uses where organization_id = ${actor.organizationId} and grant_id = ${grantId}`,
					1,
				)
			}).pipe(Effect.provide(noticeLayer)),
		)
	}

	for (const mode of ["repeat", "compete", "rollback", "fence"] as const) {
		it.effect(`a one-use Grant keeps its call through ${mode}`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`grant-use-${mode}`)
				const store = yield* Store.Store
				const grants = yield* Grants.Grants
				const use = yield* GrantUse.make
				const view = yield* test.chats.read(test.stored.request.chat)
				const turn = view.chat.turn!
				const item = Item.Id.make("grant-step")
				const calls = Arr.map(["first", "second", "third"], (id) =>
					Prompt.makePart("tool-call", {
						id,
						name: "write",
						params: {},
						providerExecuted: false,
					}),
				)
				yield* test.chats.modifyEffect({
					chat: view.chat.id,
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								chat: {
									turn: {
										...turn,
										pendingStep: {
											item,
											step: 0,
											input: Prompt.empty,
											before:
												mode === "rollback"
													? Prompt.make([{ role: "assistant", content: calls }])
													: Prompt.empty,
											model: {
												output:
													mode === "rollback"
														? Prompt.empty
														: Prompt.make([
																{ role: "assistant", content: calls },
															]),
												calls: [],
												finishReason: "tool-calls",
												usage: Response.Usage.make({
													inputTokens: {
														total: 1,
														uncached: 1,
														cacheRead: 0,
														cacheWrite: 0,
													},
													outputTokens: { total: 1, text: 1, reasoning: 0 },
												}),
											},
											after: Prompt.empty,
										},
									},
								},
							}),
						] as const),
				})
				const root = yield* grants.create(actor.organizationId, {
					bot: BotId.make("grant-owner"),
					capability: test.submission.capability,
					effect: "allow",
					scope: "lifetime",
					grantedBy: { _tag: "Person", userId: actor.userId },
				})
				const grant = yield* grants.create(actor.organizationId, {
					bot: test.bot,
					capability: test.submission.capability,
					effect: "allow",
					parent: root.id,
					scope: "once",
					grantedBy: { _tag: "Person", userId: actor.userId },
				})
				const check = (
					call: string,
					fence = test.parent,
					path: ReadonlyArray<string> = [],
				) => use.check(fence, { main: call, path }, test.submission.capability)
				const sql = yield* PgClient.PgClient
				if (mode === "rollback") {
					yield* sql`create function reject_grant_use() returns trigger language plpgsql as $$ begin raise exception 'Fixture Grant use failure'; end $$`
					yield* sql`create trigger reject_grant_use before insert on openbot_grant_uses for each row execute function reject_grant_use()`
					yield* Effect.addFinalizer(() =>
						sql`drop trigger if exists reject_grant_use on openbot_grant_uses`.pipe(
							Effect.orDie,
						),
					)
					assert.isTrue(
						Schema.is(Execution.StorageError)(
							yield* check("first").pipe(Effect.flip),
						),
					)
					assert.equal(
						Option.getOrThrow(
							yield* grants.find(actor.organizationId, grant.id),
						).status,
						"active",
					)
					assert.lengthOf(
						yield* sql`select * from openbot_grant_uses where organization_id = ${actor.organizationId} and grant_id = ${grant.id}`,
						0,
					)
					yield* sql`drop trigger reject_grant_use on openbot_grant_uses`
				}
				if (mode === "compete") {
					const answers = yield* Effect.all([check("first"), check("second")], {
						concurrency: 2,
					})
					assert.equal(Arr.filter(answers, Option.isSome).length, 1)
					assert.equal(Arr.filter(answers, Option.isNone).length, 1)
				} else {
					const answers = yield* Effect.forEach(
						Arr.range(1, 8),
						() => check("first"),
						{ concurrency: 8 },
					)
					assert.isTrue(
						Arr.every(answers, (answer) =>
							Option.exists(
								answer,
								(found) => found.id === grant.id && found.effect === "allow",
							),
						),
					)
					const next = yield* store.takeOver(test.parent)
					assert.equal(
						Option.getOrThrow(yield* check("first", next)).id,
						grant.id,
					)
					assert.isTrue(
						Schema.is(Execution.KeyConflict)(
							yield* use
								.check(next, Execution.mainCall("first"), {
									...test.submission.capability,
									target: "changed",
								})
								.pipe(Effect.flip),
						),
					)
					if (mode === "fence") {
						yield* grants.create(actor.organizationId, {
							bot: test.bot,
							capability: test.submission.capability,
							effect: "allow",
							scope: "once",
							grantedBy: { _tag: "Person", userId: actor.userId },
						})
						assert.isTrue(
							Schema.is(Execution.Conflict)(
								yield* check("second").pipe(Effect.flip),
							),
						)
						yield* store.cancel(
							next,
							Execution.CommandKey.make("cancel-grant-use"),
							actor,
						)
						assert.isTrue(
							Schema.is(Execution.Conflict)(
								yield* check("second", next).pipe(Effect.flip),
							),
						)
					} else {
						const toolCommands = yield* ToolCommands.ToolCommands
						const child = yield* toolCommands.submit(
							next,
							{ chat: view.chat.id, turn: turn.id, item, step: 0 },
							calls[0]!,
							{ budget: "0 millis", maxDuration: "1 hour", limit: 1 },
						)
						yield* toolCommands.detach(next, child.executionId)
						const sibling = yield* toolCommands.submit(
							next,
							{ chat: view.chat.id, turn: turn.id, item, step: 0 },
							calls[1]!,
							{ budget: "0 millis", maxDuration: "1 hour", limit: 1 },
						)
						yield* toolCommands.detach(next, sibling.executionId)
						yield* store.commit(next, { status: "completed" }, Effect.void)
						const other = yield* store.takeOver({
							namespace: next.namespace,
							id: sibling.executionId,
						})
						// A child cannot name a sibling as its main call.
						assert.isTrue(
							Schema.is(Execution.Conflict)(
								yield* check("first", other).pipe(Effect.flip),
							),
						)
						// A nested call cannot take the Grant of a sibling main call.
						assert.isTrue(
							Option.isNone(yield* check("second", other, ["first"])),
						)
						const nested = yield* grants.create(actor.organizationId, {
							bot: test.bot,
							capability: test.submission.capability,
							effect: "allow",
							scope: "once",
							grantedBy: { _tag: "Person", userId: actor.userId },
						})
						assert.equal(
							Option.getOrThrow(yield* check("second", other, ["first"])).id,
							nested.id,
						)
						assert.equal(
							Option.getOrThrow(yield* check("second", other, ["first"])).id,
							nested.id,
						)
						assert.isTrue(Option.isNone(yield* check("second", other)))
						const tool = yield* store.takeOver({
							namespace: next.namespace,
							id: child.executionId,
						})
						assert.equal(
							Option.getOrThrow(yield* check("first", tool)).id,
							grant.id,
						)
						const access = yield* Access
						yield* Ref.update(access, (state) => ({ ...state, source: false }))
						assert.isTrue(
							Schema.is(Execution.Forbidden)(
								yield* check("first", tool).pipe(Effect.flip),
							),
						)
						yield* Ref.update(access, (state) => ({ ...state, source: true }))
						const denied = yield* grants.create(actor.organizationId, {
							bot: test.bot,
							capability: test.submission.capability,
							effect: "deny",
							scope: "lifetime",
							grantedBy: { _tag: "Person", userId: actor.userId },
						})
						assert.equal(
							Option.getOrThrow(yield* check("first", tool)).effect,
							"deny",
						)
						yield* grants.revoke(actor.organizationId, test.bot, denied.id)
						assert.equal(
							Option.getOrThrow(yield* check("first", tool)).effect,
							"allow",
						)
						yield* grants.revoke(actor.organizationId, root.bot, root.id)
						assert.equal(
							Option.getOrThrow(yield* check("first", tool)).effect,
							"deny",
						)
					}
				}
				assert.lengthOf(
					yield* sql`select * from openbot_grant_uses where organization_id = ${actor.organizationId} and grant_id = ${grant.id}`,
					1,
				)
				const events = yield* store.events(test.parent, 0)
				assert.lengthOf(
					Arr.filter(
						events,
						(event) =>
							event.body._tag === "Checkpoint" &&
							event.body.resource.kind === "Grant" &&
							event.body.resource.id === grant.id,
					),
					1,
				)
			}).pipe(
				Effect.provide(
					ToolCommands.layer.pipe(
						Layer.provide(
							Layer.mock(Calls.Calls, {
								authorize: () => Effect.void,
								ready: () => Effect.void,
							}),
						),
					),
				),
			),
		)
	}

	it.effect(
		"a Bot answer rolls back Grants and signals when its receipt fails",
		() =>
			Effect.gen(function* () {
				const reviewer = BotId.make("decider-rollback")
				const test = yield* setup("request-bot-rollback", {}, { reviewer })
				const store = yield* Store.Store
				const grants = yield* Grants.Grants
				yield* grants.create(actor.organizationId, {
					bot: reviewer,
					capability: test.submission.capability,
					effect: "allow",
					scope: "lifetime",
					grantedBy: { _tag: "Person", userId: actor.userId },
				})
				const services = Layer.mergeAll(
					BotDecisions.layer.pipe(Layer.provide(CapabilityAccess.layer)),
					Reviews.layer.pipe(Layer.provide(Inputs.layer)),
				).pipe(
					Layer.provide(
						Layer.mock(Bots, {
							find: () =>
								Effect.succeedSome({ ...BotFixture.bot, id: reviewer }),
						}),
					),
					Layer.provide(
						Layer.mock(Judge, {
							decide: () => Effect.die("The grant needs no model."),
						}),
					),
				)
				yield* Effect.gen(function* () {
					const key = Option.getOrThrow(
						yield* (yield* Reviews.RequestReviews).start(test.fence, 0),
					)
					const fence = yield* store.takeOver(key)
					const decisions = yield* BotDecisions.BotDecisions
					const sql = yield* PgClient.PgClient
					yield* sql`create function reject_bot_receipt() returns trigger language plpgsql as $$ begin if NEW.key = 'bot-rollback' then raise exception 'Fixture Bot receipt failure'; end if; return NEW; end $$`
					yield* sql`create trigger reject_bot_receipt before insert on openbot_execution_commands for each row execute function reject_bot_receipt()`
					yield* Effect.addFinalizer(() =>
						sql`drop trigger if exists reject_bot_receipt on openbot_execution_commands`.pipe(
							Effect.andThen(sql`drop function if exists reject_bot_receipt()`),
							Effect.orDie,
						),
					)
					const command = Execution.CommandKey.make("bot-rollback")
					assert.ok(
						Schema.is(Execution.StorageError)(
							yield* decisions
								.decide(test.key, fence, command, { allow: true })
								.pipe(Effect.flip),
						),
					)
					assert.equal(
						(yield* (yield* Decisions.RequestCommands).load(test.key)).stored
							.request.status,
						"pending",
					)
					assert.equal(
						(yield* grants.list(actor.organizationId, test.bot)).length,
						0,
					)
					assert.equal(
						Option.getOrThrow(yield* store.decision(test.key, "request:0"))
							.answer,
						null,
					)
					yield* sql`drop trigger reject_bot_receipt on openbot_execution_commands`
					const results = yield* Effect.forEach(
						Arr.range(1, 10),
						() => decisions.decide(test.key, fence, command, { allow: true }),
						{ concurrency: 5 },
					)
					assert.isTrue(
						Arr.every(results, (result) => result.outcome === "allowed"),
					)
					assert.equal(
						(yield* grants.list(actor.organizationId, test.bot)).length,
						1,
					)
				}).pipe(Effect.provide(services))
			}),
	)
	it.effect(
		"review creation keeps the source token and rolls back with the child link",
		() =>
			Effect.gen(function* () {
				const reviewer = BotId.make("reviewer")
				const caller: Caller = {
					...actor,
					kind: "user_token",
					tokenId: TokenId.make("source-token"),
				}
				const test = yield* setup("request-review", {}, { reviewer, caller })
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				const services = Reviews.layer.pipe(
					Layer.provide(Inputs.layer),
					Layer.provide(
						Layer.mock(Bots, {
							find: () =>
								Effect.succeedSome({ ...BotFixture.bot, id: reviewer }),
						}),
					),
				)
				yield* Effect.gen(function* () {
					const reviews = yield* Reviews.RequestReviews
					yield* sql`create function reject_review_link() returns trigger language plpgsql as $$ begin if NEW.sequence = 4 then raise exception 'Fixture review link failure'; end if; return NEW; end $$`
					yield* sql`create trigger reject_review_link before insert on openbot_execution_events for each row execute function reject_review_link()`
					yield* Effect.addFinalizer(() =>
						sql`drop trigger if exists reject_review_link on openbot_execution_events`.pipe(
							Effect.orDie,
						),
					)
					assert.ok(
						Schema.is(Execution.StorageError)(
							yield* reviews.start(test.fence, 0).pipe(Effect.flip),
						),
					)
					assert.equal(
						(yield* sql`select * from openbot_chats where id = ${`chat_review_${test.key.id}_0`}`)
							.length,
						0,
					)
					yield* sql`drop trigger reject_review_link on openbot_execution_events`
					const keys = yield* Effect.forEach(
						Arr.range(1, 10),
						() => reviews.start(test.fence, 0),
						{ concurrency: 5 },
					)
					const key = Option.getOrThrow(keys[0] ?? Option.none())
					assert.isTrue(
						Arr.every(
							keys,
							(entry) => Option.isSome(entry) && entry.value.id === key.id,
						),
					)
					const child = yield* store.loadMember(key)
					assert.deepEqual(child.identity.actor, caller)
					assert.equal(child.identity.parentExecutionId, test.parent.id)
					assert.equal(child.identity.owner.userId, caller.userId)
					const events = yield* store.events(test.key, 0)
					assert.equal(
						Arr.filter(events, (event) => event.body._tag === "ChildExecution")
							.length,
						1,
					)
					const commands = yield* Decisions.RequestCommands
					yield* commands.pass(test.fence, 0)
					yield* commands.pass(test.fence, 0)
					assert.equal(
						(yield* commands.load(test.key)).stored.request.revision,
						1,
					)
					assert.equal(
						(yield* commands.load(test.key)).stored.request.approver._tag,
						"Person",
					)
					const childFence = yield* store.takeOver(key)
					yield* store.commit(childFence, { status: "completed" }, Effect.void)
					yield* reviews.release(test.fence)
					const chat = yield* StoredChats.ref(
						yield* Db.make,
						key.namespace,
						Chat.Id.make(`chat_review_${test.key.id}_0`),
					)
					assert.isTrue(ChatHost.hostState(Option.getOrThrow(chat)).closed)
				}).pipe(Effect.provide(services))
			}),
	)
	for (const end of ["pass", "cancel", "read-retry"] as const) {
		it.effect(`request workflow ${end} waits for its review execution`, () =>
			Effect.gen(function* () {
				const reviewer = BotId.make(`reviewer-${end}`)
				const test = yield* setup(
					`request-review-workflow-${end}`,
					{},
					{ reviewer },
				)
				const store = yield* Store.Store
				const commands = yield* Decisions.RequestCommands
				const reads = yield* Ref.make(0)
				const reviewLayer = Layer.effect(
					Reviews.RequestReviews,
					Effect.gen(function* () {
						const actual = yield* Reviews.RequestReviews
						return {
							...actual,
							wait: (key: Store.Key) =>
								Effect.gen(function* () {
									const attempt = yield* Ref.updateAndGet(reads, (n) => n + 1)
									if (end === "read-retry" && attempt === 1)
										return yield* Execution.StorageError.make({
											cause: "Fixture observation failure.",
										})
									return yield* actual.wait(key)
								}),
						}
					}),
				).pipe(
					Layer.provide(
						Reviews.layer.pipe(
							Layer.provide(Inputs.layer),
							Layer.provide(
								Layer.mock(Bots, {
									find: () =>
										Effect.succeedSome({ ...BotFixture.bot, id: reviewer }),
								}),
							),
						),
					),
				)
				const base = Layer.mergeAll(
					Runner.layer.pipe(
						Layer.provide(
							Layer.mock(Billing, {
								releaseExecution: () => Effect.succeed(true),
							}),
						),
					),
					RunScope.layer,
					reviewLayer,
				).pipe(
					Layer.provide(
						Records.layer.pipe(
							Layer.provide(
								Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
							),
						),
					),
					Layer.provideMerge(Engine.layerRegistry),
					Layer.provideMerge(WorkflowEngine.layerMemory),
				)
				yield* Effect.gen(function* () {
					const registry = yield* Engine.Registry
					const registered = Option.getOrThrow(
						yield* registry.get(Decisions.workflowName),
					)
					yield* RequestWorkflow.workflow.execute(test.key, { discard: true })
					const child = yield* Effect.gen(function* () {
						while (true) {
							const event = Arr.findFirst(
								yield* store.events(test.key, 0),
								(event) => event.body._tag === "ChildExecution",
							)
							if (
								Option.isSome(event) &&
								event.value.body._tag === "ChildExecution"
							)
								return yield* store.locate(
									event.value.body.executionId,
									actor.organizationId,
								)
							yield* Effect.sleep("10 millis")
						}
					}).pipe(Effect.timeout("5 seconds"))
					const childFence = yield* store.takeOver(child)
					if (end === "cancel") {
						const input = yield* Inputs.InputCommands
						const saved = yield* store.loadMember(child)
						const next = yield* input.notify(
							child.namespace,
							Execution.CommandKey.make("review-follow-up"),
							{
								chat: Chat.Id.make(`chat_review_${test.key.id}_0`),
								identity: saved.identity,
								content: Prompt.make("A tool has new results."),
								queue: true,
								notice: { kind: "tool", ref: "follow-up" },
							},
							{
								executionId: child.id,
								turn: Turn.Id.make(saved.record.resource.id),
								step: 0,
							},
						)
						const nextKey = { namespace: child.namespace, id: next.executionId }
						yield* store.cancel(
							test.key,
							Execution.CommandKey.make("cancel"),
							actor,
						)
						yield* registered.cancel(test.key, 1)
						yield* Effect.gen(function* () {
							while ((yield* store.get(child)).status !== "cancelling")
								yield* Effect.sleep("10 millis")
						}).pipe(Effect.timeout("5 seconds"))
						assert.equal((yield* store.get(test.key)).status, "cancelling")
						assert.equal(
							(yield* commands.load(test.key)).stored.request.status,
							"pending",
						)
						yield* store.finishCancellation(childFence, 1)
						yield* Effect.gen(function* () {
							while ((yield* store.get(nextKey)).status !== "cancelling")
								yield* Effect.sleep("10 millis")
						}).pipe(Effect.timeout("5 seconds"))
						assert.equal((yield* store.get(nextKey)).status, "cancelling")
						assert.equal((yield* store.get(test.key)).status, "cancelling")
						yield* store.finishCancellation(yield* store.takeOver(nextKey), 1)
					} else {
						yield* store.commit(
							childFence,
							{ status: "completed" },
							Effect.void,
						)
						yield* Effect.gen(function* () {
							while (
								(yield* commands.load(test.key)).stored.request.approver
									._tag !== "Person"
							)
								yield* Effect.sleep("10 millis")
						}).pipe(Effect.timeout("5 seconds"))
						const decision = Decisions.decisionId(
							(yield* commands.load(test.key)).stored.request,
						)
						yield* commands.decide(test.key, actor, {
							...test.input,
							decisionId: decision,
						})
						yield* registered.signal(test.key, decision)
					}
					yield* RequestWorkflow.workflow
						.execute(test.key)
						.pipe(Effect.timeout("5 seconds"))
					assert.equal(
						(yield* store.get(test.key)).status,
						end === "cancel" ? "cancelled" : "completed",
					)
					const view = yield* StoredChats.ref(
						yield* Db.make,
						child.namespace,
						Chat.Id.make(`chat_review_${test.key.id}_0`),
					)
					assert.isTrue(ChatHost.hostState(Option.getOrThrow(view)).closed)
				}).pipe(
					Effect.provide(
						RequestWorkflow.layer.pipe(
							Layer.provideMerge(base),
							Layer.provideMerge(Inputs.layer),
						),
					),
				)
			}),
		)
	}

	for (const end of ["decision", "cancel", "expired"] as const) {
		it.effect(`request workflow handles ${end} after a durable wait`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`request-workflow-${end}`, {
					person: true,
					...(end === "expired" ? { timeoutMs: 100 } : {}),
				})
				const store = yield* Store.Store
				const released = yield* Ref.make(0)
				const base = Layer.mergeAll(
					Runner.layer.pipe(
						Layer.provide(
							Layer.mock(Billing, {
								releaseExecution: () => Effect.succeed(true),
							}),
						),
					),
					RunScope.layer,
				).pipe(
					Layer.provide(
						Records.layer.pipe(
							Layer.provide(
								Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
							),
						),
					),
					Layer.provideMerge(Engine.layerRegistry),
					Layer.provideMerge(WorkflowEngine.layerMemory),
				)
				const services = RequestWorkflow.layer.pipe(
					Layer.provideMerge(base),
					Layer.provide(
						Layer.mock(Reviews.RequestReviews, {
							release: (_fence, keep) =>
								(keep === undefined
									? Ref.update(released, (n) => n + 1)
									: Effect.void
								).pipe(Effect.as(undefined)),
						}),
					),
				)
				yield* Effect.gen(function* () {
					const registry = yield* Engine.Registry
					const registered = Option.getOrThrow(
						yield* registry.get(Decisions.workflowName),
					)
					const workflowId = yield* RequestWorkflow.workflow.execute(test.key, {
						discard: true,
					})
					if (end !== "expired") {
						yield* Effect.gen(function* () {
							while (true) {
								const state = yield* RequestWorkflow.workflow.poll(workflowId)
								if (Option.isSome(state) && state.value._tag === "Suspended")
									break
								yield* Effect.sleep("10 millis")
							}
							assert.equal((yield* store.get(test.key)).status, "waiting")
						}).pipe(Effect.timeout("5 seconds"))
						if (end === "decision") {
							yield* (yield* Decisions.RequestCommands).decide(
								test.key,
								actor,
								test.input,
							)
							yield* registered.signal(test.key, test.input.decisionId)
						} else {
							yield* store.cancel(
								test.key,
								Execution.CommandKey.make("cancel"),
								actor,
							)
							yield* registered.cancel(test.key, 1)
						}
					}
					yield* RequestWorkflow.workflow
						.execute(test.key)
						.pipe(Effect.timeout("5 seconds"))
					assert.equal(
						(yield* store.get(test.key)).status,
						end === "cancel" ? "cancelled" : "completed",
					)
					assert.equal(
						(yield* (yield* Decisions.RequestCommands).load(test.key)).stored
							.request.status,
						end === "cancel"
							? "cancelled"
							: end === "decision"
								? "allowed"
								: "expired",
					)
					assert.equal(yield* Ref.get(released), 1)
				}).pipe(Effect.provide(services))
			}),
		)
	}

	it.effect(
		"generic execution decisions apply request Grants and audit once",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("request-generic")
				const commands = yield* Commands.Commands
				const grants = yield* Grants.Grants
				const requests = yield* Requests.Requests
				const sql = yield* PgClient.PgClient
				const results = yield* Effect.forEach(
					Arr.range(1, 10),
					() => commands.decide(test.key.id, actor, test.input),
					{ concurrency: 5 },
				)
				assert.isTrue(Arr.every(results, (result) => result.sequence === 4))
				assert.equal(
					Option.getOrThrow(
						yield* requests.find(actor.organizationId, test.stored.request.id),
					).request.status,
					"allowed",
				)
				const saved = yield* grants.list(actor.organizationId, test.bot)
				assert.equal(saved.length, 1)
				assert.equal(saved[0]?.scope, "once")
				assert.equal(
					(yield* sql`select * from openbot_audit_logs where resource = ${test.stored.request.id}`)
						.length,
					1,
				)
				assert.equal(
					(yield* (yield* Store.Store).events(test.key, 0)).length,
					4,
				)
			}),
	)
	it.effect(
		"a Channel speaker reads and decides work owned by the Channel account",
		() =>
			Effect.gen(function* () {
				const test = yield* setup(
					"request-channel-speaker",
					{ person: true },
					{ owner: "channel-account" },
				)
				const resolution = yield* Resolve.make
				const id = test.stored.request.id
				assert.strictEqual(
					(yield* resolution.view(actor, id)).executionId,
					test.key.id,
				)
				assert.isTrue(
					Arr.some(
						yield* resolution.list(actor, "pending"),
						(request) =>
							request.id === id && request.executionId === test.key.id,
					),
				)
				const input = {
					commandKey: Execution.CommandKey.make("channel-answer"),
					expected: test.stored.request.revision,
					decision: "allow" as const,
				}
				const receipt = yield* resolution.resolveAsPerson(actor, id, input)
				assert.strictEqual(receipt.executionId, test.key.id)
				assert.deepStrictEqual(
					yield* resolution.resolveAsPerson(actor, id, input),
					receipt,
				)
				assert.strictEqual(
					(yield* resolution.view(actor, id)).status,
					"allowed",
				)
				yield* resolution
					.view({ ...actor, userId: "other-speaker" }, id)
					.pipe(Effect.flip)
				yield* resolution
					.resolveAsPerson({ ...actor, userId: "other-speaker" }, id, input)
					.pipe(Effect.flip)
			}),
	)

	it.effect(
		"request lists filter current rights before reading hidden records",
		() =>
			Effect.gen(function* () {
				const shown = yield* setup("request-list-shown", { person: true })
				const hidden = yield* setup("request-list-hidden", { person: true })
				const sql = yield* PgClient.PgClient
				const saved = yield* sql<{
					body: string
				}>`select body from openbot_bot_records where kind = 'request' and organization_id = ${actor.organizationId} and id = ${hidden.stored.request.id}`
				const body = Option.getOrThrow(Arr.head(saved)).body
				yield* sql`update openbot_bot_records set body = 'broken' where kind = 'request' and organization_id = ${actor.organizationId} and id = ${hidden.stored.request.id}`
				const one = Policy.define(Authorization.OpenBot)(function* (_) {
					yield* _.allow("resolve", Authorization.Request, {
						when: ($) => $.eq("id", shown.stored.request.id),
					})
				})
				yield* Effect.gen(function* () {
					const resolution = yield* Resolve.make
					const list = yield* resolution.list(actor, "pending")
					assert.deepStrictEqual(
						Arr.map(list, (request) => request.id),
						[shown.stored.request.id],
					)
					assert.strictEqual(list[0]?.executionId, shown.key.id)
				}).pipe(
					Effect.provide(
						Authorizer.layer(Authorization.Auth, {
							policy: () => Effect.succeed(one),
						}),
					),
					Effect.ensuring(
						sql`update openbot_bot_records set body = ${body} where kind = 'request' and organization_id = ${actor.organizationId} and id = ${hidden.stored.request.id}`.pipe(
							Effect.orDie,
						),
					),
				)
			}),
	)

	it.effect(
		"an audit failure rolls back the request, Grant, Rule and decision",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("request-rollback")
				const resolution = yield* Resolve.make
				const decide = (
					input: typeof test.input & {
						readonly details: typeof Decisions.Details.Type
					},
				) =>
					resolution.resolveAsPerson(actor, test.stored.request.id, {
						commandKey: input.commandKey,
						expected: test.stored.request.revision,
						decision: "allow",
						...input.details,
					})
				const store = yield* Store.Store
				const requests = yield* Requests.Requests
				const grants = yield* Grants.Grants
				const rules = yield* Rules.Rules
				const sql = yield* PgClient.PgClient
				const input = {
					...test.input,
					details: { scope: "chat" as const, rule: "Allow this note." },
				}
				yield* sql`create function reject_request_audit() returns trigger language plpgsql as $$ begin raise exception 'Fixture audit failure'; end $$`
				yield* sql`create trigger reject_request_audit before insert on openbot_audit_logs for each row execute function reject_request_audit()`
				assert.ok(
					Schema.is(Execution.StorageError)(
						yield* decide(input).pipe(Effect.flip),
					),
				)
				assert.equal(
					Option.getOrThrow(
						yield* requests.find(actor.organizationId, test.stored.request.id),
					).request.status,
					"pending",
				)
				assert.equal(
					(yield* grants.list(actor.organizationId, test.bot)).length,
					0,
				)
				assert.equal(
					(yield* rules.list(actor.organizationId, test.bot)).length,
					0,
				)
				assert.equal(
					Option.getOrThrow(yield* store.decision(test.key, input.decisionId))
						.answer,
					null,
				)
				assert.equal((yield* store.events(test.key, 0)).length, 3)
				yield* sql`drop trigger reject_request_audit on openbot_audit_logs`
				yield* sql`drop function reject_request_audit()`
				yield* decide(input)
				yield* decide(input)
				assert.equal(
					(yield* grants.list(actor.organizationId, test.bot)).length,
					1,
				)
				assert.equal(
					(yield* rules.list(actor.organizationId, test.bot)).length,
					1,
				)
				assert.equal(
					(yield* sql`select * from openbot_audit_logs where resource = ${test.stored.request.id}`)
						.length,
					1,
				)
				assert.ok(
					Schema.is(Execution.KeyConflict)(
						yield* decide({ ...input, details: { scope: "once" } }).pipe(
							Effect.flip,
						),
					),
				)
			}),
	)
	it.effect(
		"request submission keeps one call, execution and decision across retries",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("request-create")
				const commands = yield* Decisions.RequestCommands
				const receipts = yield* Effect.forEach(
					Arr.range(1, 20),
					() =>
						commands.submit(
							test.parent,
							Execution.CommandKey.make("request"),
							test.submission,
						),
					{ concurrency: 10 },
				)
				for (const receipt of receipts)
					assert.deepStrictEqual(receipt, test.receipt)
				assert.deepStrictEqual(
					(yield* commands.load(test.key)).stored.call,
					test.submission.call,
				)
				const sql = yield* PgClient.PgClient
				assert.equal(
					(yield* sql`select id from openbot_executions where namespace = ${test.key.namespace} and resource_kind = 'Request'`)
						.length,
					1,
				)
				const events = yield* (yield* Store.Store).events(test.parent, 0)
				assert.equal(
					Arr.filter(events, (event) => event.body._tag === "ChildExecution")
						.length,
					1,
				)
				assert.ok(
					Schema.is(Execution.KeyConflict)(
						yield* commands
							.submit(test.parent, Execution.CommandKey.make("request"), {
								...test.submission,
								reason: "Another note.",
							})
							.pipe(Effect.flip),
					),
				)
			}),
	)
	it.effect(
		"request end and its notice roll back and retry as one transaction",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("request-end")
				const commands = yield* Decisions.RequestCommands
				const store = yield* Store.Store
				const sql = yield* PgClient.PgClient
				yield* commands.decide(test.key, actor, test.input)
				yield* sql`create function reject_request_notice() returns trigger language plpgsql as $$ begin if NEW.resource_kind = 'RequestNotice' then raise exception 'Fixture notice failure'; end if; return NEW; end $$`
				yield* sql`create trigger reject_request_notice before insert on openbot_executions for each row execute function reject_request_notice()`
				yield* Effect.addFinalizer(() =>
					sql`drop trigger if exists reject_request_notice on openbot_executions`.pipe(
						Effect.andThen(
							sql`drop function if exists reject_request_notice()`,
						),
						Effect.orDie,
					),
				)
				const failed = yield* commands
					.finish(test.fence, { status: "completed" })
					.pipe(Effect.flip)
				assert.ok(Schema.is(Execution.StorageError)(failed))
				assert.equal((yield* store.get(test.key)).status, "running")
				assert.equal(
					(yield* sql`select * from openbot_audit_logs where resource = ${test.stored.request.id} and action = 'request.resolved'`)
						.length,
					0,
				)
				yield* sql`drop trigger reject_request_notice on openbot_executions`
				yield* sql`drop function reject_request_notice()`
				const first = yield* commands.finish(test.fence, {
					status: "completed",
				})
				assert.deepStrictEqual(
					yield* commands.finish(test.fence, { status: "completed" }),
					first,
				)
				assert.equal((yield* store.get(test.key)).status, "completed")
				assert.equal(
					(yield* sql`select id from openbot_executions where namespace = ${test.key.namespace} and resource_kind = 'RequestNotice'`)
						.length,
					1,
				)
				assert.equal(
					(yield* sql`select * from openbot_audit_logs where resource = ${test.stored.request.id} and action = 'request.resolved'`)
						.length,
					1,
				)
			}),
	)
	for (const ending of ["expired", "cancelled", "stale"] as const) {
		it.effect(
			`request lifecycle checks ${ending} under its execution fence`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`request-life-${ending}`, {
						person: true,
						...(ending === "expired" ? { timeoutMs: 0 } : {}),
					})
					const commands = yield* Decisions.RequestCommands
					const store = yield* Store.Store
					if (ending === "stale") {
						yield* store.takeOver(test.key)
						assert.ok(
							Schema.is(Execution.Conflict)(
								yield* commands.expire(test.fence).pipe(Effect.flip),
							),
						)
						assert.ok(
							Schema.is(Execution.Conflict)(
								yield* commands.waiting(test.fence).pipe(Effect.flip),
							),
						)
						return
					}
					if (ending === "expired") {
						yield* commands.waiting(test.fence)
						const expired = yield* commands.expire(test.fence)
						assert.equal(expired.request.status, "expired")
						yield* commands.finish(test.fence, { status: "completed" })
					} else {
						yield* store.cancel(
							test.key,
							Execution.CommandKey.make("cancel"),
							actor,
						)
						assert.equal(
							(yield* commands.load(test.key)).stored.request.status,
							"pending",
						)
						yield* commands.finish(test.fence, {
							status: "cancelled",
							epoch: 1,
						})
						assert.equal(
							(yield* commands.load(test.key)).stored.request.status,
							"cancelled",
						)
					}
					assert.equal(
						(yield* store.get(test.key)).status,
						ending === "expired" ? "completed" : "cancelled",
					)
				}),
		)
	}
	for (const restriction of [
		"source",
		"resolve",
		"other-user",
		"expired",
	] as const) {
		it.effect(
			`request decisions check ${restriction} before granting access`,
			() =>
				Effect.gen(function* () {
					const test = yield* setup(`request-${restriction}`, {
						person: true,
						...(restriction === "expired" ? { timeoutMs: 0 } : {}),
					})
					const access = yield* Access
					yield* Ref.set(access, {
						source: restriction !== "source",
						resolve: restriction !== "resolve",
					})
					const caller =
						restriction === "other-user" ? { ...actor, userId: "other" } : actor
					const error = yield* (yield* Commands.Commands)
						.decide(test.key.id, caller, test.input)
						.pipe(
							Effect.flip,
							Effect.ensuring(Ref.set(access, { source: true, resolve: true })),
						)
					assert.ok(
						Schema.is(
							restriction === "expired"
								? Execution.Conflict
								: Execution.Forbidden,
						)(error),
					)
					assert.equal(
						(yield* (yield* Grants.Grants).list(actor.organizationId, test.bot))
							.length,
						0,
					)
					assert.equal(
						Option.getOrThrow(
							yield* (yield* Store.Store).decision(
								test.key,
								test.input.decisionId,
							),
						).answer,
						null,
					)
				}),
		)
	}
})
