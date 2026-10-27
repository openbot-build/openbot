import { PgClient } from "@effect/sql-pg"
import * as Records from "../src/errors/Records.ts"
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import {
	Config,
	Model,
	Provider,
	ChatStoreRepository,
	Bot,
	Item,
	Chat,
	Store as CoreStore,
	Turn,
	TurnState,
} from "@openbot-build/core"
import {
	Authorization,
	Execution,
	TokenId,
	BotId,
	DelegationId,
	CapabilityRequestId,
	type ExecutionIdentity,
	restrictExecution,
} from "@openbot-build/domain"
import { ChannelsApi } from "@openbot-build/api"
import { Policy } from "@nmnmcc/ability"
import {
	Array as Arr,
	Cause,
	Record as Rec,
	Stream,
	DateTime,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { Prompt, Toolkit } from "effect/ai"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Store from "../src/execution/Store.ts"
import * as Calls from "../src/execution/Calls.ts"
import { Registry } from "../src/execution/Engine.ts"
import * as Observation from "../src/execution/Observation.ts"
import { CallContext } from "../src/execution/CallContext.ts"
import * as ToolControls from "../src/chats/ToolControls.ts"
import * as ToolOrigins from "../src/chats/ToolOrigins.ts"
import * as ToolCommands from "../src/chats/ToolCommands.ts"
import * as TurnAccess from "../src/chats/TurnAccess.ts"
import * as InputCommands from "../src/chats/InputCommands.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import {
	Delegations,
	type Stored as StoredDelegation,
} from "../src/bots/Delegations.ts"
import {
	Requests,
	type Stored as StoredRequest,
} from "../src/capabilities/Requests.ts"
import { Bots } from "../src/bots/Bots.ts"
import { Channels } from "../src/channels/Channels.ts"
import {
	Organization,
	OrganizationUnavailable,
} from "../src/organization/Organization.ts"
import { Tokens } from "../src/auth/Tokens.ts"
import * as AuthorizationLayer from "../src/authorization/Layer.ts"
import * as Check from "../src/authorization/Check.ts"
import { PlatformAdmins } from "../src/platform/PlatformAdmins.ts"
import * as BotFixture from "./BotFixture.ts"
import * as Fixture from "./OrganizationFixture.ts"
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
const services = Layer.merge(Store.layer, Records.layer).pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const tokenPolicy = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("*", "*")
})
const denied = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.flip,
		Effect.tap((error) =>
			Effect.sync(() => assert.ok(Schema.is(Execution.Forbidden)(error))),
		),
	)
const setup = Effect.fn(function* (
	namespace: string,
	kind: "direct" | "channel" = "direct",
) {
	const db = yield* Db.make
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore },
		schemaVersion: "chat/1",
	})
	const chats = yield* ChatStoreRepository.make({
		definition,
		persistence: StoredChats.persistence(db, namespace),
	})
	const { chain, bot } = BotFixture.direct()
	const channelId = ChannelsApi.ChannelId.make("channel-test")
	const view = yield* chats.create({
		business: {
			[ChatHost.chatHostId]: {
				chain,
				bot: bot.id,
				kind,
				...(kind === "channel"
					? { channel: { channel: channelId, conversation: "room" } }
					: {}),
			},
		},
	})
	const identity: ExecutionIdentity = {
		owner: { organizationId: chain.organizationId, userId: chain.userId },
		actor: {
			kind: "user_token",
			organizationId: chain.organizationId,
			userId: kind === "channel" ? "speaker" : chain.userId,
			tokenId: TokenId.make("token-test"),
		},
		botId: bot.id,
		...(kind !== "channel"
			? {}
			: {
					channel: { id: channelId, externalUserId: "external-speaker" },
					constraints: [
						{
							kind: "member" as const,
							organizationId: chain.organizationId,
							userId: chain.userId,
						},
					],
				}),
	}
	const state = yield* Ref.make({
		delegation: Option.none<StoredDelegation>(),
		request: Option.none<StoredRequest>(),
		tokenPolicy,
		fail: false,
		inactive: "",
		token: true,
		expiresAt: null as string | null,
		archived: false,
		enabled: true,
		linked: true,
	})
	const policy = AuthorizationLayer.layer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.unwrap(
					Effect.map(Organization, (original) =>
						Layer.mock(Organization, {
							activeMember: (org, user) =>
								Effect.gen(function* () {
									if ((yield* Ref.get(state)).fail)
										return yield* OrganizationUnavailable.make({
											cause: new Error("private access storage failure"),
										})
									if ((yield* Ref.get(state)).inactive === user)
										return Option.none()
									return (yield* original.activeMember(org, user)).pipe(
										Option.map((member) => ({
											...member,
											roles: ["administrator"],
										})),
									)
								}),
						}),
					),
				).pipe(Layer.provide(Fixture.layerEveryoneAdministrator)),
				Fixture.layerBuiltinRoles,
				Fixture.layerDefaultSettings,
				Layer.mock(PlatformAdmins, { check: () => Effect.succeed(false) }),
				Layer.mock(Tokens, {
					find: () =>
						Effect.gen(function* () {
							const now = yield* Ref.get(state)
							return now.token
								? Option.some({
										id: TokenId.make("token-test"),
										name: "test",
										prefix: "obut_test",
										policy: now.tokenPolicy,
										createdAt: "2026-01-01T00:00:00.000Z",
										expiresAt: now.expiresAt,
										lastUsedAt: null,
									})
								: Option.none()
						}),
				}),
			),
		),
	)
	const bots = Layer.unwrap(
		Effect.map(Check.make, (checks) =>
			Layer.mock(Bots, {
				find: (_, id) =>
					Effect.map(Ref.get(state), (state) =>
						Option.some({
							...bot,
							id: BotId.make(id),
							archived: state.archived,
						}),
					),
				access: (actor, id, action) =>
					Effect.gen(function* () {
						yield* checks.check(actor, {
							action,
							resource: Authorization.Bot.make({
								organizationId: chain.organizationId,
								ownerUserId: id === bot.id ? chain.userId : null,
								id,
							}),
						})
						return {
							...bot,
							id: BotId.make(id),
							archived: (yield* Ref.get(state)).archived,
						}
					}),
			}),
		),
	)
	const dependencies = Layer.mergeAll(
		Layer.mock(Delegations, {
			find: () => Ref.get(state).pipe(Effect.map((state) => state.delegation)),
		}),
		Layer.mock(Requests, {
			find: () => Ref.get(state).pipe(Effect.map((state) => state.request)),
		}),
		bots,
		Layer.mock(Channels, {
			identity: () =>
				Ref.get(state).pipe(
					Effect.map((state) =>
						state.linked
							? Option.some({
									channel: channelId,
									externalUserId: "external-speaker",
									userId: "speaker",
									displayName: "Speaker",
									createdAt: 0,
								})
							: Option.none(),
					),
				),
			get: () =>
				Effect.map(Ref.get(state), (state) =>
					Option.some({
						id: channelId,
						executionId: null,
						needsAuthorization: false,
						kind: "custom",
						name: "test",
						bot: bot.id,
						actor: chain.userId,
						enabled: state.enabled,
						linkPath: null,
						credentials: {
							kind: "custom",
							endpoint: "https://example.com",
							secret: { set: false, hint: null },
						},
						version: 1,
						createdAt: 0,
						updatedAt: 0,
					}),
				),
		}),
	)
	const accessLayer = InputCommands.layer.pipe(
		Layer.provideMerge(TurnAccess.layer),
		Layer.provideMerge(dependencies),
		Layer.provideMerge(policy),
	)
	const send = (commands: typeof InputCommands.InputCommands.Service) =>
		commands.submit(namespace, Execution.CommandKey.make("first"), {
			chat: view.chat.id,
			identity,
			queue: false,
			content: Prompt.make("hello"),
		})
	return { namespace, identity, view, state, accessLayer, send, chats }
})

const addNotice = Effect.fn(function* (
	namespace: string,
	chat: Chat.Id,
	turn: Turn.Id,
	identity: ExecutionIdentity,
	label: string = "",
) {
	const store = yield* Store.Store
	const inputs = yield* InputCommands.InputCommands
	const notice = yield* store.submit(
		namespace,
		Execution.CommandKey.make(`notice-source:${chat}${label}`),
		{
			workflow: "openbot.tool-notice",
			resource: { kind: "ChatNotice", id: chat },
			identity,
			input: null,
		},
	)
	return yield* inputs.notify(
		namespace,
		Execution.CommandKey.make(`notice:${chat}${label}`),
		{
			chat,
			identity,
			queue: true,
			content: Prompt.make("The saved tool result"),
			notice: { kind: "tool", ref: notice.executionId },
		},
		{ executionId: notice.executionId, turn, step: 1 },
	)
})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect("input retries and restored steps check a revoked token", () =>
		Effect.gen(function* () {
			const test = yield* setup("turn-access-token")
			yield* Effect.gen(function* () {
				const access = yield* TurnAccess.TurnAccess
				const commands = yield* InputCommands.InputCommands
				const receipt = yield* test.send(commands)
				const key = { namespace: test.namespace, id: receipt.executionId }
				yield* access.authorize(key, test.identity.actor, "advance")
				yield* Ref.update(test.state, (state) => ({ ...state, token: false }))
				yield* denied(test.send(commands))
				yield* denied(access.authorize(key, test.identity.actor, "advance"))
				yield* denied(access.authorize(key, test.identity.actor, "read"))
			}).pipe(Effect.provide(test.accessLayer))
		}),
	)
	for (const kind of ["direct", "channel"] as const) {
		it.effect(`${kind} model calls check the current token policy`, () =>
			Effect.gen(function* () {
				const test = yield* setup(`model-policy-${kind}`, kind)
				yield* Effect.gen(function* () {
					const access = yield* TurnAccess.TurnAccess
					const receipt = yield* test.send(yield* InputCommands.InputCommands)
					const key = { namespace: test.namespace, id: receipt.executionId }
					const selection = Config.Selection.make({
						provider: Provider.Id.make("provider"),
						model: Model.Id.make("reply"),
					})
					yield* access.model(key, selection)
					const tokenPolicy = Policy.define(Authorization.OpenBot)(
						function* (_) {
							yield* _.allow("*", "*")
							yield* _.deny("use", Authorization.Model, {
								when: ($) => $.eq("id", Model.Id.make("reply")),
							})
						},
					)
					yield* Ref.update(test.state, (state) => ({ ...state, tokenPolicy }))
					// The source remains open. The selected model is no longer allowed.
					yield* access.authorize(key, test.identity.actor, "advance")
					yield* denied(access.model(key, selection))
					yield* access.model(
						key,
						Config.Selection.make({
							...selection,
							model: Model.Id.make("summary"),
						}),
					)
				}).pipe(Effect.provide(test.accessLayer))
			}),
		)
	}
	it.effect(
		"a later caller cannot remove a token limit from a model step",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-caller-limits")
				yield* Effect.gen(function* () {
					const access = yield* TurnAccess.TurnAccess
					const inputs = yield* InputCommands.InputCommands
					const member = { kind: "member" as const, ...test.identity.owner }
					const identity = restrictExecution(
						{ ...test.identity, actor: member },
						[test.identity.actor],
					)
					const after = restrictExecution(identity, [member])
					assert.deepStrictEqual(after, identity)
					const receipt = yield* inputs.submit(
						test.namespace,
						Execution.CommandKey.make("restricted"),
						{
							chat: test.view.chat.id,
							identity: after,
							queue: false,
							content: Prompt.make("hello"),
						},
					)
					const key = { namespace: test.namespace, id: receipt.executionId }
					const selection = Config.Selection.make({
						provider: Provider.Id.make("provider"),
						model: Model.Id.make("reply"),
					})
					yield* access.model(key, selection)
					const tokenPolicy = Policy.define(Authorization.OpenBot)(
						function* (_) {
							yield* _.allow("*", "*")
							yield* _.deny("use", Authorization.Model)
						},
					)
					yield* Ref.update(test.state, (state) => ({ ...state, tokenPolicy }))
					yield* access.authorize(key, member, "advance")
					yield* denied(access.model(key, selection))
					yield* Ref.update(test.state, (state) => ({ ...state, token: false }))
					yield* denied(access.authorize(key, member, "replay"))
				}).pipe(Effect.provide(test.accessLayer))
			}),
	)
	it.effect("a saved identity loses access when its token expires", () =>
		Effect.gen(function* () {
			const test = yield* setup("turn-access-expiry")
			yield* Effect.gen(function* () {
				const access = yield* TurnAccess.TurnAccess
				yield* access.input(test.view.chat, test.identity)
				yield* Ref.update(test.state, (state) => ({
					...state,
					expiresAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
				}))
				yield* denied(access.input(test.view.chat, test.identity))
			}).pipe(Effect.provide(test.accessLayer))
		}),
	)
	it.effect(
		"a Channel speaker can control their own child without owning its Chat",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("channel-tool-controls", "channel")
				const application = ToolControls.layer.pipe(
					Layer.provideMerge(ToolCommands.layer),
					Layer.provideMerge(Calls.layer),
					Layer.provide(
						Layer.effect(
							Registry,
							Effect.map(TurnAccess.TurnAccess, (access) =>
								Registry.of({
									names: Effect.succeed(["openbot.chat-turn"]),
									register: () => Effect.void,
									registerService: () => Effect.void,
									get: () =>
										Effect.succeedSome({
											authorize: (key, actor, mode) =>
												actor.kind === "service"
													? Effect.fail(Execution.Forbidden.make({}))
													: access.authorize(key, actor, mode),
											start: () => Effect.void,
											cancel: () => Effect.void,
											signal: () => Effect.void,
										}),
								}),
							),
						),
					),
					Layer.provide(Observation.layer),
					Layer.provideMerge(test.accessLayer),
				)
				yield* Effect.gen(function* () {
					const receipt = yield* test.send(yield* InputCommands.InputCommands)
					const store = yield* Store.Store
					const parent = yield* store.takeOver({
						namespace: test.namespace,
						id: receipt.executionId,
					})
					const current = yield* test.chats.read(test.view.chat.id)
					const turn = current.chat.turn
					if (turn === undefined)
						return yield* Effect.die("The Turn is missing.")
					const call = Prompt.makePart("tool-call", {
						id: "call",
						name: "send",
						params: {},
						providerExecuted: false,
					})
					const item = Item.Id.make("tool-step")
					yield* test.chats.modifyEffect({
						chat: current.chat.id,
						update: () =>
							Effect.succeed([
								undefined,
								Option.some({
									chat: {
										turn: {
											...turn,
											pendingStep: {
												step: 0,
												item,
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
					const tools = yield* ToolCommands.ToolCommands
					const child = yield* tools.submit(
						parent,
						{ chat: current.chat.id, turn: turn.id, item, step: 0 },
						call,
						{ budget: "0 millis", maxDuration: "1 hour", limit: 1 },
					)
					const checks = yield* Check.make
					for (const action of ["read", "write"] as const)
						assert.isFalse(
							yield* checks.allows(test.identity.actor, {
								action,
								resource: Authorization.Chat.make({
									organizationId: test.identity.owner.organizationId,
									ownerUserId: test.identity.owner.userId,
									id: current.chat.id,
								}),
							}),
						)
					const controls = yield* ToolControls.ToolControls
					const registered = yield* controls.register(parent).pipe(
						Effect.provideService(
							Bot.Context,
							Bot.Context.of({
								options: { prompt: Prompt.empty },
								at: Effect.succeed(Chat.position(current.chat)),
								turn: Effect.succeed(turn.id),
								step: Effect.succeed(0),
								history: Effect.succeed(Prompt.empty),
							}),
						),
					)
					const toolkit = yield* Toolkit.make(
						...Rec.values(registered.tools),
					).pipe(Effect.provideContext(registered.handlers))
					const invoke = (
						name: (typeof ToolControls.names)[keyof typeof ToolControls.names],
						input: Schema.Json,
					) =>
						toolkit.handle(name, input, "control-call").pipe(
							Effect.flatMap(Stream.runCollect),
							Effect.map((parts) => parts[0]?.result),
							Effect.provideService(CallContext, {
								fence: parent,
								id: Execution.CallId.make("control-call"),
							}),
						)
					const status = yield* invoke(ToolControls.names.status, {
						executionId: child.executionId,
					})
					assert.equal(
						(yield* Schema.decodeUnknownEffect(
							Schema.Struct({ status: Schema.String }),
						)(status)).status,
						"queued",
					)
					yield* invoke(ToolControls.names.wait, {
						executionIds: [child.executionId],
						timeoutMs: 0,
					})
					yield* invoke(ToolControls.names.cancel, {
						executionId: child.executionId,
					})
					assert.equal(
						(yield* store.get({
							namespace: test.namespace,
							id: child.executionId,
						})).status,
						"cancelling",
					)
					yield* denied(
						tools.authorize(
							{ namespace: test.namespace, id: child.executionId },
							{ ...test.identity.actor, userId: "another-speaker" },
							"read",
						),
					)
					yield* Ref.update(test.state, (state) => ({
						...state,
						enabled: false,
					}))
					assert.property(
						yield* invoke(ToolControls.names.status, {
							executionId: child.executionId,
						}),
						"failure",
					)
				}).pipe(Effect.provide(application))
			}),
	)
	for (const change of [
		"owner",
		"speaker",
		"channel",
		"bot",
		"link",
	] as const) {
		it.effect(`a Channel Turn checks its current ${change}`, () =>
			Effect.gen(function* () {
				const test = yield* setup("turn-access-channel-" + change, "channel")
				yield* Effect.gen(function* () {
					const access = yield* TurnAccess.TurnAccess
					yield* access.input(test.view.chat, test.identity)
					yield* Ref.update(test.state, (state) => ({
						...state,
						inactive:
							change === "owner"
								? test.identity.owner.userId
								: change === "speaker"
									? test.identity.actor.userId
									: "",
						enabled: change !== "channel",
						linked: change !== "link",
						archived: change === "bot",
					}))
					yield* denied(access.input(test.view.chat, test.identity))
				}).pipe(Effect.provide(test.accessLayer))
			}),
		)
	}
	it.effect(
		"a Channel Turn keeps the original configuration token limits",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-access-channel-config-token", "channel")
				yield* Effect.gen(function* () {
					const access = yield* TurnAccess.TurnAccess
					const identity: ExecutionIdentity = {
						...test.identity,
						actor: {
							kind: "member",
							organizationId: test.identity.actor.organizationId,
							userId: test.identity.actor.userId,
						},
						constraints: [
							{
								kind: "user_token",
								organizationId: test.identity.owner.organizationId,
								userId: test.identity.owner.userId,
								tokenId: TokenId.make("configuration-token"),
							},
						],
					}
					yield* access.input(test.view.chat, identity)
					yield* Ref.update(test.state, (state) => ({ ...state, token: false }))
					yield* denied(access.input(test.view.chat, identity))
				}).pipe(Effect.provide(test.accessLayer))
			}),
	)

	it.effect(
		"a Channel task keeps the speaker and checks its saved parent",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-access-task", "channel")
				yield* Effect.gen(function* () {
					const access = yield* TurnAccess.TurnAccess
					const receipt = yield* test.send(yield* InputCommands.InputCommands)
					const execution = yield* (yield* Store.Store).get({
						namespace: test.namespace,
						id: receipt.executionId,
					})
					const childBot = BotId.make("shared-child")
					const id = DelegationId.make("delegation-test")
					const chain = ChatHost.chainForIdentity(test.view.chat, test.identity)
					const child = yield* test.chats.create({
						business: {
							[ChatHost.chatHostId]: {
								bot: childBot,
								kind: "task",
								chain: {
									...chain,
									bots: [...chain.bots, childBot],
									chats: [test.view.chat.id],
								},
								parent: { chat: test.view.chat.id, delegation: id },
							},
						},
					})
					const identity = {
						...test.identity,
						botId: childBot,
						delegationId: id,
						parentExecutionId: receipt.executionId,
					}
					const delegation: StoredDelegation = {
						userId: test.identity.owner.userId,
						author: "opaque",
						chain,
						delegation: {
							id,
							parent: {
								chat: test.view.chat.id,
								turn: Turn.Id.make(execution.resource.id),
							},
							bot: childBot,
							chat: child.chat.id,
							status: "running",
							task: "test",
							result: null,
							createdAt: 0,
							updatedAt: 0,
						},
					}
					yield* Ref.update(test.state, (state) => ({
						...state,
						delegation: Option.some(delegation),
					}))
					yield* access.input(child.chat, identity)
					// A new input cannot replace the source token or remove its parent.
					const { parentExecutionId: _, ...direct } = identity
					yield* denied(
						access.input(child.chat, {
							...direct,
							actor: { kind: "member", ...identity.owner },
						}),
					)
					yield* denied(access.input(child.chat, direct))
					// The speaker has no broad right to run the owner's Chats.
					const checks = yield* Check.make
					assert.isFalse(
						yield* checks.allows(identity.actor, {
							action: "run",
							resource: Authorization.Chat.make({
								organizationId: identity.owner.organizationId,
								ownerUserId: identity.owner.userId,
								id: child.chat.id,
							}),
						}),
					)
					yield* denied(
						access.input(child.chat, {
							...identity,
							actor: { ...identity.actor, userId: "another-speaker" },
						}),
					)
					const inputs = yield* InputCommands.InputCommands
					const childInput = yield* inputs.submit(
						test.namespace,
						Execution.CommandKey.make("child-input"),
						{
							chat: child.chat.id,
							identity,
							queue: false,
							content: Prompt.make("Do the work"),
						},
					)
					const childExecution = yield* (yield* Store.Store).get({
						namespace: test.namespace,
						id: childInput.executionId,
					})
					const turn = Turn.Id.make(childExecution.resource.id)
					yield* Ref.update(test.state, (state) => ({
						...state,
						delegation: Option.some({
							...delegation,
							delegation: {
								...delegation.delegation,
								status: "paused" as const,
							},
						}),
					}))
					// Pause is a send rule. Current member and token rights are still checked.
					yield* access.authorize(
						{ namespace: test.namespace, id: childInput.executionId },
						identity.actor,
						"advance",
					)
					assert.isTrue(yield* access.notice(child.chat, identity))
					yield* addNotice(
						test.namespace,
						child.chat.id,
						turn,
						identity,
						"paused",
					)
					assert.ok(
						Arr.some(
							(yield* test.chats.read(child.chat.id)).chat.inbox,
							(entry) => entry.notice?.kind === "tool",
						),
					)
					yield* Ref.update(test.state, (state) => ({
						...state,
						delegation: Option.some(delegation),
					}))
					assert.ok(
						Arr.some(
							(yield* test.chats.read(child.chat.id)).chat.inbox,
							(entry) => entry.notice?.kind === "tool",
						),
					)

					yield* Ref.update(test.state, (state) => ({
						...state,
						delegation: Option.some({
							...delegation,
							delegation: {
								...delegation.delegation,
								status: "completed" as const,
							},
						}),
					}))
					yield* denied(access.input(child.chat, identity))
					assert.isFalse(yield* access.notice(child.chat, identity))
					const before = (yield* test.chats.items(child.chat.id)).length
					yield* addNotice(test.namespace, child.chat.id, turn, identity)
					yield* addNotice(test.namespace, child.chat.id, turn, identity)
					const after = yield* test.chats.items(child.chat.id)
					assert.equal(after.length, before + 1)
					assert.equal(after[before]?.origin?.notice?.kind, "tool")
					assert.equal(
						Arr.filter(
							(yield* test.chats.read(child.chat.id)).chat.inbox,
							(entry) => entry.notice?.kind === "tool",
						).length,
						1,
					)
					yield* Ref.update(test.state, (state) => ({
						...state,
						enabled: false,
					}))
					yield* denied(access.input(child.chat, identity))
					yield* denied(access.notice(child.chat, identity))
				}).pipe(Effect.provide(test.accessLayer))
			}),
	)
	for (const source of ["Turn", "Tool", "Code"] as const) {
		it.effect(`a ${source} review checks its request and current token`, () =>
			Effect.gen(function* () {
				const test = yield* setup("turn-access-review-" + source)
				yield* Effect.gen(function* () {
					const access = yield* TurnAccess.TurnAccess
					const receipt = yield* test.send(yield* InputCommands.InputCommands)
					const execution = yield* (yield* Store.Store).get({
						namespace: test.namespace,
						id: receipt.executionId,
					})
					let sourceId = receipt.executionId
					if (source !== "Turn") {
						const store = yield* Store.Store
						const parent = yield* store.takeOver({
							namespace: test.namespace,
							id: receipt.executionId,
						})
						const current = yield* test.chats.read(test.view.chat.id)
						const turn = current.chat.turn!
						const item = Item.Id.make("background-step")
						const call = Prompt.makePart("tool-call", {
							id: "background-call",
							name: "run_code",
							params: {},
							providerExecuted: false,
						})
						yield* test.chats.modifyEffect({
							chat: current.chat.id,
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
						const tools = yield* ToolCommands.ToolCommands
						const child = yield* tools.submit(
							parent,
							{ chat: current.chat.id, turn: turn.id, item, step: 0 },
							call,
							{ budget: "0 millis", maxDuration: "1 hour", limit: 1 },
						)
						yield* tools.detach(parent, child.executionId)
						yield* store.commit(
							parent,
							{ status: "completed" },
							test.chats.modifyEffect({
								chat: current.chat.id,
								update: (view) =>
									TurnState.end(view, {
										turn: turn.id,
										status: Turn.Status.Completed({
											result: {
												text: "The tool keeps running.",
												finishReason: "stop",
											},
										}),
										completedAt: 1,
										items: [],
									}).pipe(
										Effect.map(
											({ mutation }) =>
												[undefined, Option.some(mutation)] as const,
										),
									),
							}),
						)
						sourceId = child.executionId
						if (source === "Code") {
							const toolFence = yield* store.takeOver({
								namespace: test.namespace,
								id: child.executionId,
							})
							const origins = yield* ToolOrigins.make
							const code = yield* store.accept(
								test.namespace,
								Execution.CommandKey.make("code-child"),
								{
									actor: test.identity.actor,
									body: {},
								},
								(create) =>
									Effect.gen(function* () {
										const key = yield* create({
											workflow: "test.code",
											resource: { kind: "CodeRun", id: "code" },
											identity: test.identity,
											input: {},
										})
										yield* origins.attach(toolFence, key, {
											main: call.id,
											path: ["code"],
										})
										return { executionId: key.id, start: true }
									}),
							)
							sourceId = code.executionId
						}
						yield* access.authorize(
							{ namespace: test.namespace, id: sourceId },
							test.identity.actor,
							"advance",
						)
					}
					const reviewer = BotId.make("reviewer-bot")
					const id = CapabilityRequestId.make("request-test")
					const chain = ChatHost.chainForIdentity(test.view.chat, test.identity)
					const review = yield* test.chats.create({
						business: {
							[ChatHost.chatHostId]: {
								bot: reviewer,
								kind: "review",
								chain: { ...chain, bots: [reviewer], chats: [] },
								review: id,
							},
						},
					})
					const identity = {
						...test.identity,
						botId: reviewer,
						parentExecutionId: sourceId,
					}
					const request: StoredRequest = {
						chain,
						request: {
							id,
							bot: BotFixture.bot.id,
							capability: { action: "bots.delegate", target: "*" },
							reason: "test",
							approver: { _tag: "Bot", bot: reviewer },
							chain: [reviewer, BotFixture.bot.id],
							chat: test.view.chat.id,
							turn: Turn.Id.make(execution.resource.id),
							toolCallId: "call",
							endorsements: [],
							status: "pending",
							decision: null,
							revision: 0,
							createdAt: 0,
							expiresAt: Number.MAX_SAFE_INTEGER,
						},
					}
					const limited = Policy.define(Authorization.OpenBot)(function* (_) {
						yield* _.allow("*", "*")
						yield* _.deny("*", Authorization.Bot, {
							when: ($) => $.eq("id", reviewer),
						})
					})
					yield* Ref.update(test.state, (state) => ({
						...state,
						request: Option.some(request),
						tokenPolicy: limited,
					}))
					yield* (yield* Bots)
						.access(identity.actor, reviewer, "delegate")
						.pipe(Effect.flip)
					yield* access.input(review.chat, identity)
					const started = yield* (yield* InputCommands.InputCommands).submit(
						test.namespace,
						Execution.CommandKey.make("review"),
						{
							chat: review.chat.id,
							identity,
							queue: false,
							content: Prompt.make("Check this request"),
						},
					)
					const key = { namespace: test.namespace, id: started.executionId }
					const store = yield* Store.Store
					const first = yield* store.takeOver(key)
					const sent = yield* store.writeAttempt(
						first,
						"decision",
						{},
						"idempotent",
					)
					yield* store.sending(first, sent.id)
					const commandKey = Execution.CommandKey.make("closed-review-result")
					const command = { actor: identity.actor, body: { decision: "pass" } }
					yield* store.accept(first.namespace, commandKey, command, () =>
						Effect.succeed({ executionId: first.id, start: false }),
					)
					yield* Ref.update(test.state, (state) => ({
						...state,
						request: Option.some({
							...request,
							request: {
								...request.request,
								approver: {
									_tag: "Person" as const,
									userId: identity.actor.userId,
								},
							},
						}),
					}))
					yield* denied(access.input(review.chat, identity))
					yield* denied(access.authorize(key, identity.actor, "advance"))
					yield* access.authorize(key, identity.actor, "replay")
					const next = yield* store.takeOver(key)
					const recovered = yield* Calls.Calls.use((calls) =>
						calls.invoke(
							next,
							{
								...sent,
								savedResult: () =>
									store
										.receipt(first.namespace, commandKey, command)
										.pipe(Effect.map(Option.map(() => ({ passedUp: true })))),
							},
							() => Effect.die("A closed review must not send a new command."),
						),
					).pipe(
						Effect.provide(
							Calls.layer.pipe(
								Layer.provide(
									Layer.mock(Registry, {
										get: () =>
											Effect.succeedSome({
												start: () => Effect.void,
												cancel: () => Effect.void,
												signal: () => Effect.void,
												authorize: (key, actor, mode) =>
													actor.kind === "service"
														? Effect.fail(Execution.Forbidden.make({}))
														: access.authorize(key, actor, mode),
											}),
									}),
								),
							),
						),
					)
					assert.equal(recovered._tag, "Completed")
					assert.isFalse(yield* access.notice(review.chat, identity))
					const before = (yield* test.chats.items(review.chat.id)).length
					const reviewExecution = yield* (yield* Store.Store).get(key)
					const turn = Turn.Id.make(reviewExecution.resource.id)
					yield* addNotice(test.namespace, review.chat.id, turn, identity)
					yield* addNotice(test.namespace, review.chat.id, turn, identity)
					assert.equal(
						(yield* test.chats.items(review.chat.id)).length,
						before + 1,
					)
					assert.equal(
						(yield* test.chats.read(review.chat.id)).chat.inbox.length,
						0,
					)
					yield* Ref.update(test.state, (state) => ({ ...state, token: false }))
					yield* denied(access.authorize(key, identity.actor, "replay"))
					yield* denied(
						access.authorize(
							{ namespace: test.namespace, id: sourceId },
							test.identity.actor,
							"advance",
						),
					)
					yield* denied(access.notice(review.chat, identity))
				}).pipe(
					Effect.provide(
						ToolCommands.layer.pipe(
							Layer.provide(
								Layer.effect(
									Calls.Calls,
									Effect.map(TurnAccess.TurnAccess, (access) =>
										Calls.Calls.of({
											admission: () => Effect.void,
											stopOnPause: (work) => work,
											reserve: () =>
												Effect.die("This test does not reserve model usage."),
											ready: () => Effect.void,
											authorize: (key, mode = "advance") =>
												access.authorize(key, test.identity.actor, mode),
											invoke: () =>
												Effect.die("This test does not send a tool call."),
											recover: () =>
												Effect.die("This test does not recover a tool call."),
										}),
									),
								),
							),
							Layer.provideMerge(test.accessLayer),
						),
					),
				)
			}),
		)
	}
	it.effect(
		"an access storage failure keeps its cause in the sealed error record",
		() =>
			Effect.gen(function* () {
				const test = yield* setup("turn-access-failure")
				yield* Effect.gen(function* () {
					const access = yield* TurnAccess.TurnAccess
					yield* Ref.update(test.state, (state) => ({ ...state, fail: true }))
					const failure = yield* access
						.input(test.view.chat, test.identity)
						.pipe(Effect.flip)
					assert.ok(Schema.is(Execution.StorageError)(failure))
					const saved = yield* (yield* Records.Records).record(
						Cause.fail(failure),
						"unavailable",
					)
					const sql = yield* PgClient.PgClient
					const rows = yield* sql<{
						readonly cause: string
					}>`select cause from openbot_execution_failures where id = ${saved.errorId}`
					const row = rows[0]
					assert.isDefined(row)
					if (row === undefined) return
					assert.isFalse(
						Str.includes("private access storage failure")(row.cause),
					)
					const plain = yield* (yield* Secrets.Secrets).open(
						row.cause,
						`failure:${saved.errorId}`,
					)
					assert.isTrue(Str.includes("private access storage failure")(plain))
				}).pipe(Effect.provide(test.accessLayer))
			}),
	)
	it.effect("execution reads and commands use the stored owner", () =>
		Effect.gen(function* () {
			const test = yield* setup("turn-access-owner")
			yield* Effect.gen(function* () {
				const access = yield* TurnAccess.TurnAccess
				const receipt = yield* test.send(yield* InputCommands.InputCommands)
				const key = { namespace: test.namespace, id: receipt.executionId }
				for (const action of ["read", "cancel", "decide", "advance"] as const) {
					yield* denied(
						access.authorize(
							key,
							{
								kind: "member",
								organizationId: test.identity.owner.organizationId,
								userId: "another-user",
							},
							action,
						),
					)
					yield* denied(
						access.authorize(
							key,
							{ ...test.identity.actor, organizationId: "another-org" },
							action,
						),
					)
				}
			}).pipe(Effect.provide(test.accessLayer))
		}),
	)
})
