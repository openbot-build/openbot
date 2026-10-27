import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Network } from "@openbot-build/protocol"
import { HttpClient } from "effect/http"
import { AppNetwork } from "../src/apps/AppHost.ts"
import * as ChannelRegistry from "../src/channels/ChannelRegistry.ts"
import { Chat } from "@openbot-build/core"
import { Authorization, BotId, Execution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Effect,
	Fiber,
	Layer,
	Option,
	Redacted,
	Ref,
	String as Str,
} from "effect"
import { AuditLog, type Entry } from "../src/audit/AuditLog.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import { ChannelEvent, Target } from "../src/channels/Channel.ts"
import * as Admission from "../src/channels/ChannelAdmission.ts"
import * as ChannelInbox from "../src/channels/ChannelInbox.ts"
import * as ChannelQueue from "../src/channels/ChannelQueue.ts"
import * as Removal from "../src/channels/ChannelRemoval.ts"
import * as ChannelWatch from "../src/channels/ChannelWatch.ts"
import * as Channels from "../src/channels/Channels.ts"
import * as Db from "../src/database/Database.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import { channelInbox, channelDeliveries } from "../src/database/Schema.ts"
import * as Store from "../src/execution/Store.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Records from "../src/errors/Records.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Postgres from "./PostgresTest.ts"
import * as Wait from "./Wait.ts"

const database = Layer.effectDiscard(Database.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Postgres.start, (db) =>
				Database.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Layer.merge(ChannelQueue.layer, ChannelWatch.layer).pipe(
	Layer.provideMerge(ChannelInbox.layer),
	Layer.provideMerge(Observation.layer),
	Layer.provideMerge(
		Layer.mergeAll(Channels.layer, Store.layer, Records.layer),
	),
	Layer.provide(
		Layer.mock(Authorization.Auth, { domain: Authorization.OpenBot }),
	),
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("45"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const caller = {
	kind: "member",
	organizationId: "org-removal",
	userId: "owner",
} as const
const namespace = ownerKey(caller)
const key = (id: Execution.Id) => ({ namespace, id })
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
const message = (id: string) =>
	ChannelEvent.Message({
		eventId: id,
		conversation: { key: "room", kind: "direct" },
		sender: { externalId: "person", displayName: "Person" },
		text: "Hello",
		mentioned: false,
	})
const auth = Authorizer.layer(Authorization.Auth, {
	policy: () =>
		Effect.succeed(
			Policy.define(Authorization.OpenBot)(function* (_) {
				yield* _.allow("*", "*")
			}),
		),
})
layer(services, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect("the last Channel scope closes its physical connection", () =>
		Effect.gen(function* () {
			const channel = yield* create
			const opened = yield* Ref.make(0)
			const closed = yield* Ref.make(0)
			const registry = yield* ChannelRegistry.make.pipe(
				Effect.provideService(
					HttpClient.HttpClient,
					HttpClient.make(() => Effect.die("No HTTP call is needed")),
				),
				Effect.provideService(AppNetwork, {
					layer: (owner) =>
						Layer.effect(
							Network.Network,
							Effect.acquireRelease(
								Ref.update(opened, (n) => n + 1).pipe(
									Effect.as({
										identity: { scope: "user" as const, owner },
										execute: () => Effect.die("No network call is needed"),
										readDocument: () => Effect.die("No document is needed"),
									}),
								),
								() => Ref.update(closed, (n) => n + 1),
							),
						),
				}),
			)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const first = yield* registry.get(caller.organizationId, channel.id)
					assert.strictEqual(
						yield* registry.get(caller.organizationId, channel.id),
						first,
					)
					assert.strictEqual(yield* Ref.get(opened), 1)
					assert.strictEqual(yield* Ref.get(closed), 0)
				}),
			)
			assert.strictEqual(yield* Ref.get(closed), 1)
		}),
	)

	it.effect(
		"Channel removal closes admission and waits for every delivery version",
		() =>
			Effect.gen(function* () {
				const entries = yield* Ref.make<ReadonlyArray<Entry>>([])
				yield* Effect.gen(function* () {
					const removal = yield* Removal.ChannelRemoval
					const channels = yield* Channels.Channels
					const inbox = yield* ChannelInbox.ChannelInbox
					const queue = yield* ChannelQueue.ChannelQueue
					const watches = yield* ChannelWatch.ChannelWatch
					const store = yield* Store.Store
					const db = yield* Db.make
					const channel = yield* create
					const source = yield* store.submit(
						namespace,
						Execution.CommandKey.make("source"),
						{
							workflow: "test-source",
							resource: { kind: "Turn", id: "turn" },
							identity: { owner: caller, actor: caller },
							input: {},
						},
					)
					const sourceFence = yield* store.takeOver(key(source.executionId))
					yield* channels.saveConversation({
						organizationId: caller.organizationId,
						channelId: channel.id,
						key: "room",
						kind: "direct",
						title: null,
						chat: "chat",
						owner: caller.userId,
					})
					const watched = yield* watches.start(namespace, {
						channelId: channel.id,
						conversation: "room",
						sourceExecutionId: source.executionId,
						reply: true,
						chat: Chat.Id.make("chat"),
					})
					yield* inbox.receive(caller.organizationId, channel.id, [
						message("message"),
					])
					const incoming = (yield* db
						.select()
						.from(channelInbox)
						.where(eq(channelInbox.channelId, channel.id)))[0]!
					assert.ok(incoming.executionId !== null)
					const versions = yield* Effect.forEach([1, 2], (revision) =>
						Effect.gen(function* () {
							const sent = yield* queue.putRequest(
								sourceFence,
								"card:" + revision,
								{
									channelId: channel.id,
									request: "request",
									target: Target.Conversation({ conversation: "room" }),
									message: { markdown: "Version " + revision },
								},
							)
							const actor = { ...caller, userId: "config-" + revision }
							const configNamespace = ownerKey(actor)
							const config = yield* store.submit(
								configNamespace,
								Execution.CommandKey.make("config:" + revision),
								{
									workflow: "openbot.channel-configuration",
									resource: { kind: "ChannelConfiguration", id: channel.id },
									identity: { owner: actor, actor },
									input: {},
								},
							)
							return [
								key(sent.executionId),
								{ namespace: configNamespace, id: config.executionId },
							]
						}),
					)
					const targets = [
						key(watched.executionId),
						key(Execution.Id.make(incoming.executionId)),
						...Arr.flatten(versions),
					]
					const fences = yield* Effect.forEach(targets, (target) =>
						store.takeOver(target),
					)
					const pendingFence = fences[fences.length - 1]!
					const pendingCall = yield* store.intent(pendingFence, {
						step: "register",
						attempt: 0,
						retry: "never",
						input: {},
					})
					yield* store.sending(pendingFence, pendingCall.id)
					const receipt = yield* removal.request(
						caller,
						channel.id,
						Execution.CommandKey.make("remove"),
					)
					assert.deepStrictEqual(
						yield* removal.request(
							caller,
							channel.id,
							Execution.CommandKey.make("remove"),
						),
						receipt,
					)
					const found = yield* channels.get(caller.organizationId, channel.id)
					assert.ok(Option.isSome(found))
					assert.strictEqual(found.value.enabled, false)
					assert.strictEqual(found.value.executionId, receipt.executionId)
					const rejected = yield* Effect.result(
						inbox.receive(caller.organizationId, channel.id, [message("late")]),
					)
					assert.strictEqual(rejected._tag, "Failure")
					assert.strictEqual(
						(yield* Effect.result(
							queue.notice(sourceFence, "late", {
								channelId: channel.id,
								target: Target.Conversation({ conversation: "room" }),
								message: { markdown: "Late" },
							}),
						))._tag,
						"Failure",
					)
					assert.strictEqual(
						(yield* Effect.result(
							watches.start(namespace, {
								channelId: channel.id,
								conversation: "room",
								sourceExecutionId: Execution.Id.make(incoming.executionId),
								reply: false,
								chat: Chat.Id.make("chat"),
							}),
						))._tag,
						"Failure",
					)
					assert.strictEqual(
						(yield* Effect.result(
							removal.authorize(
								key(receipt.executionId),
								{ ...caller, organizationId: "other" },
								"read",
							),
						))._tag,
						"Failure",
					)
					const fence = yield* store.takeOver(key(receipt.executionId))
					const stale = fence
					const current = yield* store.takeOver(fence)
					assert.strictEqual(
						(yield* Effect.result(removal.work(stale)))._tag,
						"Failure",
					)
					const run = yield* removal.work(current).pipe(Effect.forkScoped)
					for (const target of targets)
						yield* Wait.untilTrue(
							"cancel request",
							store.get(target),
							(record) => record.status === "cancelling",
						)
					assert.ok(
						Option.isSome(
							yield* channels.get(caller.organizationId, channel.id),
						),
					)
					assert.strictEqual(
						(yield* db
							.select()
							.from(channelDeliveries)
							.where(eq(channelDeliveries.channelId, channel.id))).length,
						1,
					)
					// The last target acts as a connection whose release has not ended yet.
					for (const current of Arr.dropRight(fences, 1))
						yield* store.finishCancellation(
							current,
							(yield* store.load(current)).cancelEpoch,
						)
					assert.strictEqual(run.pollUnsafe(), undefined)
					assert.ok(
						Option.isSome(
							yield* channels.get(caller.organizationId, channel.id),
						),
					)
					const last = fences[fences.length - 1]!
					yield* store.finishCancellation(
						last,
						(yield* store.load(last)).cancelEpoch,
					)
					assert.strictEqual((yield* store.get(last)).status, "outcome_unknown")
					assert.ok(
						Option.isSome(
							yield* channels.get(caller.organizationId, channel.id),
						),
					)
					assert.strictEqual(run.pollUnsafe(), undefined)
					assert.strictEqual(
						yield* store.finishCall(last, pendingCall.id, { registered: true }),
						false,
					)
					yield* store.recoverCall(last, pendingCall.id)
					yield* store.finishCancellation(
						last,
						(yield* store.load(last)).cancelEpoch,
					)
					yield* Fiber.join(run)
					assert.ok(
						Option.isNone(
							yield* channels.get(caller.organizationId, channel.id),
						),
					)
					assert.strictEqual((yield* store.get(fence)).status, "completed")
					assert.strictEqual(
						(yield* store.get(key(source.executionId))).status,
						"running",
					)
					assert.strictEqual((yield* Ref.get(entries)).length, 1)
					assert.deepStrictEqual(
						yield* removal.request(
							caller,
							channel.id,
							Execution.CommandKey.make("remove"),
						),
						receipt,
					)
					assert.strictEqual(
						(yield* db
							.select()
							.from(channelInbox)
							.where(
								and(
									eq(channelInbox.organizationId, caller.organizationId),
									eq(channelInbox.channelId, channel.id),
								),
							)).length,
						0,
					)
					assert.strictEqual((yield* Ref.get(entries)).length, 1)
				}).pipe(
					Effect.provide(Removal.layer.pipe(Layer.provide(auth))),
					Effect.provideService(AuditLog, {
						record: (entry) =>
							Ref.update(entries, (all) => Arr.append(all, entry)),
						list: () => Effect.succeed({ items: [], next: null }),
					}),
				)
			}),
		60000,
	)
	it.effect(
		"cancelled removal keeps a disabled Channel and permits an explicit new change",
		() =>
			Effect.gen(function* () {
				const channel = yield* create
				const removal = yield* Removal.ChannelRemoval
				const store = yield* Store.Store
				const channels = yield* Channels.Channels
				const receipt = yield* removal.request(
					caller,
					channel.id,
					Execution.CommandKey.make("cancelled-remove"),
				)
				const fence = yield* store.takeOver(key(receipt.executionId))
				yield* store.cancel(
					fence,
					Execution.CommandKey.make("cancel-removal"),
					caller,
				)
				yield* removal.finish(fence, {
					status: "cancelled",
					epoch: (yield* store.load(fence)).cancelEpoch,
				})
				assert.strictEqual((yield* store.get(fence)).status, "cancelled")
				const found = yield* channels.get(caller.organizationId, channel.id)
				assert.ok(Option.isSome(found))
				assert.strictEqual(found.value.enabled, false)
				const admit = yield* Admission.make
				assert.strictEqual(
					(yield* admit(caller.organizationId, channel.id, false)).id,
					channel.id,
				)
			}).pipe(
				Effect.provide(Removal.layer.pipe(Layer.provide(auth))),
				Effect.provideService(AuditLog, {
					record: () =>
						Effect.die("Cancelled removal has no delete audit entry"),
					list: () => Effect.succeed({ items: [], next: null }),
				}),
			),
		60000,
	)
})
