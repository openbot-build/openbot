import { NodeServices } from "@effect/platform-node"
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
import { WorkflowEngine } from "effect/workflow"
import { Billing } from "../src/billing/Billing.ts"
import * as BotRecords from "../src/bots/BotRecords.ts"
import { Bots } from "../src/bots/Bots.ts"
import * as Delegations from "../src/bots/Delegations.ts"
import * as Gate from "../src/capabilities/Gate.ts"
import * as Grants from "../src/capabilities/Grants.ts"
import * as RequestCommands from "../src/capabilities/RequestCommands.ts"
import * as Requests from "../src/capabilities/Requests.ts"
import * as Rules from "../src/capabilities/Rules.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import { TurnAccess } from "../src/chats/TurnAccess.ts"
import { TurnContext } from "../src/chats/TurnContext.ts"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Records from "../src/errors/Records.ts"
import * as Calls from "../src/execution/Calls.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as Store from "../src/execution/Store.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
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
	Effect.gen(function* () {
		yield* (yield* Engine.Registry).register(
			Engine.define("openbot.chat-turn"),
			() => Effect.void,
		)
	}),
).pipe(
	Layer.provideMerge(Engine.layerRegistry),
	Layer.provide(WorkflowEngine.layerMemory),
)

/** These tests use the real request, execution, Grant, and sealed error stores. */
export const services = Layer.merge(RequestCommands.layer, Calls.layer).pipe(
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
	Layer.provideMerge(NodeServices.layer),
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
		build: (owner: Store.Fence = fence) => Gate.durable(owner, frame),
		approval: { chat, turn, approvalId: "approval", toolCall: call },
	}
})
