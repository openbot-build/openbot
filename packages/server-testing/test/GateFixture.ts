import { NodeCrypto, NodeServices } from "@effect/platform-node"
import {
	Chat,
	ChatStoreRepository,
	Item,
	Store as CoreStore,
	Turn,
	TurnState,
} from "@openbot-build/core"
import {
	Authorization,
	Execution,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Redacted,
	String as Str,
} from "effect"
import { Prompt } from "effect/ai"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import * as BotRecords from "@openbot-build/plugin-bots/BotRecords"
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import * as Delegations from "@openbot-build/plugin-bots/Delegations"
import * as Gate from "@openbot-build/conversation-contract/capabilities/Gate"
import * as Gates from "@openbot-build/plugin-capabilities/Gates"
import * as Grants from "@openbot-build/plugin-capabilities/Grants"
import * as RequestCommands from "@openbot-build/plugin-capabilities/RequestCommands"
import * as Requests from "@openbot-build/plugin-capabilities/Requests"
import * as Rules from "@openbot-build/plugin-capabilities/Rules"
import * as ChatHost from "@openbot-build/conversation-contract/chats/ChatHost"
import * as StoredChats from "@openbot-build/conversation-contract/chats/StoredChats"
import { TurnAccess } from "@openbot-build/conversation-contract/chats/TurnAccess"
import { TurnContext } from "@openbot-build/conversation-contract/chats/TurnContext"
import * as Db from "@openbot-build/server-database/Database"
import { DatabasePostgres } from "@openbot-build/openbot"
import * as Records from "@openbot-build/server-kernel/errors/Records"
import * as Calls from "@openbot-build/server-execution/execution/Calls"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import * as Workflows from "@openbot-build/server-execution/execution/Workflows"
import * as WorkflowsFixture from "./WorkflowsFixture.ts"
import * as Store from "@openbot-build/server-execution/execution/Store"
import { ModelRegistry } from "@openbot-build/models-contract/models/ModelRegistry"
import * as Secrets from "@openbot-build/server-kernel/secrets/Secrets"
import { bot } from "./BotFixture.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
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
const registry = Layer.effectDiscard(
	WorkflowsFixture.register(
		Engine.define("openbot.chat-turn"),
		() => Effect.void,
	),
).pipe(Layer.provideMerge(Workflows.layer))

/** These tests use the real request, execution, Grant, and sealed error stores. */
export const services = Gates.layer.pipe(
	Layer.provideMerge(Layer.merge(RequestCommands.layer, Calls.layer)),
	Layer.provideMerge(Requests.layer),
	Layer.provideMerge(
		Layer.mergeAll(Grants.layer, Rules.layer, Delegations.layer),
	),
	Layer.provideMerge(
		Layer.mergeAll(Store.layer, BotRecords.layer, Records.layer, registry),
	),
	Layer.provideMerge(
		Layer.mock(TurnContext, {
			prepare: (input) =>
				Effect.gen(function* () {
					return {
						...input,
						bot,
						chain: ChatHost.chainForHost(input.host, input.identity),
						deciders: input.host.chain.bots,
					}
				}),
		}),
	),
	Layer.provideMerge(Layer.mock(TurnAccess, { authorize: () => Effect.void })),
	Layer.provideMerge(
		Layer.mock(Authorization.Auth, {
			domain: Authorization.OpenBot,
			check: () => Effect.void,
		}),
	),
	Layer.provideMerge(
		Layer.mock(ModelRegistry, { defaultModel: Option.none() }),
	),
	Layer.provideMerge(
		Layer.mock(Billing, {
			record: () => Effect.void,
			unknown: () => Effect.void,
		}),
	),
	Layer.provideMerge(Layer.mock(Bots, {})),
	Layer.provide(OrganizationFixture.layerDefaultSettings),
	Layer.provide(OrganizationFixture.layerNoAudit),
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
)

export const actor = {
	kind: "member",
	organizationId: "org_1",
	userId: "user_1",
} as const

/** Save a real pending model call before building its Gate. */
export const setup = Effect.fn("GateFixture.setup")(function* (
	namespace: string,
	above: ReadonlyArray<typeof bot.id> = [],
) {
	const store = yield* Store.Store
	const db = yield* Db.make
	const chat = Chat.Id.make(`chat_${namespace}`)
	const turn = Turn.Id.make(`turn_${namespace}`)
	const host: ChatHost.ChatHostState = {
		bot: bot.id,
		kind: "direct",
		chain: {
			organizationId: actor.organizationId,
			userId: actor.userId,
			bots: [...above, bot.id],
			chats: Arr.map(above, (id) => Chat.Id.make(`chat_${id}`)),
		},
	}
	const identity: ExecutionIdentity = {
		owner: { organizationId: actor.organizationId, userId: actor.userId },
		actor,
		botId: bot.id,
	}
	const receipt = yield* store.submit(
		namespace,
		Execution.CommandKey.make("turn"),
		{
			workflow: "openbot.chat-turn",
			resource: { kind: "Turn", id: turn },
			identity,
			input: { chat },
		},
	)
	const definition = yield* CoreStore.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore },
		schemaVersion: "chat/1",
	})
	const chats = yield* ChatStoreRepository.make({
		definition,
		persistence: StoredChats.persistence(db, namespace),
	})
	yield* chats.create({ id: chat, business: { [ChatHost.chatHostId]: host } })
	yield* chats.modifyEffect({
		chat,
		update: (view) =>
			TurnState.start(view, {
				turn,
				selected: [
					{
						id: Item.Id.make("input"),
						kind: "message",
						content: Prompt.make("Search the notes."),
					},
				],
				items: [],
				startedAt: 0,
			}).pipe(
				Effect.map((change) => [undefined, Option.some(change)] as const),
			),
	})
	const call = Prompt.toolCallPart({
		id: "call_1",
		name: "search",
		params: { query: "A private note." },
		providerExecuted: false,
	})
	const current = (yield* chats.read(chat)).chat.turn!
	yield* chats.modifyEffect({
		chat,
		update: () =>
			Effect.succeed([
				undefined,
				Option.some({
					chat: {
						turn: {
							...current,
							action: {
								name: call.name,
								arguments: {},
								source: { view: "private-view" },
							},
							pendingStep: {
								item: Item.Id.make("model-step"),
								step: 0,
								input: Prompt.empty,
								before: Prompt.make([{ role: "assistant", content: [call] }]),
								after: Prompt.empty,
							},
						},
					},
				}),
			] as const),
	})
	const fence = yield* store.takeOver({ namespace, id: receipt.executionId })
	const frame: Gate.Frame = { identity, chat, turn }
	return {
		fence,
		frame,
		call,
		attempt: {
			capability: { action: "tools.call" as const, target: call.name },
			reason: "The Bot wants to search.",
			site: Execution.mainCall(call.id),
		},
		build: (owner: Store.Fence = fence) =>
			Effect.flatMap(Effect.service(Gate.Gates), (gates) =>
				gates.durable(owner, frame),
			),
		approval: { chat, turn, approvalId: "approval", toolCall: call },
	}
})
