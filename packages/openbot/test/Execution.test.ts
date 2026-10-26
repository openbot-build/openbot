import { assert, layer } from "@effect/vitest"
import { ChatExecutionBlocked, DelegationsApi } from "@openbot-build/api"
import { Config, Model } from "@openbot-build/core"
import {
	Array as Arr,
	Clock,
	Deferred,
	Effect,
	Fiber,
	Ref,
	Result,
	Stream,
} from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { PgClient } from "@effect/sql-pg"
import * as BotFixture from "./BotFixture.ts"
import * as ChatsFixture from "./ChatsFixture.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as HostTools from "../src/chats/HostTools.ts"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import * as Execution from "../src/chats/Execution.ts"
import type * as Chats from "../src/chats/Chats.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"

const live = Config.Selection.make({
	provider: ChatsFixture.selection.provider,
	model: Model.Id.make("live-model"),
})
const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const setup = (
	namespace: string,
	validate?: Chats.Options["validateExecution"],
) =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const model = yield* LanguageModel.make({
			generateText: () => Effect.succeed([]),
			streamText: () =>
				Stream.unwrap(
					Ref.update(calls, (count) => count + 1).pipe(
						Effect.as(
							Stream.make(
								Response.makePart("text-start", { id: "answer" }),
								Response.makePart("text-delta", {
									id: "answer",
									delta: "I remember.",
								}),
								Response.makePart("text-end", { id: "answer" }),
								Response.makePart("finish", { reason: "stop", usage }),
							),
						),
					),
				),
		})
		const chats = yield* ManagedChats.make({
			...ChatsFixture.models(model),
			namespace,
			liveCatalog: Effect.succeed({
				providers: [{ id: live.provider, name: "Live" }],
				models: [
					Config.Model.make({
						provider: live.provider,
						id: live.model,
						name: "Live model",
						reasoningEfforts: [],
						serviceTiers: [],
					}),
				],
			}),
			validateExecution: validate ?? (() => Effect.void),
		}).pipe(Effect.provide(HostTools.none))
		const created = yield* chats.create(BotFixture.direct())
		return { chats, created, calls }
	})

layer(ChatsFixture.layerDatabase, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"only one change with the same revision is committed",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats, created } = yield* setup("execution-two-clients")
				const attempts = yield* Effect.all(
					[
						chats
							.switchExecution(created.chat.id, {
								expected: created.chat.revision,
								mode: "live",
								model: live,
							})
							.pipe(Effect.result),
						chats
							.switchExecution(created.chat.id, {
								expected: created.chat.revision,
								mode: "live",
								model: live,
							})
							.pipe(Effect.result),
					],
					{ concurrency: "unbounded" },
				)
				assert.strictEqual(Arr.filter(attempts, Result.isSuccess).length, 1)
				assert.strictEqual(
					(yield* chats.get(created.chat.id)).chat.execution.generation,
					1,
				)
			}),
		60_000,
	)

	it.effect(
		"old Live Chats keep their kind while tasks cannot select Live",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats, created } = yield* setup("execution-old-live")
				const old = yield* chats.create({
					...BotFixture.direct(),
					kind: "live",
					model: live,
				})
				assert.strictEqual(old.chat.execution.mode, "live")
				assert.strictEqual(old.chat.execution.generation, 0)
				const changed = yield* chats.switchExecution(old.chat.id, {
					expected: old.chat.revision,
					mode: "chat",
					model: ChatsFixture.selection,
				})
				assert.strictEqual(changed.chat.kind, "live")
				assert.strictEqual(changed.chat.execution.mode, "chat")
				assert.deepStrictEqual(changed.chat.execution.liveModel, live)
				const task = yield* chats.create({
					...BotFixture.direct(),
					kind: "task",
					parent: {
						chat: created.chat.id,
						delegation: DelegationsApi.DelegationId.make("delegation_test"),
					},
				})
				const denied = yield* chats
					.switchExecution(task.chat.id, {
						expected: task.chat.revision,
						mode: "live",
						model: live,
					})
					.pipe(Effect.result)
				assert.ok(
					Result.isFailure(denied) &&
						denied.failure._tag === "ChatExecutionBlocked",
				)
				assert.strictEqual(denied.failure.reason, "kind")
			}),
		60_000,
	)

	it.effect(
		"a change left by a stopped process expires and cannot keep a Chat closed",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats, created } = yield* setup("execution-stale-change")
				yield* chats.changeExecution(created.chat.id, (chat) =>
					Effect.succeed({
						...Execution.of(chat),
						transition: { id: "old-change", startedAt: 0 },
					}),
				)
				const stale = yield* chats.get(created.chat.id)
				assert.strictEqual(stale.chat.execution.phase, "ready")
				const changed = yield* chats.switchExecution(created.chat.id, {
					expected: stale.chat.revision,
					mode: "live",
					model: live,
				})
				assert.strictEqual(changed.chat.execution.phase, "selected")
				assert.strictEqual(changed.chat.execution.generation, 1)
			}),
		60_000,
	)

	it.effect(
		"a Chat changes model kind without copying its history or running it again",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats, created, calls } = yield* setup("execution-round-trip")
				const id = created.chat.id
				yield* chats.deliver(id, {
					input: "Keep this note.",
					author: "test-user",
				})
				const before = yield* ChatsFixture.settled(chats, id)
				const history = yield* chats.items(id, {})
				const liveView = yield* chats.switchExecution(id, {
					expected: before.chat.revision,
					mode: "live",
					model: live,
				})
				assert.strictEqual(liveView.chat.id, id)
				assert.strictEqual(liveView.chat.kind, "direct")
				assert.strictEqual(liveView.chat.execution.mode, "live")
				assert.strictEqual(liveView.chat.execution.phase, "selected")
				assert.deepStrictEqual(
					liveView.chat.execution.chatModel,
					ChatsFixture.selection,
				)
				const again = yield* chats.switchExecution(id, {
					expected: liveView.chat.revision,
					mode: "chat",
				})
				assert.strictEqual(again.chat.execution.generation, 2)
				assert.deepStrictEqual(
					again.chat.settings.model,
					ChatsFixture.selection,
				)
				assert.deepStrictEqual(
					(yield* chats.items(id, {})).items,
					history.items,
				)
				assert.strictEqual(yield* Ref.get(calls), 1)
				assert.strictEqual(yield* chats.checkExecution(id, 1, "live"), false)
			}),
		60_000,
	)

	it.effect(
		"a context check failure leaves the old mode and its history in place",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats, created, calls } = yield* setup(
					"execution-context-fails",
					() =>
						Effect.fail(
							Execution.blocked(
								"context",
								"This model does not take this file.",
							),
						),
				)
				const result = yield* chats
					.switchExecution(created.chat.id, {
						expected: created.chat.revision,
						mode: "live",
						model: live,
					})
					.pipe(Effect.result)
				assert.ok(Result.isFailure(result))
				assert.strictEqual(result.failure._tag, "ChatExecutionBlocked")
				const after = yield* chats.get(created.chat.id)
				assert.strictEqual(after.chat.execution.mode, "chat")
				assert.strictEqual(after.chat.execution.phase, "ready")
				assert.strictEqual(after.chat.execution.generation, 0)
				assert.strictEqual(yield* Ref.get(calls), 0)
				assert.strictEqual(
					(yield* chats.turns(created.chat.id, {})).items.length,
					0,
				)
			}),
		60_000,
	)

	it.effect(
		"a cancelled change clears its barrier before new input runs",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const entered = yield* Deferred.make<void>()
				const { chats, created, calls } = yield* setup(
					"execution-cancelled",
					() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
						),
				)
				const change = yield* chats
					.switchExecution(created.chat.id, {
						expected: created.chat.revision,
						mode: "live",
						model: live,
					})
					.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				assert.strictEqual(
					(yield* chats.get(created.chat.id)).chat.execution.phase,
					"switching",
				)
				yield* Fiber.interrupt(change)
				const after = yield* chats.get(created.chat.id)
				assert.strictEqual(after.chat.execution.phase, "ready")
				assert.strictEqual(after.chat.execution.generation, 0)
				yield* chats.deliver(created.chat.id, {
					input: "Answer now.",
					author: "test-user",
				})
				yield* ChatsFixture.settled(chats, created.chat.id)
				assert.strictEqual(yield* Ref.get(calls), 1)
			}),
		60_000,
	)

	it.effect(
		"a saved image is checked before a change and stays in the inbox without a Turn",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const checked = yield* Ref.make(false)
				const { chats, created, calls } = yield* setup(
					"execution-passive-file",
					({ context }) =>
						Effect.gen(function* () {
							const files = Arr.flatMap(context.content, (message) =>
								message.role === "user"
									? Arr.filter(message.content, (part) => part.type === "file")
									: [],
							)
							assert.strictEqual(files.length, 1)
							assert.strictEqual(files[0]?.mediaType, "image/png")
							yield* Ref.set(checked, true)
							return yield* Execution.blocked(
								"context",
								"This model does not take images.",
							)
						}),
				)
				yield* chats.deliver(created.chat.id, {
					input: Prompt.make([
						{
							role: "user",
							content: [
								{
									type: "file",
									mediaType: "image/png",
									data: new URL("https://example.test/image.png"),
								},
							],
						},
					]),
					author: "test-user",
					passive: true,
				})
				const before = yield* chats.read(created.chat.id)
				const result = yield* chats
					.switchExecution(created.chat.id, {
						expected: before.chat.revision,
						mode: "live",
						model: live,
					})
					.pipe(Effect.result)
				assert.ok(
					Result.isFailure(result) &&
						result.failure._tag === "ChatExecutionBlocked",
				)
				assert.strictEqual(result.failure.reason, "context")
				assert.strictEqual(yield* Ref.get(checked), true)
				assert.deepStrictEqual(
					(yield* chats.read(created.chat.id)).chat.inbox,
					before.chat.inbox,
				)
				assert.strictEqual(
					(yield* chats.turns(created.chat.id, {})).items.length,
					0,
				)
				assert.strictEqual(yield* Ref.get(calls), 0)
			}),
		60_000,
	)

	it.effect(
		"saved approvals and unknown App outcomes block a change after a Turn has ended",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats, created } = yield* setup("execution-open-work")
				const id = created.chat.id
				const sql = yield* PgClient.PgClient
				yield* sql`insert into openbot_bot_records(kind, organization_id, id, owner, scope, status, body)
			values ('request', 'test-organization', 'execution-request', 'test-user', ${id}, 'pending', '{}')`
				const blocked = yield* chats
					.switchExecution(id, {
						expected: created.chat.revision,
						mode: "live",
						model: live,
					})
					.pipe(Effect.result)
				assert.ok(
					Result.isFailure(blocked) &&
						blocked.failure._tag === "ChatExecutionBlocked",
				)
				assert.strictEqual(blocked.failure.reason, "approval")
				yield* sql`delete from openbot_bot_records where id = 'execution-request'`
				const owner = ownerKey({
					organizationId: "test-organization",
					userId: "test-user",
				})
				yield* sql`insert into openbot_app_invocations(owner, id, chat, status, body)
			values (${owner}, 'execution-call', ${id}, 'OutcomeUnknown', '{}')`
				const current = yield* chats.get(id)
				const unknown = yield* chats
					.switchExecution(id, {
						expected: current.chat.revision,
						mode: "live",
						model: live,
					})
					.pipe(Effect.result)
				assert.ok(
					Result.isFailure(unknown) &&
						unknown.failure._tag === "ChatExecutionBlocked",
				)
				assert.strictEqual(unknown.failure.reason, "operation")
				assert.deepStrictEqual(unknown.failure.ids, ["execution-call"])
				assert.strictEqual((yield* chats.get(id)).chat.execution.mode, "chat")
			}),
		60_000,
	)

	it.effect(
		"text that arrives during a context check waits for the newly selected model",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const { chats, calls } = yield* setup("execution-input-race", () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				)
				const source = yield* chats.create({
					...BotFixture.direct(),
					kind: "live",
					model: live,
				})
				const change = yield* chats
					.switchExecution(source.chat.id, {
						expected: source.chat.revision,
						mode: "chat",
						model: ChatsFixture.selection,
					})
					.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				const input = yield* chats.deliver(source.chat.id, {
					input: "Still answer this.",
					author: "test-user",
				})
				assert.strictEqual(input.delivery, "queued")
				assert.strictEqual(yield* Ref.get(calls), 0)
				yield* Deferred.succeed(release, undefined)
				const changed = yield* Fiber.join(change)
				assert.strictEqual(changed.chat.execution.mode, "chat")
				assert.strictEqual(changed.chat.execution.generation, 1)
				const after = yield* ChatsFixture.settled(chats, source.chat.id)
				assert.strictEqual(after.inbox, 0)
				assert.strictEqual(yield* Ref.get(calls), 1)
			}),
		60_000,
	)

	it.effect(
		"new image context during a check keeps the old mode and the saved image",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const { chats, created, calls } = yield* setup(
					"execution-new-image",
					() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
				)
				const change = yield* chats
					.switchExecution(created.chat.id, {
						expected: created.chat.revision,
						mode: "live",
						model: live,
					})
					.pipe(Effect.result, Effect.forkScoped)
				yield* Deferred.await(entered)
				const image = yield* chats.deliver(created.chat.id, {
					input: Prompt.make([
						{
							role: "user",
							content: [
								{
									type: "file",
									mediaType: "image/png",
									data: new URL("https://example.test/image.png"),
								},
							],
						},
					]),
					author: "test-user",
					passive: true,
				})
				yield* Deferred.succeed(release, undefined)
				const changed = yield* Fiber.join(change)
				assert.ok(
					Result.isFailure(changed) &&
						changed.failure._tag === "ChatExecutionBlocked",
				)
				assert.strictEqual(changed.failure.reason, "context")
				const after = yield* chats.read(created.chat.id)
				assert.strictEqual(Execution.of(after.chat).mode, "chat")
				assert.strictEqual(after.chat.inbox[0]?.id, image.item)
				assert.strictEqual(after.chat.inbox.length, 1)
				assert.strictEqual(yield* Ref.get(calls), 0)
			}),
		60_000,
	)

	it.effect(
		"only the saved Live owner can add input before or after a switch",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats, created, calls } = yield* setup("execution-input-owner")
				const selected = yield* chats.switchExecution(created.chat.id, {
					expected: created.chat.revision,
					mode: "live",
					model: live,
				})
				const now = yield* Clock.currentTimeMillis
				const owner = {
					generation: selected.chat.execution.generation,
					sessionId: "saved-owner",
				}
				yield* chats.changeExecution(created.chat.id, (chat) =>
					Effect.succeed({
						...Execution.of(chat),
						lease: {
							...owner,
							expiresAt: now + 30_000,
							phase: "ready",
							busy: false,
						},
					}),
				)
				const wrong = yield* chats
					.deliver(created.chat.id, {
						input: "Wrong owner.",
						author: "test-user",
						passive: true,
						expectedExecution: { ...owner, sessionId: "other-owner" },
					})
					.pipe(Effect.result)
				assert.ok(
					Result.isFailure(wrong) && wrong.failure._tag === "ChatConflict",
				)
				assert.strictEqual(
					(yield* chats.read(created.chat.id)).chat.inbox.length,
					0,
				)
				const saved = yield* chats.deliver(created.chat.id, {
					input: "Saved context.",
					author: "test-user",
					passive: true,
					expectedExecution: owner,
				})
				const before = yield* chats.get(created.chat.id)
				yield* chats.switchExecution(created.chat.id, {
					expected: before.chat.revision,
					mode: "chat",
				})
				const old = yield* chats
					.deliver(created.chat.id, {
						input: "Late old input.",
						author: "test-user",
						passive: true,
						expectedExecution: owner,
					})
					.pipe(Effect.result)
				assert.ok(Result.isFailure(old) && old.failure._tag === "ChatConflict")
				const after = yield* chats.read(created.chat.id)
				assert.strictEqual(after.chat.inbox.length, 1)
				assert.strictEqual(after.chat.inbox[0]?.id, saved.item)
				assert.strictEqual(yield* Ref.get(calls), 0)
			}),
		60_000,
	)

	it.effect(
		"busy audio blocks a change and an idle old connection loses its generation",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { chats, created } = yield* setup("execution-live-fence")
				const selected = yield* chats.switchExecution(created.chat.id, {
					expected: created.chat.revision,
					mode: "live",
					model: live,
				})
				const now = yield* Clock.currentTimeMillis
				yield* chats.changeExecution(created.chat.id, (chat) =>
					Effect.succeed({
						...Execution.of(chat),
						lease: {
							sessionId: "old-connection",
							generation: selected.chat.execution.generation,
							expiresAt: now + 30_000,
							phase: "ready",
							busy: true,
						},
					}),
				)
				const busy = yield* chats.get(created.chat.id)
				const patch = yield* chats
					.update(created.chat.id, {
						expected: busy.chat.revision,
						model: live,
					})
					.pipe(Effect.result)
				assert.ok(
					Result.isFailure(patch) && patch.failure._tag === "ChatConflict",
				)
				const change = yield* chats
					.switchExecution(created.chat.id, {
						expected: busy.chat.revision,
						mode: "chat",
					})
					.pipe(Effect.result)
				assert.ok(
					Result.isFailure(change) &&
						change.failure._tag === "ChatExecutionBlocked",
				)
				assert.strictEqual(change.failure.reason, "connection")
				yield* chats.changeExecution(created.chat.id, (chat) => {
					const execution = Execution.of(chat)
					return execution.lease === undefined
						? Effect.fail(
								ChatExecutionBlocked.make({
									reason: "connection",
									message: "No connection.",
									ids: [],
								}),
							)
						: Effect.succeed({
								...execution,
								lease: { ...execution.lease, busy: false },
							})
				})
				const idle = yield* chats.get(created.chat.id)
				const done = yield* chats.switchExecution(created.chat.id, {
					expected: idle.chat.revision,
					mode: "chat",
				})
				assert.strictEqual(done.chat.execution.mode, "chat")
				assert.strictEqual(
					yield* chats.checkExecution(
						created.chat.id,
						selected.chat.execution.generation,
						"live",
					),
					false,
				)
			}),
		60_000,
	)
})
