import * as BotFixture from "./BotFixture.ts"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Redacted, Schema } from "effect"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import { authorOf } from "../src/chats/ChatHost.ts"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as ChatsFixture from "./ChatsFixture.ts"

it.live(
	"a development Chat survives a restart without replay or leaks between owners",
	() =>
		Effect.gen(function* () {
			const database = yield* PostgresTest.start
			yield* Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const { builtinModels: models } = yield* DevelopmentModel.make
				// The models of a development platform, as each runtime gets them.
				const options = {
					modelCatalog: Effect.succeed({
						providers: models.providers,
						models: models.models,
					}),
					resolveModel: models.resolve,
					defaultModel: DevelopmentModel.selection,
				}
				const chats = yield* ManagedChats.make({
					...options,
					namespace: "first-owner",
				})
				const created = yield* chats.create(BotFixture.direct())
				const id = created.chat.id
				const receipt = yield* chats.deliver(id, {
					input: "Persist this conversation",
					author: authorOf("test-user"),
				})
				assert.strictEqual(receipt.delivery, "started")
				const source = yield* ChatsFixture.settled(chats, id)
				assert.strictEqual(source.status, "Completed")
				assert.strictEqual(source.turn?.id, receipt.turn)
				assert.match(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
						source.response?.output,
					),
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
					Layer.merge(
						ChatsFixture.services,
						DevelopmentModel.layerHostTools,
					).pipe(
						Layer.provideMerge(
							DatabasePostgres.layer({
								databaseUrl: Redacted.make(database.url),
							}),
						),
					),
				),
			)
		}).pipe(Effect.provide(NodeServices.layer)),
)
