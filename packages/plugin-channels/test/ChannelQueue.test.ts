import * as TestDatabase from "@openbot-build/server-database/Testing"
import { Channels as ChannelsModel } from "@openbot-build/conversation-contract/channels/Channels"
import { BotId } from "@openbot-build/domain/BotId"
import { PgClient } from "@effect/sql-pg"
import * as Migrations from "@openbot-build/server-database/Migrations"
import { SecureRandom } from "effect/crypto"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Authorization, Execution } from "@openbot-build/domain"
import { and, asc, eq } from "drizzle-orm"
import {
	Array as Arr,
	Effect,
	Layer,
	Record as Rec,
	Redacted,
	String as Str,
} from "effect"
import { ChannelEvent, Target } from "../src/Channel.ts"
import * as ChannelQueue from "../src/ChannelQueue.ts"
import * as ChannelInbox from "../src/ChannelInbox.ts"
import * as Channels from "../src/Channels.ts"
import * as Db from "@openbot-build/server-database/Database"
import {
	channelInbox,
	channelDeliveries,
	executions,
} from "@openbot-build/server-database/Schema"
import * as Store from "@openbot-build/server-execution/Store"
import * as Secrets from "@openbot-build/server-kernel/Secrets"
import { ownerKey } from "@openbot-build/apps-contract/apps/StoredConnections"

const database = Layer.effectDiscard(Migrations.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(TestDatabase.start, (db) =>
				PgClient.layer({ url: Redacted.make(db.url) }),
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
	Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
)
const caller = {
	kind: "member",
	organizationId: "org-channel",
	userId: "owner",
} as const
const namespace = ownerKey(caller)
// The Channel stores call no workflow, so a made-up configuration ID is enough.
const create = Effect.gen(function* () {
	const channels = yield* ChannelsModel
	const crypto = yield* SecureRandom.SecureRandom
	return yield* channels.create({
		id: "chn_" + (yield* crypto.uuidV7().pipe(Effect.orDie)),
		executionId: Execution.Id.make("channel-configuration"),
		at: 0,
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
	})
})
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
					Arr.every(rows, (row) =>
						Arr.every(
							Rec.values(row),
							(value) =>
								typeof value !== "string" ||
								!Str.includes("Private answer")(value),
						),
					),
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
