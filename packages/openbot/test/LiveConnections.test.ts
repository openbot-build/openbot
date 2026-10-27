import * as Db from "../src/database/Database.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as ModelFailure from "../src/models/ModelFailure.ts"
import * as Resource from "../src/resources/Resource.ts"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { assert, layer } from "@effect/vitest"
import {
	Chat,
	ChatStoreRepository,
	Store as CoreStore,
	Config,
	Model,
	Provider,
} from "@openbot-build/core"
import { Authorization, Bots, Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Option,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Redacted,
	Ref,
	Scope,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as LiveConnections from "../src/chats/live/LiveConnections.ts"
import { Registry } from "../src/execution/Engine.ts"
import * as Send from "../src/execution/Send.ts"
import * as Store from "../src/execution/Store.ts"
import { Directory } from "../src/resources/Directory.ts"
import { Transport } from "../src/resources/Transport.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as ResourceFixture from "./ResourceFixture.ts"

class Allowed extends Context.Service<Allowed, Ref.Ref<boolean>>()(
	"@openbot-build/openbot/test/LiveConnections.test/Allowed",
) {}
const auth = Authorizer.layer(Authorization.Auth, {
	policy: () =>
		Effect.gen(function* () {
			const allowed = yield* Ref.get(yield* Allowed)
			return Policy.define(Authorization.OpenBot)(function* (_) {
				if (allowed) yield* _.allow("*", "*")
			})
		}),
})
const services = Send.layer.pipe(
	Layer.provideMerge(
		Layer.mock(Registry, {
			get: () =>
				Effect.succeedSome({
					start: () => Effect.void,
					cancel: () => Effect.void,
					signal: () => Effect.void,
					authorize: () => Effect.void,
				}),
		}),
	),
	Layer.provideMerge(
		Store.layer.pipe(
			Layer.provide(
				Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
			),
		),
	),
	Layer.provideMerge(
		auth.pipe(Layer.provideMerge(Layer.effect(Allowed, Ref.make(true)))),
	),
	Layer.provideMerge(ResourceFixture.services),
)
const actor = {
	kind: "member",
	organizationId: "live-org",
	userId: "live-user",
} as const
const identity = { owner: actor, actor }
const selection = Config.Selection.make({
	provider: Provider.Id.make("live"),
	model: Model.Id.make("voice"),
})
const make = (node: Effect.Success<ReturnType<typeof ResourceFixture.start>>) =>
	Effect.provide(
		LiveConnections.LiveConnections,
		LiveConnections.layer.pipe(
			Layer.provide(
				Layer.merge(
					Layer.succeed(Transport, node.transport),
					Layer.succeed(Directory, node.directory),
				),
			),
		),
	)
const holdConnection = Effect.fn(function* (
	physical: typeof LiveConnections.LiveConnections.Service,
	input: Parameters<typeof physical.use>[0],
) {
	const ready =
		yield* Deferred.make<Parameters<Parameters<typeof physical.use>[1]>[0]>()
	const running = yield* physical
		.use(input, (connection) =>
			Deferred.succeed(ready, connection).pipe(Effect.andThen(Effect.never)),
		)
		.pipe(Effect.forkScoped)
	return yield* Effect.raceFirst(
		Deferred.await(ready),
		Fiber.join(running).pipe(
			Effect.andThen(Effect.die("The Live owner ended before registration")),
		),
	)
})
const begin = (chat: Chat.Id) =>
	Effect.gen(function* () {
		const store = yield* Store.Store
		const namespace = ownerKey(actor)
		const definition = yield* CoreStore.define({
			stores: { [ChatHost.chatHostId]: ChatHost.chatHostStore },
			schemaVersion: "chat/1",
		})
		const chats = yield* ChatStoreRepository.make({
			definition,
			persistence: StoredChats.persistence(yield* Db.make, namespace),
		})
		yield* chats.create({
			id: chat,
			settings: { model: selection },
			business: {
				[ChatHost.chatHostId]: {
					bot: Bots.BotId.make("live-bot"),
					kind: "live",
					chain: {
						organizationId: actor.organizationId,
						userId: actor.userId,
						bots: [],
						chats: [],
					},
				},
			},
		})
		const receipt = yield* store.submit(
			namespace,
			Execution.CommandKey.make(chat),
			{
				workflow: "live-test",
				resource: { kind: "Turn", id: chat + "-turn" },
				identity,
				input: { chat },
			},
		)
		const fence = yield* store.takeOver({ namespace, id: receipt.executionId })
		const call = yield* store.intent(fence, {
			step: "model",
			attempt: 0,
			retry: "never",
			input: null,
		})
		yield* store.sending(fence, call.id)
		return {
			fence,
			authority: Send.Authority.cases.Call.make({
				reference: { ...fence, callId: call.id },
			}),
		}
	})
const finish = Response.makePart("finish", {
	reason: "stop",
	usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
})
layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"Live model calls cross nodes and reject revoked rights and stale execution ownership",
		() =>
			Effect.gen(function* () {
				const owner = yield* ResourceFixture.start()
				const remote = yield* ResourceFixture.start()
				const physical = yield* make(owner)
				const client = yield* make(remote)
				const chat = Chat.Id.make("live-cross-node")
				const { fence, authority } = yield* begin(chat)
				const called = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () =>
						Ref.update(called, (n) => n + 1).pipe(
							Effect.as([
								Response.makePart("text", { text: "Hello." }),
								finish,
							]),
						),
					streamText: () =>
						Stream.make(
							Response.makePart("text-start", { id: "one" }),
							Response.makePart("text-delta", { id: "one", delta: "Hello." }),
							Response.makePart("text-end", { id: "one" }),
							finish,
						),
				})
				const connectionScope = yield* Scope.fork(yield* Scope.Scope)
				yield* holdConnection(physical, {
					identity,
					chat,
					selection,
					model: Effect.succeed(model),
					started: () => Effect.void,
				}).pipe(Scope.provide(connectionScope))
				assert.isTrue(yield* client.available(fence.namespace, chat))
				const proxy = yield* client.model(fence, chat, selection)
				const answer = yield* proxy
					.generateText({ prompt: "Hello" })
					.pipe(Send.provide(authority))
				assert.strictEqual(answer.text, "Hello.")
				const parts = yield* proxy
					.streamText({ prompt: "Hello" })
					.pipe(Stream.runCollect, Send.provide(authority))
				assert.deepStrictEqual(
					Arr.map(parts, (part) => part.type),
					["text-start", "text-delta", "text-end", "finish"],
				)
				yield* Ref.set(yield* Allowed, false)
				const denied = yield* proxy
					.generateText({ prompt: "Hello" })
					.pipe(Send.provide(authority), Effect.flip)
				assert.strictEqual(denied.reason._tag, "UnknownError")
				assert.equal(
					Option.getOrThrow(ModelFailure.fromCause(Cause.fail(denied)))
						.category,
					"forbidden",
				)
				assert.strictEqual(yield* Ref.get(called), 1)
				yield* Ref.set(yield* Allowed, true)
				yield* (yield* Store.Store).takeOver(fence)
				yield* proxy
					.generateText({ prompt: "Hello" })
					.pipe(Send.provide(authority), Effect.flip)
				assert.strictEqual(yield* Ref.get(called), 1)
				yield* Scope.close(connectionScope, Exit.void)
				assert.isFalse(yield* client.available(fence.namespace, chat))
			}),
	)
	it.effect(
		"a lost follow reply retries the same healthy Live connection",
		() =>
			Effect.gen(function* () {
				const owner = yield* ResourceFixture.start()
				const remote = yield* ResourceFixture.start()
				const physical = yield* make(owner)
				const follows = yield* Ref.make(0)
				const client = yield* make({
					...remote,
					transport: {
						...remote.transport,
						callAt: (address, input) =>
							Stream.unwrap(
								Effect.gen(function* () {
									if (
										address.kind === "live-session" &&
										(yield* Ref.updateAndGet(follows, (count) => count + 1)) ===
											1
									) {
										yield* remote.transport
											.callAt(address, input)
											.pipe(Stream.runDrain)
										return Stream.fail(
											Resource.Failed.make({
												resource: address,
												outcome: "unknown",
												failure: {
													category: "unavailable",
													errorId: Execution.ErrorId.make("lost-follow-reply"),
												},
											}),
										)
									}
									return remote.transport.callAt(address, input)
								}),
							),
					},
				})
				const chat = Chat.Id.make("live-follow-retry")
				const { fence, authority } = yield* begin(chat)
				const calls = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () =>
						Ref.update(calls, (n) => n + 1).pipe(Effect.as([finish])),
					streamText: () => Stream.empty,
				})
				const held = yield* holdConnection(physical, {
					identity,
					chat,
					selection,
					model: Effect.succeed(model),
					started: () => Effect.void,
				})
				yield* client.wait(fence, chat, selection)
				assert.strictEqual(yield* Ref.get(follows), 2)
				assert.isTrue(yield* owner.transport.exists(held.address))
				assert.strictEqual(yield* Ref.get(calls), 0)
				yield* (yield* client.model(fence, chat, selection))
					.generateText({ prompt: "Saved input" })
					.pipe(Send.provide(authority))
				assert.strictEqual(yield* Ref.get(calls), 1)
			}).pipe(Effect.timeout("10 seconds")),
	)

	it.effect(
		"an interrupted RPC retires its physical lease before another response can use it",
		() =>
			Effect.gen(function* () {
				const owner = yield* ResourceFixture.start()
				const remote = yield* ResourceFixture.start()
				const physical = yield* make(owner)
				const client = yield* make(remote)
				const chat = Chat.Id.make("live-interrupted-rpc")
				const { fence, authority } = yield* begin(chat)
				const started = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () =>
						Effect.gen(function* () {
							yield* Ref.update(calls, (n) => n + 1)
							yield* Deferred.succeed(started, undefined)
							return yield* Effect.never
						}),
					streamText: () => Stream.empty,
				})
				const held = yield* holdConnection(physical, {
					identity,
					chat,
					selection,
					model: Effect.succeed(model),
					started: () => Effect.void,
				})
				const proxy = yield* client.model(fence, chat, selection)
				const request = yield* proxy
					.generateText({ prompt: "First" })
					.pipe(Send.provide(authority), Effect.forkScoped)
				yield* Deferred.await(started)
				yield* Fiber.interrupt(request)
				yield* held.lost
				assert.isFalse(yield* owner.transport.exists(held.address))
				const later = yield* proxy
					.generateText({ prompt: "Second" })
					.pipe(Send.provide(authority), Effect.forkScoped)
				const nextModel = yield* LanguageModel.make({
					generateText: () =>
						Effect.succeed([
							Response.makePart("text", { text: "New connection" }),
							finish,
						]),
					streamText: () => Stream.empty,
				})
				yield* holdConnection(physical, {
					identity,
					chat,
					selection,
					model: Effect.succeed(nextModel),
					started: () => Effect.void,
				})
				assert.strictEqual((yield* Fiber.join(later)).text, "New connection")
				assert.strictEqual(yield* Ref.get(calls), 1)
			}).pipe(Effect.timeout("10 seconds")),
	)

	it.effect(
		"a Turn waits for its saved Live model without calling a different connection",
		() =>
			Effect.gen(function* () {
				const owner = yield* ResourceFixture.start()
				const remote = yield* ResourceFixture.start()
				const physical = yield* make(owner)
				const client = yield* make(remote)
				const chat = Chat.Id.make("live-model-change")
				const { fence, authority } = yield* begin(chat)
				const calls = yield* Ref.make(0)
				const wrong = Config.Selection.make({
					...selection,
					model: Model.Id.make("other"),
				})
				const model = yield* LanguageModel.make({
					generateText: () =>
						Ref.update(calls, (n) => n + 1).pipe(Effect.as([finish])),
					streamText: () => Stream.empty,
				})
				const oldScope = yield* Scope.fork(yield* Scope.Scope)
				yield* holdConnection(physical, {
					identity,
					chat,
					selection: wrong,
					model: Effect.succeed(model),
					started: () => Effect.void,
				}).pipe(Scope.provide(oldScope))
				const proxy = yield* client.model(fence, chat, selection)
				const waiting = yield* proxy
					.generateText({ prompt: "Saved input" })
					.pipe(Send.provide(authority), Effect.forkScoped)
				yield* Effect.sleep("100 millis")
				assert.strictEqual(yield* Ref.get(calls), 0)
				yield* Scope.close(oldScope, Exit.void)
				yield* holdConnection(physical, {
					identity,
					chat,
					selection,
					model: Effect.succeed(model),
					started: () => Effect.void,
				})
				yield* Fiber.join(waiting)
				assert.strictEqual(yield* Ref.get(calls), 1)
			}).pipe(Effect.timeout("10 seconds")),
	)

	it.effect(
		"interrupted model registration releases a caller that saw its directory row",
		() =>
			Effect.gen(function* () {
				const owner = yield* ResourceFixture.start()
				const remote = yield* ResourceFixture.start()
				const published = yield* Deferred.make<void>()
				const physical = yield* make({
					...owner,
					transport: {
						...owner.transport,
						register: (ref, handler, options) =>
							owner.transport
								.register(ref, handler, options)
								.pipe(
									Effect.tap(() =>
										ref.kind === "live-model"
											? Deferred.succeed(published, undefined).pipe(
													Effect.andThen(Effect.never),
												)
											: Effect.void,
									),
								),
					},
				})
				const client = yield* make(remote)
				const chat = Chat.Id.make("live-register-interrupted")
				const { fence, authority } = yield* begin(chat)
				const calls = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () =>
						Ref.update(calls, (n) => n + 1).pipe(Effect.as([finish])),
					streamText: () => Stream.empty,
				})
				const registering = yield* Effect.scoped(
					holdConnection(physical, {
						identity,
						chat,
						selection,
						model: Effect.succeed(model),
						started: () => Effect.void,
					}).pipe(Effect.andThen(Effect.never)),
				).pipe(Effect.forkScoped)
				yield* Deferred.await(published)
				const proxy = yield* client.model(fence, chat, selection)
				const request = yield* proxy
					.generateText({ prompt: "Wait for registration" })
					.pipe(Send.provide(authority), Effect.exit, Effect.forkScoped)
				yield* Effect.sleep("100 millis")
				assert.strictEqual(yield* Ref.get(calls), 0)
				yield* Fiber.interrupt(registering)
				assert.isTrue(Exit.isFailure(yield* Fiber.join(request)))
				assert.strictEqual(yield* Ref.get(calls), 0)
			}).pipe(Effect.timeout("10 seconds")),
	)

	it.effect(
		"closing the physical Live connection stops the remote model call without a resend",
		() =>
			Effect.gen(function* () {
				const owner = yield* ResourceFixture.start()
				const remote = yield* ResourceFixture.start()
				const physical = yield* make(owner)
				const client = yield* make(remote)
				const chat = Chat.Id.make("live-closed")
				const { fence, authority } = yield* begin(chat)
				const started = yield* Deferred.make<void>()
				const closed = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () =>
						Effect.gen(function* () {
							yield* Ref.update(calls, (n) => n + 1)
							yield* Deferred.succeed(started, undefined)
							return yield* Effect.never
						}).pipe(Effect.ensuring(Deferred.succeed(closed, undefined))),
					streamText: () => Stream.empty,
				})
				const connectionScope = yield* Scope.fork(yield* Scope.Scope)
				yield* holdConnection(physical, {
					identity,
					chat,
					selection,
					model: Effect.succeed(model),
					started: () => Effect.void,
				}).pipe(Scope.provide(connectionScope))
				const proxy = yield* client.model(fence, chat, selection)
				const request = yield* proxy
					.generateText({ prompt: "Hello" })
					.pipe(Send.provide(authority), Effect.exit, Effect.forkScoped)
				yield* Deferred.await(started)
				yield* Scope.close(connectionScope, Exit.void)
				assert.isTrue(Exit.isFailure(yield* Fiber.join(request)))
				yield* Deferred.await(closed)
				assert.strictEqual(yield* Ref.get(calls), 1)
			}),
	)
})
