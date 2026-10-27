import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Authorization, BotId, Execution } from "@openbot-build/domain"
import { and, asc, eq } from "drizzle-orm"
import { Array as Arr, Effect, Layer, Redacted, String as Str } from "effect"
import { ChannelEvent, Target } from "../src/channels/Channel.ts"
import * as ChannelQueue from "../src/channels/ChannelQueue.ts"
import * as ChannelInbox from "../src/channels/ChannelInbox.ts"
import * as Channels from "../src/channels/Channels.ts"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import {
	channelInbox,
	channelDeliveries,
	executions,
} from "../src/database/Schema.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = ChannelQueue.layer.pipe(
	Layer.provideMerge(ChannelInbox.layer),
	Layer.provideMerge(Layer.merge(Channels.layer, Store.layer)),
	Layer.provide(
		Layer.mock(Authorization.Auth, { domain: Authorization.OpenBot }),
	),
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("12"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const caller = {
	kind: "member",
	organizationId: "org-channel",
	userId: "owner",
} as const
const namespace = ownerKey(caller)
const create = Effect.flatMap(Channels.Channels, (channels) =>
	channels.create({
		caller,
		name: "Team",
		bot: BotId.make("bot-test"),
		credentials: {
			kind: "custom",
			endpoint: "https://channel.example.com",
			secret: null,
		},
		enabled: true,
		linkPath: null,
	}),
)
const message = (eventId: string) =>
	ChannelEvent.Message({
		eventId,
		conversation: { key: "room", kind: "direct" },
		sender: { externalId: "person", displayName: "Person" },
		text: "Private input",
		mentioned: false,
	})

layer(services, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"Channel input has one sealed execution per event and a saved conversation order",
		() =>
			Effect.gen(function* () {
				const channel = yield* create
				const queue = yield* ChannelQueue.ChannelQueue
				const inbox = yield* ChannelInbox.ChannelInbox
				const db = yield* Db.make
				yield* Effect.all(
					[
						queue.receive(caller.organizationId, channel.id, [
							message("first"),
							message("second"),
						]),
						queue.receive(caller.organizationId, channel.id, [
							message("first"),
						]),
					],
					{ concurrency: 2 },
				)
				const rows = yield* db
					.select()
					.from(channelInbox)
					.where(eq(channelInbox.channelId, channel.id))
					.orderBy(asc(channelInbox.position))
				assert.strictEqual(rows.length, 2)
				assert.strictEqual(rows[0]?.eventId, "first")
				assert.strictEqual(rows[1]?.eventId, "second")
				assert.ok(rows[0]?.executionId != null && rows[1]?.executionId != null)
				const first = { namespace, id: Execution.Id.make(rows[0].executionId) }
				const second = { namespace, id: Execution.Id.make(rows[1].executionId) }
				assert.strictEqual((yield* inbox.load(first)).input.predecessor, null)
				assert.deepStrictEqual(
					(yield* inbox.load(second)).input.predecessor,
					first,
				)
				assert.deepStrictEqual(
					(yield* inbox.load(second)).input.event,
					message("second"),
				)
				const raw = yield* db
					.select()
					.from(executions)
					.where(
						and(
							eq(executions.namespace, namespace),
							eq(executions.id, second.id),
						),
					)
				assert.ok(!Str.includes("Private input")(raw[0]!.input))
				assert.strictEqual(rows[1].event, second.id)
			}),
	)
	it.effect(
		"an old inbox row stops admission until data conversion keeps its order",
		() =>
			Effect.gen(function* () {
				const channel = yield* create
				const inbox = yield* ChannelInbox.ChannelInbox
				const db = yield* Db.make
				yield* db.insert(channelInbox).values({
					organizationId: caller.organizationId,
					channelId: channel.id,
					eventId: "old",
					conversationKey: "room",
					event: "broken old input",
					receivedAt: 0,
					nextAt: 0,
				})
				const result = yield* Effect.result(
					inbox.receive(caller.organizationId, channel.id, [message("next")]),
				)
				assert.strictEqual(result._tag, "Failure")
				const rows = yield* db
					.select()
					.from(channelInbox)
					.where(eq(channelInbox.channelId, channel.id))
				assert.strictEqual(rows.length, 1)
				assert.strictEqual(rows[0]?.event, "broken old input")
				assert.strictEqual(rows[0]?.doneAt, null)
			}),
	)
	it.effect(
		"Channel sends use command receipts and cards keep a saved predecessor",
		() =>
			Effect.gen(function* () {
				const channel = yield* create
				const queue = yield* ChannelQueue.ChannelQueue
				const store = yield* Store.Store
				const db = yield* Db.make
				const receipt = yield* store.submit(
					namespace,
					Execution.CommandKey.make("channel-source"),
					{
						workflow: "test",
						resource: { kind: "Turn", id: "turn-test" },
						identity: { owner: caller, actor: caller },
						input: {},
					},
				)
				const fence = yield* store.takeOver({
					namespace,
					id: receipt.executionId,
				})
				const input = {
					channelId: channel.id,
					target: Target.Conversation({ conversation: "room" }),
					message: { markdown: "Private answer" },
				}
				const first = yield* queue.notice(fence, "notice", input)
				assert.deepStrictEqual(
					yield* queue.notice(fence, "notice", input),
					first,
				)
				const one = yield* queue.putRequest(fence, "card:1", {
					...input,
					request: "request-test",
				})
				const two = yield* queue.putRequest(fence, "card:2", {
					...input,
					request: "request-test",
					message: { markdown: "Allowed" },
				})
				assert.deepStrictEqual(
					(yield* queue.load({ namespace, id: two.executionId })).input
						.predecessor,
					{ namespace, id: one.executionId },
				)
				const rows = yield* db
					.select()
					.from(channelDeliveries)
					.where(eq(channelDeliveries.channelId, channel.id))
				assert.strictEqual(rows.length, 2)
				assert.ok(
					Arr.every(rows, (row) => !Str.includes("Private answer")(row.body)),
				)
				yield* store.takeOver(fence)
				const late = yield* Effect.result(queue.notice(fence, "late", input))
				assert.strictEqual(late._tag, "Failure")
				assert.strictEqual(
					(yield* db
						.select()
						.from(channelDeliveries)
						.where(eq(channelDeliveries.channelId, channel.id))).length,
					2,
				)
			}),
	)
})
