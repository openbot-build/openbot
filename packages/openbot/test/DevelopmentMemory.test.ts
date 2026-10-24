// @effect-diagnostics strictEffectProvide:off
import * as BotFixture from "./BotFixture.ts"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type { ChatView } from "@openbot-build/api"
import { Effect, Layer, Redacted } from "effect"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import type { ServiceError } from "../src/chats/Chats.ts"
import { authorOf } from "../src/chats/ChatHost.ts"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

it.live(
	"a development Chat survives a restart without replay or leaks between owners",
	() =>
		Effect.gen(function* () {
			const database = yield* Effect.acquireRelease(
				Effect.promise(() => PostgresTest.start()),
				(database) => Effect.promise(() => database.close()),
			)
			yield* Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { builtinModels: models, chats: options } =
					yield* DevelopmentModel.make
				const chats = yield* ManagedChats.make({
					...options,
					modelCatalog: Effect.succeed(models),
					defaults: Effect.succeed({ model: DevelopmentModel.selection }),
					resolveModel: (selection) =>
						models.resolve(selection ?? DevelopmentModel.selection),
					namespace: "first-owner",
				})
				const created = yield* chats.create(BotFixture.direct())
				const id = created.chat.id
				const receipt = yield* chats.deliver(id, {
					input: "Persist this conversation",
					author: authorOf("test-user"),
				})
				assert.strictEqual(receipt.delivery, "started")
				const settle = (
					view: ChatView,
				): Effect.Effect<ChatView, ServiceError> =>
					view.activity !== "active" &&
					view.status !== "Running" &&
					view.inbox === 0
						? Effect.succeed(view)
						: chats
								.wait(id, view.chat.revision, 1000, view.activity)
								.pipe(Effect.flatMap(settle))
				const source = yield* chats.get(id).pipe(Effect.flatMap(settle))
				assert.strictEqual(source.status, "Completed")
				assert.strictEqual(source.turn?.id, receipt.turn)
				assert.match(
					JSON.stringify(source.response?.output),
					/Development response: Persist this conversation/,
				)
				const items = yield* chats.items(id, {})
				assert.ok(items.items.length >= 2)
				const turns = yield* chats.turns(id, {})
				assert.strictEqual(turns.items.length, 1)
				// A new instance reads the same Chat. It does not run the Turn again.
				const restored = yield* ManagedChats.make({
					...options,
					namespace: "first-owner",
				})
				const resumed = yield* restored.get(id)
				assert.deepStrictEqual(resumed, { ...source, activity: "inactive" })
				assert.deepStrictEqual(yield* restored.items(id, {}), items)
				assert.deepStrictEqual(yield* restored.turns(id, {}), turns)
				assert.strictEqual(resumed.activity, "inactive")
				// Another owner does not see the Chat.
				const other = yield* ManagedChats.make({
					...options,
					namespace: "other-owner",
				})
				assert.strictEqual(
					(yield* other.get(id).pipe(Effect.flip))._tag,
					"ChatNotFound",
				)
				assert.strictEqual(
					(yield* other.items(id, {}).pipe(Effect.flip))._tag,
					"ChatNotFound",
				)
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
						DevelopmentModel.layerTools,
					).pipe(Layer.provide(NodeServices.layer)),
				),
			)
		}),
)
