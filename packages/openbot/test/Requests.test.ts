import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import {
	BotsApi,
	type Caller,
	Settings as SettingsApi,
} from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	Logger,
	Option,
	Ref,
	Schema,
	Semaphore,
} from "effect"
import { TestClock } from "effect/testing"
import { AuditLog, AuditUnavailable } from "../src/audit/AuditLog.ts"
import { BotRecords, type Keys } from "../src/bots/BotRecords.ts"
import { type Signal, Signals } from "../src/bots/Signals.ts"
import * as Grants from "../src/capabilities/Grants.ts"
import * as Requests from "../src/capabilities/Requests.ts"
import * as Resolve from "../src/capabilities/Resolve.ts"
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
 * all keys is enough for these tests. `afterStatusRead` runs after each read of
 * `withStatus`, so a test can change the records between that read and the next step.
 */
const memoryRecords = Effect.gen(function* () {
	const rows = yield* Ref.make(HashMap.empty<string, Row>())
	const lock = yield* Semaphore.make(1)
	const afterStatusRead = yield* Ref.make<Effect.Effect<void>>(Effect.void)
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
				withStatus: (status) =>
					select((keys) => keys.status === status).pipe(
						Effect.flatMap(
							Effect.forEach((row) =>
								Effect.map(decode(row.body), (value) => ({
									organizationId: row.keys.organizationId,
									value,
								})),
							),
						),
						Effect.tap(() => Effect.flatten(Ref.get(afterStatusRead))),
					),
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
	return { service, afterStatusRead }
})

/** The services of requests on records in memory. The settings cannot be read. */
const layerOf = (records: BotRecords["Service"]) =>
	Requests.layer.pipe(
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
				assert.strictEqual(line.level, "Warn")
				assert.strictEqual(
					line.message[0],
					"The request timeout of the organization could not be read, so the request uses the default one",
				)
				// The log keeps the failure that the fallback hides.
				assert.ok(Schema.is(SettingsApi.SettingsUnavailable)(line.message[1]))
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
		"a decision between the read and the close of expire wins, and expire closes nothing",
		() =>
			Effect.gen(function* () {
				const records = yield* memoryRecords
				yield* Effect.gen(function* () {
					const requests = yield* Requests.Requests
					const grants = yield* Grants.Grants
					const stored = yield* create({ person: true, timeoutMs: 1000 })
					const id = stored.request.id
					yield* TestClock.adjust("2 seconds")
					yield* Ref.set(
						records.afterStatusRead,
						requests
							.decide(organizationId, id, {
								by: { _tag: "Person", userId },
								allow: true,
							})
							.pipe(Effect.orDie, Effect.asVoid),
					)
					assert.deepStrictEqual(yield* requests.expire, [])
					const found = yield* requests.find(organizationId, id)
					assert.ok(Option.isSome(found))
					assert.strictEqual(found.value.request.status, "allowed")
					assert.deepStrictEqual(found.value.request.decision?.by, {
						_tag: "Person",
						userId,
					})
					assert.strictEqual(
						(yield* grants.list(organizationId, worker)).length,
						1,
					)
				}).pipe(Effect.provide(layerOf(records.service)))
			}),
	)

	it.effect("two runs of expire at the same time close a request once", () =>
		Effect.gen(function* () {
			const records = yield* memoryRecords
			yield* Effect.gen(function* () {
				const requests = yield* Requests.Requests
				const stored = yield* create({ timeoutMs: 1000, onExpire: "allow" })
				yield* TestClock.adjust("2 seconds")
				// Both runs read the pending request before either one closes it.
				const reads = yield* Ref.make(0)
				const bothRead = yield* Deferred.make<void>()
				yield* Ref.set(
					records.afterStatusRead,
					Ref.updateAndGet(reads, (count) => count + 1).pipe(
						Effect.flatMap((count) =>
							count === 2 ? Deferred.succeed(bothRead, undefined) : Effect.void,
						),
						Effect.andThen(Deferred.await(bothRead)),
					),
				)
				const [first, second] = yield* Effect.all(
					[requests.expire, requests.expire],
					{ concurrency: 2 },
				)
				const closed = [...first, ...second]
				assert.strictEqual(closed.length, 1)
				assert.strictEqual(closed[0]?.value.request.id, stored.request.id)
				assert.strictEqual(closed[0]?.value.request.status, "allowed")
				assert.strictEqual(closed[0]?.value.request.revision, 1)
			}).pipe(Effect.provide(layerOf(records.service)))
		}),
	)

	it.effect(
		"a request that expire cannot close stays pending, and expire still returns the others",
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
					const closed = yield* requests.expire
					assert.deepStrictEqual(
						Arr.map(closed, (entry) => entry.value.request.id),
						[first.request.id],
					)
					assert.strictEqual(closed[0]?.value.request.status, "expired")
					const left = yield* requests.find(organizationId, second.request.id)
					assert.ok(Option.isSome(left))
					assert.strictEqual(left.value.request.status, "pending")
				}).pipe(Effect.provide(layerOf(service)))
			}),
	)

	it.effect(
		"a decision that the audit log cannot record still tells the waiting work",
		() =>
			Effect.gen(function* () {
				const records = yield* memoryRecords
				const published = yield* Ref.make<ReadonlyArray<Signal>>([])
				yield* Effect.gen(function* () {
					const requests = yield* Requests.Requests
					const resolve = yield* Resolve.make
					const stored = yield* create({ person: true, timeoutMs: 1000 })
					const id = stored.request.id
					const caller: Caller = { kind: "member", organizationId, userId }
					const exit = yield* Effect.exit(
						resolve.resolveAsPerson(caller, id, {
							expected: 0,
							decision: "allow",
						}),
					)
					// The person hears that the audit log failed.
					assert.ok(Exit.isFailure(exit))
					assert.ok(
						Schema.is(BotsApi.BotStorageUnavailable)(
							Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
						),
					)
					// But the decision is kept, and the waiting work hears of it.
					const found = yield* requests.find(organizationId, id)
					assert.ok(Option.isSome(found))
					assert.strictEqual(found.value.request.status, "allowed")
					assert.deepStrictEqual(
						Arr.map(yield* Ref.get(published), (signal) => signal._tag),
						["RequestChanged"],
					)
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							layerOf(records.service),
							Layer.succeed(Signals, {
								...({} as Signals["Service"]),
								publish: (signal) => Ref.update(published, Arr.append(signal)),
							}),
							Layer.succeed(AuditLog, {
								...({} as AuditLog["Service"]),
								record: () =>
									Effect.fail(
										AuditUnavailable.make({ cause: "The database is down." }),
									),
							}),
						),
					),
				)
			}),
	)
})
