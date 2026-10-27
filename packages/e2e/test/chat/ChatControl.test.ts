import { BrowserHost, Caller, Wait } from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import { ChatCommandReceipt } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import { Deferred, Effect, Option, Stream } from "effect"
import { LanguageModel } from "effect/ai"

const publicOrigin = "https://chat-control.example.com"
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a Chat delete waits for resource release and keeps its receipt through restart",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const closing = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("This test uses a stream"),
					streamText: () =>
						Stream.unwrap(
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() =>
									Deferred.succeed(closing, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
									),
								)
								yield* Deferred.succeed(started, undefined)
								return Stream.never
							}),
						),
				})
				const host = yield* BrowserHost.start({ publicOrigin, model })
				const alice = yield* host.login("chat-control")
				const bot = yield* host.defaultBot(alice.session)
				const send = (
					path: string,
					method: "GET" | "POST" | "DELETE" = "GET",
					body?: unknown,
				) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							alice.session,
							path,
							method,
							body,
						),
					)
				yield* Effect.gen(function* () {
					const input = yield* Caller.read(
						ChatCommandReceipt,
						send("/v1/bots/" + bot + "/messages", "POST", {
							commandKey: "start",
							input: "Hello",
						}),
						202,
					)
					yield* Deferred.await(started)
					const path = "/v1/chats/" + input.chat
					const remove = Caller.read(
						Execution.Receipt,
						send(path, "DELETE", { commandKey: "delete" }),
						202,
					)
					const [first, same] = yield* Effect.all([remove, remove], {
						concurrency: 2,
					})
					assert.deepEqual(first, same)
					yield* Deferred.await(closing)
					assert.strictEqual((yield* send(path)).status, 200)
					const pending = yield* Caller.read(
						Execution.Record,
						send("/v1/executions/" + first.executionId),
					)
					assert.isFalse(Execution.isTerminal(pending.status))
					assert.strictEqual(
						(yield* send(path + "/messages", "POST", {
							commandKey: "too-late",
							input: "Wait",
						})).status,
						403,
					)
					yield* Deferred.succeed(release, undefined)
					yield* Wait.until(
						"the Chat deletion",
						Caller.read(
							Execution.Record,
							send("/v1/executions/" + first.executionId),
						).pipe(
							Effect.map((record) =>
								record.status === "completed"
									? Option.some(record)
									: Option.none(),
							),
						),
					)
					assert.strictEqual((yield* send(path)).status, 404)
					assert.deepEqual(yield* remove, first)
					yield* host.restart
					assert.deepEqual(yield* remove, first)
					assert.strictEqual((yield* send(path)).status, 404)
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
			}),
		90000,
	)
})
