import * as ErrorRecordsFixture from "./ErrorRecordsFixture.ts"
import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { BotsApi, Settings as SettingsApi } from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import { Requests as RequestDomain } from "@openbot-build/domain"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	Layer,
	Logger,
	Option,
	Ref,
	Schema,
	Semaphore,
} from "effect"
import { TestClock } from "effect/testing"
import { BotRecords, type Keys } from "../src/bots/BotRecords.ts"
import * as Grants from "../src/capabilities/Grants.ts"
import * as Requests from "../src/capabilities/Requests.ts"
import * as Rules from "../src/capabilities/Rules.ts"
import { Settings } from "../src/settings/Settings.ts"

const organizationId = "org_1"
const userId = "user_1"
const top = BotsApi.BotId.make("bot_top")
const worker = BotsApi.BotId.make("bot_worker")

interface Row {
	readonly kind: string
	readonly keys: Keys
	readonly body: string
}

/**
 * Bot records in memory. Like the real ones, they keep JSON text. One lock for
 * all keys is enough for these tests.
 */
const memoryRecords = Effect.gen(function* () {
	const rows = yield* Ref.make(HashMap.empty<string, Row>())
	const lock = yield* Semaphore.make(1)
	const service: BotRecords["Service"] = {
		collection: (kind, schema) => {
			const codec = Schema.fromJsonString(Schema.toCodecJson(schema))
			const decode = (body: string) =>
				Effect.orDie(Schema.decodeEffect(codec)(body))
			const key = (organizationId: string, id: string) =>
				kind + ":" + organizationId + ":" + id
			const select = (keep: (keys: Keys) => boolean) =>
				Effect.map(Ref.get(rows), (current) =>
					Arr.filter(
						Arr.fromIterable(HashMap.values(current)),
						(row) => row.kind === kind && keep(row.keys),
					),
				)
			return {
				find: (organizationId, id) =>
					Ref.get(rows).pipe(
						Effect.map(HashMap.get(key(organizationId, id))),
						Effect.flatMap((row) =>
							Effect.transposeOption(
								Option.map(row, (row) => decode(row.body)),
							),
						),
					),
				list: (organizationId, filter = {}) =>
					select(
						(keys) =>
							keys.organizationId === organizationId &&
							(filter.owner === undefined || keys.owner === filter.owner) &&
							(filter.scope === undefined || keys.scope === filter.scope) &&
							(filter.status === undefined || keys.status === filter.status),
					).pipe(Effect.flatMap(Effect.forEach((row) => decode(row.body)))),
				put: (keys, value) =>
					Schema.encodeEffect(codec)(value).pipe(
						Effect.orDie,
						Effect.flatMap((body) => {
							const row: Row = { kind, keys, body }
							return Ref.update(
								rows,
								HashMap.set(key(keys.organizationId, keys.id), row),
							)
						}),
					),
				remove: (organizationId, id) =>
					Ref.update(rows, HashMap.remove(key(organizationId, id))),
			}
		},
		transaction: (_key, operation) => lock.withPermits(1)(operation),
		// The transaction already holds the one lock for all keys.
		lock: () => Effect.void,
	}
	return { service }
})

/** The services of requests on records in memory. The settings cannot be read. */
const layerOf = (records: BotRecords["Service"]) =>
	Requests.layer.pipe(
		Layer.provide(ErrorRecordsFixture.layer),
		Layer.provideMerge(Layer.mergeAll(Grants.layer, Rules.layer)),
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(BotRecords, records),
				Layer.succeed(Settings, {
					...({} as Settings["Service"]),
					organization: () =>
						Effect.fail(SettingsApi.SettingsUnavailable.make({})),
				}),
			),
		),
		Layer.provide(NodeCrypto.layer),
	)

/** A request of `worker`, whose owner chain is `top`, then `worker`. */
const create = (ask?: Requests.Ask) =>
	Effect.flatMap(Requests.Requests, (requests) =>
		requests.create(organizationId, {
			bot: worker,
			chain: {
				organizationId,
				userId,
				bots: [top, worker],
				chats: [Chat.Id.make("chat_top")],
			},
			deciders: [top, worker],
			capability: { action: "tools.call", target: "search" },
			reason: "The Bot wants to search.",
			chat: Chat.Id.make("chat_worker"),
			turn: Turn.Id.make("turn_1"),
			toolCallId: "call_1",
			...(ask === undefined ? {} : { ask }),
		}),
	)

interface Line {
	readonly level: string
	readonly message: unknown
}

/** Keeps every log line of a test in place of the normal output. */
const collect = () => {
	let lines: ReadonlyArray<Line> = []
	const layer = Logger.layer([
		Logger.make((log) => {
			lines = [...lines, { level: log.logLevel, message: log.message }]
		}),
	])
	return { layer, lines: () => lines }
}

describe("The Chat of a Bot", () => {
	it("the last Bot uses its own Chat when it gave work to itself", () => {
		const current = Chat.Id.make("chat_work")
		assert.strictEqual(
			Requests.chatOf({
				chain: {
					organizationId,
					userId,
					bots: [worker, worker],
					chats: [Chat.Id.make("chat_parent")],
				},
				bot: worker,
				current,
			}),
			current,
		)
	})

	it("a Bot uses its last earlier Chat when it comes more than once", () => {
		const nearest = Chat.Id.make("chat_near")
		assert.strictEqual(
			Requests.chatOf({
				chain: {
					organizationId,
					userId,
					bots: [top, worker, top, worker],
					chats: [
						Chat.Id.make("chat_first"),
						Chat.Id.make("chat_middle"),
						nearest,
					],
				},
				bot: top,
				current: Chat.Id.make("chat_work"),
			}),
			nearest,
		)
	})

	it("a Bot outside the chain uses the current Chat", () => {
		const current = Chat.Id.make("chat_work")
		assert.strictEqual(
			Requests.chatOf({
				chain: {
					organizationId,
					userId,
					bots: [top, worker],
					chats: [Chat.Id.make("chat_parent")],
				},
				bot: BotsApi.BotId.make("bot_other"),
				current,
			}),
			current,
		)
	})
})

describe("The requests of Bots", () => {
	it.effect(
		"a request waits the default time when the settings cannot be read, and the log says so",
		() => {
			const logs = collect()
			return Effect.gen(function* () {
				const records = yield* memoryRecords
				const stored = yield* create().pipe(
					Effect.provide(layerOf(records.service)),
				)
				assert.strictEqual(
					stored.request.expiresAt - stored.request.createdAt,
					Requests.defaultTimeout,
				)
				const lines = logs.lines()
				assert.strictEqual(lines.length, 1)
				const [line] = lines
				assert.ok(line !== undefined && Arr.isArray(line.message))
				assert.strictEqual(line.level, "Error")
				assert.strictEqual(line.message[0], "The test saved an error record.")
				// The log has no inside error value.
				assert.strictEqual(line.message.length, 1)
			}).pipe(Effect.provide(logs.layer))
		},
	)

	it.effect(
		"Grants go down the chain from the top, and each one names the Grant above it",
		() =>
			Effect.gen(function* () {
				const records = yield* memoryRecords
				yield* Effect.gen(function* () {
					const requests = yield* Requests.Requests
					const grants = yield* Grants.Grants
					const stored = yield* create({ timeoutMs: 1000 })
					const id = stored.request.id
					assert.deepStrictEqual(stored.request.approver, {
						_tag: "Bot",
						bot: top,
					})
					// The top Bot agrees, but it does not hold the capability, so the person decides.
					const escalated = yield* requests.decide(organizationId, id, {
						by: { _tag: "Bot", bot: top },
						allow: true,
						scope: "chat",
					})
					assert.strictEqual(escalated._tag, "Escalated")
					assert.deepStrictEqual(escalated.stored.request.approver, {
						_tag: "Person",
						userId,
					})
					const final = yield* requests.decide(organizationId, id, {
						by: { _tag: "Person", userId },
						allow: true,
						scope: "lifetime",
					})
					assert.strictEqual(final.stored.request.status, "allowed")
					const [above] = yield* grants.list(organizationId, top)
					const [below] = yield* grants.list(organizationId, worker)
					assert.ok(above !== undefined && below !== undefined)
					assert.deepStrictEqual(above.grantedBy, { _tag: "Person", userId })
					assert.strictEqual(above.scope, "lifetime")
					assert.strictEqual(above.parent, undefined)
					assert.deepStrictEqual(below.grantedBy, { _tag: "Bot", bot: top })
					// A `chat` Grant of the worker lasts in the Chat where the worker works.
					assert.strictEqual(below.scope, "chat")
					assert.strictEqual(below.chat, "chat_worker")
					assert.strictEqual(below.parent, above.id)
				}).pipe(Effect.provide(layerOf(records.service)))
			}),
	)

	it.effect(
		"a request that expires while a decision waits for its lock grants nothing",
		() =>
			Effect.gen(function* () {
				const records = yield* memoryRecords
				const waiting = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const held = yield* Deferred.make<void>()
				const service: BotRecords["Service"] = {
					...records.service,
					transaction: (key, operation) =>
						Deferred.succeed(waiting, undefined).pipe(
							Effect.andThen(records.service.transaction(key, operation)),
						),
				}
				yield* Effect.gen(function* () {
					const requests = yield* Requests.Requests
					const grants = yield* Grants.Grants
					const rules = yield* Rules.Rules
					const stored = yield* create({ person: true, timeoutMs: 1000 })
					const id = stored.request.id
					const holder = yield* records.service
						.transaction(
							"request:" + organizationId + ":" + id,
							Deferred.succeed(held, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
						)
						.pipe(Effect.forkScoped)
					yield* Deferred.await(held)
					const decision = yield* requests
						.decide(organizationId, id, {
							by: { _tag: "Person", userId },
							allow: true,
							scope: "lifetime",
							rule: "Allow this search.",
						})
						.pipe(Effect.flip, Effect.forkScoped)
					yield* Deferred.await(waiting)
					yield* TestClock.adjust("2 seconds")
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(holder)
					assert.ok(
						Schema.is(RequestDomain.RequestConflict)(
							yield* Fiber.join(decision),
						),
					)
					assert.equal(
						Option.getOrThrow(yield* requests.find(organizationId, id)).request
							.status,
						"pending",
					)
					assert.equal((yield* grants.list(organizationId, worker)).length, 0)
					assert.equal((yield* rules.list(organizationId, worker)).length, 0)
					const closed = Option.getOrThrow(
						yield* requests.expireOne(organizationId, id),
					)
					assert.equal(closed.request.status, "expired")
				}).pipe(Effect.provide(layerOf(service)))
			}).pipe(Effect.scoped),
	)

	it.effect("two expiry commands at the same time close a request once", () =>
		Effect.gen(function* () {
			const records = yield* memoryRecords
			yield* Effect.gen(function* () {
				const requests = yield* Requests.Requests
				const stored = yield* create({ timeoutMs: 1000, onExpire: "allow" })
				yield* TestClock.adjust("2 seconds")
				const [first, second] = yield* Effect.all(
					[
						requests.expireOne(organizationId, stored.request.id),
						requests.expireOne(organizationId, stored.request.id),
					],
					{ concurrency: 2 },
				)
				const closed = Arr.getSomes([first, second])
				assert.strictEqual(closed.length, 1)
				assert.strictEqual(closed[0]?.request.id, stored.request.id)
				assert.strictEqual(closed[0]?.request.status, "allowed")
				assert.strictEqual(closed[0]?.request.revision, 1)
			}).pipe(Effect.provide(layerOf(records.service)))
		}),
	)

	it.effect(
		"a failed expiry keeps its request pending and does not stop another request",
		() =>
			Effect.gen(function* () {
				const records = yield* memoryRecords
				const broken = yield* Ref.make("")
				const service: BotRecords["Service"] = {
					...records.service,
					transaction: (key, operation) =>
						Effect.flatMap(Ref.get(broken), (id) =>
							key === "request:" + organizationId + ":" + id
								? Effect.fail(BotsApi.BotStorageUnavailable.make({}))
								: records.service.transaction(key, operation),
						),
				}
				yield* Effect.gen(function* () {
					const requests = yield* Requests.Requests
					const first = yield* create({ timeoutMs: 1000 })
					const second = yield* create({ timeoutMs: 1000 })
					yield* Ref.set(broken, second.request.id)
					yield* TestClock.adjust("2 seconds")
					const closed = Option.getOrThrow(
						yield* requests.expireOne(organizationId, first.request.id),
					)
					assert.equal(closed.request.status, "expired")
					const failure = yield* requests
						.expireOne(organizationId, second.request.id)
						.pipe(Effect.flip)
					assert.isTrue(Schema.is(BotsApi.BotStorageUnavailable)(failure))
					assert.equal(
						Option.getOrThrow(
							yield* requests.find(organizationId, second.request.id),
						).request.status,
						"pending",
					)
					yield* Ref.set(broken, "")
					assert.equal(
						Option.getOrThrow(
							yield* requests.expireOne(organizationId, second.request.id),
						).request.status,
						"expired",
					)
				}).pipe(Effect.provide(layerOf(service)))
			}),
	)
})
