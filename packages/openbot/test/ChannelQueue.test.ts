import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Chat, Turn } from "@openbot-build/core"
import { eq } from "drizzle-orm"
import { Array as Arr, Effect, Layer, Logger, Redacted } from "effect"
import { ChannelEvent, Target } from "../src/channels/Channel.ts"
import * as ChannelQueue from "../src/channels/ChannelQueue.ts"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import {
	channelDeliveries,
	channelInbox,
	channels,
} from "../src/database/Schema.ts"
import * as PostgresTest from "./PostgresTest.ts"

const organizationId = "org_1"
const channelId = "chn_1"

const message = (eventId: string, conversation: string) =>
	ChannelEvent.Message({
		eventId,
		conversation: { key: conversation, kind: "direct" },
		sender: { externalId: "person_1", displayName: "Person" },
		text: "Hello",
		mentioned: false,
	})

/** Keeps the messages of the log lines at level Error. */
const collectErrors = () => {
	let lines: ReadonlyArray<unknown> = []
	const layer = Logger.layer([
		Logger.make((log) => {
			if (log.logLevel === "Error") lines = [...lines, log.message]
		}),
	])
	return { layer, lines: () => lines }
}

// The database is real, so the test uses real time.
it.live(
	"a stored row that does not decode ends, and the other rows of the Channel queue still go",
	() => {
		const errors = collectErrors()
		return Effect.gen(function* () {
			const database = yield* PostgresTest.start
			yield* Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const queue = yield* ChannelQueue.ChannelQueue
				const db = yield* Db.make
				yield* db.insert(channels).values({
					organizationId,
					id: channelId,
					kind: "custom",
					name: "Test",
					bot: "bot_1",
					actor: "user_1",
					enabled: true,
					credentials: "{}",
					hints: "{}",
					version: 1,
					createdAt: 0,
					updatedAt: 0,
				})

				// The inbox: the oldest event of one chat does not decode.
				yield* db.insert(channelInbox).values([
					{
						organizationId,
						channelId,
						eventId: "evt_bad",
						conversationKey: "chat_bad",
						event: '{"_tag":"Unknown"}',
						receivedAt: 0,
						nextAt: 0,
					},
					{
						organizationId,
						channelId,
						eventId: "evt_next",
						conversationKey: "chat_bad",
						event: '{"_tag":"Unknown"}',
						receivedAt: 1,
						nextAt: 0,
					},
				])
				yield* queue.receive(organizationId, channelId, [
					message("evt_good", "chat_good"),
				])
				const first = yield* queue.claimEvents
				assert.deepStrictEqual(
					Arr.map(first, (entry) => entry.event.eventId),
					["evt_good"],
				)
				const [bad] = yield* db
					.select()
					.from(channelInbox)
					.where(eq(channelInbox.eventId, "evt_bad"))
				assert.ok(bad !== undefined && bad.doneAt !== null)
				// The bad event no longer stops its chat. The next one does not decode either.
				assert.deepStrictEqual(yield* queue.claimEvents, [])
				const [next] = yield* db
					.select()
					.from(channelInbox)
					.where(eq(channelInbox.eventId, "evt_next"))
				assert.ok(next !== undefined && next.doneAt !== null)

				// The outbox: a message with a target that does not decode.
				yield* db.insert(channelDeliveries).values({
					id: "dlv_bad",
					organizationId,
					channelId,
					kind: "notice",
					target: "{}",
					body: '{"markdown":"Lost"}',
					state: "pending",
					nextAt: 0,
					updatedAt: 0,
				})
				yield* queue.notice({
					organizationId,
					channelId,
					target: Target.Conversation({ conversation: "chat_good" }),
					message: { markdown: "Hi" },
				})
				const due = yield* queue.claimDeliveries
				assert.deepStrictEqual(
					Arr.map(due, (delivery) => delivery.message.markdown),
					["Hi"],
				)
				const [failed] = yield* db
					.select()
					.from(channelDeliveries)
					.where(eq(channelDeliveries.id, "dlv_bad"))
				assert.strictEqual(failed?.state, "failed")

				// The check after a restart: a running reply with a target that does not decode.
				yield* db.insert(channelDeliveries).values({
					id: "dlv_live_bad",
					organizationId,
					channelId,
					kind: "reply",
					target: "not json",
					chat: "chat_1",
					turn: "turn_1",
					body: '{"markdown":""}',
					state: "live",
					nextAt: 0,
					updatedAt: 0,
				})
				yield* queue.startReply({
					organizationId,
					channelId,
					target: Target.Conversation({ conversation: "chat_good" }),
					chat: Chat.Id.make("chat_2"),
					turn: Turn.Id.make("turn_2"),
					ref: null,
				})
				assert.deepStrictEqual(
					Arr.map(yield* queue.liveReplies, (reply) => reply.chat),
					["chat_2"],
				)
				const [live] = yield* db
					.select()
					.from(channelDeliveries)
					.where(eq(channelDeliveries.id, "dlv_live_bad"))
				assert.strictEqual(live?.state, "failed")

				// Each bad row is logged once, at level Error.
				assert.deepStrictEqual(
					Arr.map(errors.lines(), (line) =>
						Arr.isArray(line) ? line[0] : line,
					),
					[
						"A stored Channel event does not decode. OpenBot drops it.",
						"A stored Channel event does not decode. OpenBot drops it.",
						"A stored Channel message does not decode. OpenBot gives up on it.",
						"A stored Channel reply does not decode. OpenBot gives up on it.",
					],
				)

				// The queue says when it gives up on an item.
				const [good] = first
				assert.ok(good !== undefined)
				assert.strictEqual(yield* queue.retryEvent(good), false)
				assert.strictEqual(
					yield* queue.retryEvent({
						...good,
						attempts: ChannelQueue.maxAttempts - 1,
					}),
					true,
				)
				const [delivery] = due
				assert.ok(delivery !== undefined)
				assert.strictEqual(
					yield* queue.retryDelivery(delivery, undefined, false),
					false,
				)
				assert.strictEqual(
					yield* queue.retryDelivery(delivery, undefined, true),
					true,
				)
			}).pipe(
				Effect.provide(
					ChannelQueue.layer.pipe(
						Layer.provideMerge(
							DatabasePostgres.layer({
								databaseUrl: Redacted.make(database.url),
							}),
						),
					),
				),
			)
		}).pipe(Effect.provide(Layer.merge(errors.layer, NodeServices.layer)))
	},
)
