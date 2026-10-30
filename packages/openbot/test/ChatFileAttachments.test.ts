import { assert, layer } from "@effect/vitest"
import { ChatView } from "@openbot-build/api"
import { Item, Turn } from "@openbot-build/core"
import { and, eq } from "drizzle-orm"
import { Clock, Effect, Schema, Array as Arr } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"
import * as Db from "../src/database/Database.ts"
import { files, fileRefs } from "../src/database/Schema.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"

const Items = Schema.Struct({
	items: Schema.Array(Item.Record),
	next: Schema.NullOr(Item.Seq),
})
const Turns = Schema.Struct({
	items: Schema.Array(Turn.Record),
	next: Schema.NullOr(Turn.Id),
})
const publicOrigin = "https://attachments.example.com"
layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "90 seconds",
})((it) => {
	it.effect(
		"saved files attach once to idle history without a model call and remain safe in later context",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const call = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const alice = yield* host.login("attachment-alice")
				const bob = yield* host.login("attachment-bob")
				const send: Messages.Send = (path, method, payload) =>
					call(alice.session, path, method, payload)
				const botId = yield* host.defaultBot(alice.session)
				const chat = yield* send("/v1/chats", "POST", {
					botId,
					requestId: "attachments",
				}).pipe(Effect.flatMap(Caller.json(ChatView, 201)))
				const path = "/v1/chats/" + chat.chat.id
				yield* host.run(
					Effect.gen(function* () {
						const db = yield* Db.make
						const now = yield* Clock.currentTimeMillis
						yield* db.insert(files).values([
							{
								id: "file_slides",
								...alice.identity,
								filename: "slides.pptx",
								mediaType:
									"application/vnd.openxmlformats-officedocument.presentationml.presentation",
								bytes: 6,
								status: "ready",
								objectKey: "unused-test-object",
								createdAt: now,
								updatedAt: now,
							},
							{
								id: "file_second",
								...alice.identity,
								filename: "other.txt",
								mediaType: "text/plain",
								bytes: 1,
								status: "ready",
								objectKey: "unused-test-object-2",
								createdAt: now,
								updatedAt: now,
							},
							{
								id: "file_pending",
								...alice.identity,
								filename: "pending.txt",
								mediaType: "text/plain",
								bytes: 1,
								status: "pending",
								objectKey: "unused-test-pending",
								createdAt: now,
								updatedAt: now,
							},
							{
								id: "file_private",
								...bob.identity,
								filename: "private.txt",
								mediaType: "text/plain",
								bytes: 1,
								status: "ready",
								objectKey: "unused-test-private",
								createdAt: now,
								updatedAt: now,
							},
						])
					}),
				)
				const input = {
					fileId: "file_slides",
					requestId: "restore-slides",
					expected: chat.chat.revision,
				}
				const attach = () =>
					send(path + "/files", "POST", input).pipe(
						Effect.flatMap(Caller.json(ChatView)),
					)
				const concurrent = yield* Effect.all([attach(), attach()], {
					concurrency: 2,
				})
				assert.strictEqual(concurrent[0].status, "Idle")
				assert.strictEqual(concurrent[0].executionId, null)
				assert.strictEqual(concurrent[0].inbox, 0)
				assert.strictEqual(
					concurrent[0].chat.revision,
					concurrent[1].chat.revision,
				)
				assert.strictEqual(
					(yield* attach()).chat.revision,
					concurrent[0].chat.revision,
				)
				const items = yield* send(path + "/items", "GET").pipe(
					Effect.flatMap(Caller.json(Items)),
				)
				assert.strictEqual(items.items.length, 1)
				assert.strictEqual(items.items[0]!.origin, undefined)
				const message = items.items[0]!.content.content[0]!
				assert.strictEqual(message.role, "user")
				const encoded = yield* Schema.encodeEffect(
					Schema.fromJsonString(Item.Record),
				)(items.items[0]!)
				assert.include(encoded, "openbot-file:file_slides")
				assert.include(encoded, '"delivery":"attachment"')
				const turns = yield* send(path + "/turns", "GET").pipe(
					Effect.flatMap(Caller.json(Turns)),
				)
				assert.strictEqual(turns.items.length, 0)
				assert.strictEqual(yield* host.toolCalls, 0)
				assert.strictEqual(yield* host.consolidations, 0)
				const refs = yield* host.run(
					Effect.gen(function* () {
						const db = yield* Db.make
						return yield* db
							.select()
							.from(fileRefs)
							.where(
								and(
									eq(fileRefs.file, input.fileId),
									eq(fileRefs.namespace, ownerKey(alice.identity)),
									eq(fileRefs.chat, chat.chat.id),
								),
							)
					}),
				)
				assert.strictEqual(refs.length, 1)
				assert.strictEqual(
					(yield* send(path + "/files", "POST", {
						...input,
						fileId: "file_second",
					})).status,
					409,
				)
				assert.strictEqual(
					(yield* send(path + "/files", "POST", {
						...input,
						requestId: "stale",
					})).status,
					409,
				)
				assert.strictEqual(
					(yield* send(path + "/files", "POST", {
						...input,
						expected: concurrent[0].chat.revision,
						requestId: "private",
						fileId: "file_private",
					})).status,
					400,
				)
				assert.strictEqual(
					(yield* send(path + "/files", "POST", {
						...input,
						expected: concurrent[0].chat.revision,
						requestId: "pending",
						fileId: "file_pending",
					})).status,
					400,
				)
				assert.notStrictEqual(
					(yield* call(bob.session, path + "/files", "POST", input)).status,
					200,
				)
				// No object storage exists in this fixture. A later model call would fail if PPT bytes were loaded.
				yield* Messages.send(
					send,
					chat.chat.id,
					"Continue with a normal text answer.",
				)
				const continued = yield* Messages.settled(send, chat.chat.id)
				assert.strictEqual(continued.response?.status, "completed")
				const originalIds = Arr.map(
					(yield* send(path + "/items", "GET").pipe(
						Effect.flatMap(Caller.json(Items)),
					)).items,
					(entry) => entry.id,
				)
				assert.strictEqual(
					Arr.filter(originalIds, (id) => id === items.items[0]!.id).length,
					1,
				)
				yield* Messages.send(send, chat.chat.id, "slow work")
				const running = yield* Messages.view(send, chat.chat.id)
				assert.strictEqual(
					(yield* send(path + "/files", "POST", {
						...input,
						expected: running.chat.revision,
						requestId: "busy",
					})).status,
					409,
				)
				// Read-only recovery remains safe even while later work is active.
				assert.strictEqual((yield* attach()).chat.id, chat.chat.id)
			}),
	)
})
