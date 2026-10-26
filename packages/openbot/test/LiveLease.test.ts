import { assert, layer } from "@effect/vitest"
import { Config, Model } from "@openbot-build/core"
import { Array as Arr, Clock, Effect, Result, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import * as BotFixture from "./BotFixture.ts"
import * as ChatsFixture from "./ChatsFixture.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Execution from "../src/chats/Execution.ts"
import * as HostTools from "../src/chats/HostTools.ts"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import * as LiveLease from "../src/chats/live/LiveLease.ts"

const live = Config.Selection.make({
	provider: ChatsFixture.selection.provider,
	model: Model.Id.make("live-model"),
})

/** Separate hosts share PostgreSQL, but no in-memory lease state. */
const setup = (namespace: string) =>
	Effect.gen(function* () {
		yield* DatabasePostgres.migrate
		const model = yield* LanguageModel.make({
			generateText: () => Effect.die("A lease must not run a model."),
			streamText: () => Stream.die("A lease must not run a model."),
		})
		const make = ManagedChats.make({
			...ChatsFixture.models(model),
			namespace,
			liveCatalog: Effect.succeed({
				providers: [{ id: live.provider, name: "Live" }],
				models: [
					Config.Model.make({
						provider: live.provider,
						id: live.model,
						name: "Live",
						reasoningEfforts: [],
						serviceTiers: [],
					}),
				],
			}),
			validateExecution: () => Effect.void,
		}).pipe(Effect.provide(HostTools.none))
		const chats = yield* make
		const other = yield* make
		const created = yield* chats.create(BotFixture.direct())
		const selected = yield* chats.switchExecution(created.chat.id, {
			expected: created.chat.revision,
			mode: "live",
			model: live,
		})
		const owner: LiveLease.Owner = {
			chat: selected.chat.id,
			generation: selected.chat.execution.generation,
			sessionId: "first",
		}
		return { chats, other, owner }
	})

layer(ChatsFixture.layerDatabase, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect("two hosts cannot claim the same Live generation", () =>
		Effect.gen(function* () {
			const { chats, other, owner } = yield* setup("live-lease-claim")
			const second = { ...owner, sessionId: "second" }
			const attempts = yield* Effect.all(
				[
					LiveLease.claim(chats, owner).pipe(Effect.result),
					LiveLease.claim(other, second).pipe(Effect.result),
				],
				{ concurrency: "unbounded" },
			)
			assert.strictEqual(Arr.filter(attempts, Result.isSuccess).length, 1)
			const execution = Execution.of((yield* chats.read(owner.chat)).chat)
			assert.strictEqual(execution.lease?.phase, "connecting")
			assert.strictEqual(execution.lease?.busy, false)
			assert.strictEqual(execution.lease?.generation, owner.generation)
			assert.strictEqual(
				yield* LiveLease.valid(chats, owner),
				execution.lease?.sessionId === owner.sessionId,
			)
			assert.strictEqual(
				yield* LiveLease.valid(other, second),
				execution.lease?.sessionId === second.sessionId,
			)
			assert.deepStrictEqual(
				Execution.of((yield* other.read(owner.chat)).chat),
				execution,
			)
		}),
	)

	it.effect(
		"an expired connection cannot renew or release a replacement lease",
		() =>
			Effect.gen(function* () {
				const { chats, other, owner } = yield* setup("live-lease-expired")
				yield* LiveLease.claim(chats, owner)
				yield* chats.changeExecution(owner.chat, (chat) => {
					const execution = Execution.of(chat)
					return Effect.succeed({
						...execution,
						lease: { ...execution.lease!, expiresAt: 0 },
					})
				})
				assert.isFalse(yield* LiveLease.valid(chats, owner))
				assert.strictEqual(
					(yield* Effect.flip(LiveLease.update(chats, owner)))._tag,
					"ChatExecutionBlocked",
				)
				const replacement = { ...owner, sessionId: "replacement" }
				yield* LiveLease.claim(other, replacement)
				yield* LiveLease.update(other, replacement, { phase: "ready" })
				const current = Execution.of((yield* other.read(owner.chat)).chat)
				yield* LiveLease.release(chats, owner)
				assert.strictEqual(
					(yield* Effect.flip(LiveLease.update(chats, owner, { busy: true })))
						._tag,
					"ChatExecutionBlocked",
				)
				assert.deepStrictEqual(
					Execution.of((yield* chats.read(owner.chat)).chat),
					current,
				)
				assert.isTrue(yield* LiveLease.valid(other, replacement))
			}),
	)

	it.effect(
		"a finalizer from an old generation cannot change a new lease even with the same session ID",
		() =>
			Effect.gen(function* () {
				const { chats, other, owner } = yield* setup("live-lease-generation")
				yield* LiveLease.claim(chats, owner)
				const current = yield* chats.get(owner.chat)
				const ordinary = yield* chats.switchExecution(owner.chat, {
					expected: current.chat.revision,
					mode: "chat",
					model: ChatsFixture.selection,
				})
				assert.isFalse(yield* LiveLease.valid(chats, owner))
				assert.strictEqual(
					(yield* Effect.flip(LiveLease.claim(chats, owner)))._tag,
					"ChatExecutionBlocked",
				)
				const selected = yield* chats.switchExecution(owner.chat, {
					expected: ordinary.chat.revision,
					mode: "live",
				})
				const next = {
					...owner,
					generation: selected.chat.execution.generation,
				}
				yield* LiveLease.claim(other, next)
				const before = Execution.of((yield* other.read(owner.chat)).chat)
				yield* LiveLease.release(chats, owner)
				assert.strictEqual(
					(yield* Effect.flip(LiveLease.update(chats, owner)))._tag,
					"ChatExecutionBlocked",
				)
				assert.deepStrictEqual(
					Execution.of((yield* chats.read(owner.chat)).chat),
					before,
				)
				assert.isTrue(yield* LiveLease.valid(other, next))
			}),
	)

	it.effect(
		"a preparing switch permits lease renewal but blocks new audio and readiness",
		() =>
			Effect.gen(function* () {
				const { chats, other, owner } = yield* setup("live-lease-transition")
				yield* LiveLease.claim(chats, owner)
				const now = yield* Clock.currentTimeMillis
				yield* chats.changeExecution(owner.chat, (chat) =>
					Effect.succeed({
						...Execution.of(chat),
						transition: { id: "preparing", startedAt: now },
					}),
				)
				yield* LiveLease.update(other, owner)
				const renewed = Execution.of((yield* chats.read(owner.chat)).chat)
				assert.strictEqual(renewed.transition?.id, "preparing")
				assert.ok(renewed.lease!.expiresAt >= now + LiveLease.lifetimeMillis)
				for (const change of [
					{ busy: true },
					{ busy: false },
					{ phase: "ready" },
					{ phase: "connecting" },
				] as const) {
					assert.strictEqual(
						(yield* Effect.flip(LiveLease.update(chats, owner, change)))._tag,
						"ChatExecutionBlocked",
					)
				}
				assert.deepStrictEqual(
					Execution.of((yield* chats.read(owner.chat)).chat),
					renewed,
				)
				assert.strictEqual(
					(yield* Effect.flip(
						LiveLease.claim(other, { ...owner, sessionId: "late" }),
					))._tag,
					"ChatExecutionBlocked",
				)
			}),
	)

	it.effect(
		"uncommitted Live audio blocks switching until the connection clears it",
		() =>
			Effect.gen(function* () {
				const { chats, owner } = yield* setup("live-lease-busy")
				yield* LiveLease.claim(chats, owner)
				yield* LiveLease.update(chats, owner, { phase: "ready", busy: true })
				const busy = yield* chats.get(owner.chat)
				const denied = yield* Effect.flip(
					chats.switchExecution(owner.chat, {
						expected: busy.chat.revision,
						mode: "chat",
						model: ChatsFixture.selection,
					}),
				)
				assert.strictEqual(denied._tag, "ChatExecutionBlocked")
				if (denied._tag === "ChatExecutionBlocked")
					assert.strictEqual(denied.reason, "connection")
				assert.strictEqual(
					(yield* chats.get(owner.chat)).chat.execution.generation,
					owner.generation,
				)
				assert.deepStrictEqual((yield* chats.items(owner.chat, {})).items, [])
				yield* LiveLease.update(chats, owner, { busy: false })
				const cleared = yield* chats.get(owner.chat)
				const selected = yield* chats.switchExecution(owner.chat, {
					expected: cleared.chat.revision,
					mode: "chat",
					model: ChatsFixture.selection,
				})
				assert.strictEqual(selected.chat.execution.mode, "chat")
				assert.isFalse(yield* LiveLease.valid(chats, owner))
			}),
	)
})
