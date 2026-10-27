import { assert, it } from "@effect/vitest"
import {
	ChatStoreRepository,
	MemoryPersistence,
	Store,
	Turn,
} from "@openbot-build/core"
import {
	Execution,
	TokenId,
	BotId,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import { Effect, Layer, Schema } from "effect"
import { Bots } from "../src/bots/Bots.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as TurnContext from "../src/chats/TurnContext.ts"
import { Organization } from "../src/organization/Organization.ts"
import { bot } from "./BotFixture.ts"
import { layerEveryoneAdministrator } from "./OrganizationFixture.ts"

const turn = Turn.Id.make("turn_1")
const identity: ExecutionIdentity = {
	owner: { organizationId: "org_1", userId: "owner_1" },
	actor: {
		kind: "user_token",
		organizationId: "org_1",
		userId: "speaker_1",
		tokenId: TokenId.make("token_1"),
	},
	botId: bot.id,
}
const fixture = Effect.gen(function* () {
	const definition = yield* Store.define({
		stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore },
		schemaVersion: "chat/1",
	})
	const store = yield* ChatStoreRepository.make({
		definition,
		persistence: yield* MemoryPersistence.make,
	})
	const view = yield* store.create({})
	return {
		...view,
		chat: {
			...view.chat,
			business: {
				[ChatHost.chatHostId]: {
					bot: bot.id,
					kind: "channel" as const,
					chain: {
						organizationId: "org_1",
						userId: "owner_1",
						bots: [bot.id],
						chats: [],
					},
				},
			},
			turn: Turn.Record.make({
				id: turn,
				chat: view.chat.id,
				settings: { mode: "build" },
				author: "opaque-input-owner",
				status: Turn.Status.Running(),
				steps: 0,
				input: [],
				items: [],
				startedAt: 0,
			}),
		},
	}
})
const bots = Layer.mock(Bots, {
	find: () => Effect.succeedSome(bot),
	ownerChain: () => Effect.succeed([bot.id]),
})
const services = TurnContext.layer.pipe(
	Layer.provide(bots),
	Layer.provide(layerEveryoneAdministrator),
)

it.effect("a Turn keeps its speaker and token apart from its owner", () =>
	Effect.gen(function* () {
		const context = yield* TurnContext.TurnContext
		const view = yield* fixture
		const first = yield* context.prepare({
			identity,
			namespace: "org_1:owner_1",
			chat: view.chat.id,
			host: ChatHost.hostState(view.chat),
			turn,
		})
		assert.equal(first.identity.actor.userId, "speaker_1")
		assert.equal(first.identity.actor.tokenId, "token_1")
		assert.equal(first.identity.owner.userId, "owner_1")
	}).pipe(Effect.provide(services)),
)

for (const removed of ["owner_1", "speaker_1"]) {
	it.effect(`a Turn stops when ${removed} is no longer active`, () =>
		Effect.gen(function* () {
			const original = yield* Organization
			const context = yield* TurnContext.TurnContext.pipe(
				Effect.provide(
					TurnContext.layer.pipe(
						Layer.provide(bots),
						Layer.provide(
							Layer.mock(Organization, {
								activeMember: (org, user) =>
									user === removed
										? Effect.succeedNone
										: original.activeMember(org, user),
							}),
						),
					),
				),
			)
			const failure = yield* context
				.prepare({
					identity,
					namespace: "org_1:owner_1",
					...(yield* fixture.pipe(
						Effect.map((view) => ({
							chat: view.chat.id,
							host: ChatHost.hostState(view.chat),
						})),
					)),
					turn,
				})
				.pipe(Effect.flip)
			assert.instanceOf(failure, TurnContext.MemberInactive)
		}).pipe(Effect.provide(layerEveryoneAdministrator)),
	)
}

it.effect("a saved tool keeps its original Turn after the Chat moves on", () =>
	Effect.gen(function* () {
		const context = yield* TurnContext.TurnContext
		const view = yield* fixture
		const original = Turn.Id.make("old_turn")
		const work = yield* context.prepare({
			identity,
			namespace: "org_1:owner_1",
			chat: view.chat.id,
			host: ChatHost.hostState(view.chat),
			turn: original,
		})
		assert.equal(work.turn, original)
		assert.equal(work.identity.actor.tokenId, "token_1")
	}).pipe(Effect.provide(services)),
)

for (const bad of [
	{ ...identity, owner: { ...identity.owner, userId: "wrong-owner" } },
	{ ...identity, actor: { ...identity.actor, organizationId: "wrong-org" } },
	{ ...identity, botId: BotId.make("wrong-bot") },
] as const) {
	it.effect("a Turn rejects an identity for another resource", () =>
		Effect.gen(function* () {
			const context = yield* TurnContext.TurnContext
			const failure = yield* context
				.prepare({
					identity: bad,
					namespace: "org_1:owner_1",
					...(yield* fixture.pipe(
						Effect.map((view) => ({
							chat: view.chat.id,
							host: ChatHost.hostState(view.chat),
						})),
					)),
					turn,
				})
				.pipe(Effect.flip)
			assert.ok(Schema.is(Execution.Forbidden)(failure))
		}).pipe(Effect.provide(services)),
	)
}
