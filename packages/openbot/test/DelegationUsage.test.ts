import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Chat } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Effect, Exit, Layer, Redacted, Schema, String as Str } from "effect"
import * as DelegationUsage from "../src/bots/DelegationUsage.ts"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import { usageEvents } from "../src/database/Schema.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
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
const services = Store.layer.pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const identity = {
	owner: { organizationId: "org", userId: "user" },
	actor: { kind: "member", organizationId: "org", userId: "user" },
} as const

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"usage keeps a read failure and stays stopped when interrupted",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const key = {
					namespace: "usage-unavailable",
					id: Execution.Id.make("delegation"),
				}
				const unavailable = Execution.StorageError.make({
					cause: "The usage store is down.",
				})
				const read = (loadMember: Store.Store["Service"]["loadMember"]) =>
					DelegationUsage.make.pipe(
						Effect.provideService(Store.Store, { ...store, loadMember }),
						Effect.flatMap((usage) => usage.read(key)),
					)
				const failure = yield* read(() => Effect.fail(unavailable)).pipe(
					Effect.flip,
				)
				assert.ok(Schema.is(Execution.StorageError)(failure))
				assert.strictEqual(failure, unavailable)
				assert.ok(
					Exit.hasInterrupts(
						yield* read(() => Effect.interrupt).pipe(Effect.exit),
					),
				)
			}),
	)
	it.effect(
		"usage follows task executions across namespaces and keeps review costs apart",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const db = yield* Db.make
				const usage = yield* DelegationUsage.make
				const create = (
					namespace: string,
					name: string,
					kind: Execution.Resource["kind"],
					owner?: Store.Key,
					input: Store.Submission["input"] = {},
				) =>
					store
						.submit(namespace, Execution.CommandKey.make(name), {
							workflow: kind === "Turn" ? "openbot.chat-turn" : "test",
							resource: { kind, id: name },
							identity,
							input,
							...(owner === undefined ? {} : { ownerExecutionId: owner.id }),
						})
						.pipe(
							Effect.map((receipt) => ({ namespace, id: receipt.executionId })),
						)
				const root = yield* create("first", "root", "Delegation")
				const middle = yield* create("second", "middle", "Delegation", root)
				const child = yield* create("third", "child", "Delegation", middle)
				const next = yield* create("first", "next", "Delegation")
				const task = (
					owner: Store.Key,
					chat: string,
					kind: "task" | "review" = "task",
				) =>
					create(owner.namespace, `${owner.id}:${chat}`, "Turn", owner, {
						chat: Chat.Id.make(chat),
						host: {
							kind,
							bot: "bot",
							ownerExecutionId: owner.id,
							chain: {
								organizationId: "org",
								userId: "user",
								bots: ["bot"],
								chats: [],
							},
						},
					})
				const own = yield* task(root, "root-chat")
				const nested = yield* task(child, "child-chat")
				const review = yield* task(root, "review-chat", "review")
				const later = yield* task(next, "root-chat")
				const add = (
					key: Store.Key,
					name: string,
					chat: string,
					source: string,
					status: string,
					cost: number,
				) =>
					db.insert(usageEvents).values({
						id: name,
						executionId: key.id,
						status,
						startedAt: 1,
						organizationId: "org",
						occurredAt: 1,
						source,
						chatId: chat,
						providerId: "test",
						providerOwner: "organization",
						modelId: "test",
						inputUncached: 0,
						inputCacheRead: 0,
						inputCacheWrite: 0,
						outputText: 0,
						outputReasoning: 0,
						costMicros: cost,
						charged: false,
					})
				yield* add(own, "own", "root-chat", "turn", "confirmed", 10)
				yield* add(own, "unknown", "root-chat", "turn", "unknown", 0)
				yield* add(own, "pending", "root-chat", "turn", "pending", 0)
				yield* add(own, "compact", "root-chat", "compaction", "confirmed", 20)
				yield* add(own, "judge", "root-chat", "judge", "confirmed", 5)
				yield* add(nested, "nested", "child-chat", "turn", "confirmed", 40)
				yield* add(review, "review", "review-chat", "turn", "confirmed", 100)
				yield* add(later, "later", "root-chat", "turn", "confirmed", 200)
				yield* usage.begin(root, 0, 0)
				yield* usage.close(root, 30)
				yield* usage.begin(root, 1, 60)
				yield* usage.close(root, 100)
				yield* usage.begin(middle, 0, 0)
				yield* usage.close(middle, 20)
				yield* usage.begin(middle, 1, 40)
				yield* usage.close(middle, 70)
				yield* usage.begin(child, 0, 10)
				yield* usage.close(child, 100)
				assert.deepEqual(yield* usage.read(root), {
					steps: 3,
					costMicros: 75,
					timeMs: 70,
				})
				assert.deepEqual(yield* usage.read(child), {
					steps: 1,
					costMicros: 40,
					timeMs: 20,
				})
				assert.equal((yield* usage.read(child, 15)).timeMs, 5)
				assert.deepEqual(yield* usage.read(next), {
					steps: 1,
					costMicros: 200,
					timeMs: 0,
				})
				// A new owner sees the same periods and usage after takeover.
				yield* store.takeOver(child)
				yield* store.takeOver(child)
				assert.deepEqual(yield* usage.read(child), {
					steps: 1,
					costMicros: 40,
					timeMs: 20,
				})
			}),
	)
})
