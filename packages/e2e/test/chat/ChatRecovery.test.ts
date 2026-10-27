import * as Read from "./Read.ts"
import { PgClient } from "@effect/sql-pg"
import { BrowserHost, Caller, Messages } from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import { ChatCommandReceipt, ExecutionsApi } from "@openbot-build/api"
import { Deferred, Effect, Ref, Schema, Stream, Array as Arr } from "effect"
import { LanguageModel, Response } from "effect/ai"

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a damaged saved Chat does not stop another Chat from recovering and accepting input",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const sends = yield* Ref.make(0)
				const recovered = yield* Ref.make(false)
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("This test uses streams."),
					streamText: () =>
						Stream.unwrap(
							Effect.gen(function* () {
								const count = yield* Ref.updateAndGet(
									sends,
									(value) => value + 1,
								)
								if (count === 2) yield* Deferred.succeed(started, undefined)
								if (!(yield* Ref.get(recovered))) return Stream.never
								return Stream.make(
									Response.makePart("text-start", { id: "answer" }),
									Response.makePart("text-delta", {
										id: "answer",
										delta: "The valid Chat recovered.",
									}),
									Response.makePart("text-end", { id: "answer" }),
									Response.makePart("finish", { reason: "stop", usage }),
								)
							}),
						),
				})
				const publicOrigin = "https://damaged-chat.example.com"
				const host = yield* BrowserHost.start({ publicOrigin, model })
				const member = yield* host.login("damaged-chat")
				const brokenBot = yield* host.defaultBot(member.session)
				const send: Messages.Send = (path, method, body) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							member.session,
							path,
							method,
							body,
						),
					)
				const validBot = yield* Messages.bot(send)
				const broken = yield* Messages.message(
					send,
					brokenBot,
					"Wait in the first Chat",
				)
				const valid = yield* Messages.message(
					send,
					validBot,
					"Wait in the second Chat",
				)
				yield* Deferred.await(started).pipe(Effect.timeout("20 seconds"))
				const damaged = "private damaged Chat text"
				yield* host.run(
					Effect.flatMap(
						PgClient.PgClient,
						(sql) =>
							sql`update openbot_chats set body = ${damaged} where id = ${broken.chat}`,
					),
				)
				yield* Ref.set(recovered, true)
				yield* host.restart
				yield* Read.observe(send, valid.executionId).pipe(
					Effect.timeout("20 seconds"),
				)
				const view = yield* Messages.view(send, valid.chat)
				assert.equal(view.status, "Completed")
				assert.equal(view.response?.id, valid.turn)
				assert.equal(yield* Ref.get(sends), 3)
				const failed = yield* send(`/v1/chats/${broken.chat}`, "GET")
				assert.equal(failed.status, 503)
				assert.notInclude(yield* failed.text, damaged)
				const next = yield* Messages.talk(
					send,
					validBot,
					"The next input can run",
				)
				assert.equal(next.view.status, "Completed")
				assert.equal(next.receipt.chat, valid.chat)
				assert.notEqual(next.receipt.turn, valid.turn)
				assert.equal(yield* Ref.get(sends), 4)
				assert.deepEqual(
					yield* host.run(
						Effect.flatMap(
							PgClient.PgClient,
							(sql) =>
								sql`select body from openbot_chats where id = ${broken.chat}`,
						),
					),
					[{ body: damaged }],
				)
			}),
		90000,
	)
	it.effect(
		"restart keeps the Turn ID, starts a new model attempt and then runs queued input",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const attempts = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("This test uses streams."),
					streamText: () =>
						Stream.unwrap(
							Effect.gen(function* () {
								const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
								if (attempt === 1) {
									yield* Deferred.succeed(started, undefined)
									return Stream.concat(
										Stream.make(
											Response.makePart("text-start", { id: "answer" }),
											Response.makePart("text-delta", {
												id: "answer",
												delta: "Unfinished text",
											}),
										),
										Stream.never,
									)
								}
								return Stream.make(
									Response.makePart("text-start", { id: "answer" }),
									Response.makePart("text-delta", {
										id: "answer",
										delta: "Recovered.",
									}),
									Response.makePart("text-end", { id: "answer" }),
									Response.makePart("finish", { reason: "stop", usage }),
								)
							}),
						),
				})
				const publicOrigin = "https://chat-recovery.example.com"
				const host = yield* BrowserHost.start({ publicOrigin, model })
				const member = yield* host.login("chat-recovery")
				const bot = yield* host.defaultBot(member.session)
				const send: Messages.Send = (path, method, body) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							member.session,
							path,
							method,
							body,
						),
					)
				const first = yield* Messages.message(send, bot, "hello")
				yield* Deferred.await(started)
				const second = yield* Caller.read(
					ChatCommandReceipt,
					send(`/v1/chats/${first.chat}/messages`, "POST", {
						input: "me too",
						queue: true,
						commandKey: "queued",
					}),
					202,
				)
				assert.notStrictEqual(first.executionId, second.executionId)
				yield* host.restart
				yield* Read.observe(send, second.executionId).pipe(
					Effect.timeout("20 seconds"),
				)
				const view = yield* Messages.view(send, first.chat)
				assert.strictEqual(view.status, "Completed")
				assert.strictEqual(view.turn?.id, second.turn)
				const turns = yield* Read.turns(send, first.chat)
				assert.deepStrictEqual(
					Arr.map(turns.items, (turn) => [turn.id, turn.status._tag]),
					[
						[first.turn, "Completed"],
						[second.turn, "Completed"],
					],
				)
				const saved = yield* Read.turn(send, first.chat, first.turn)
				const encoded = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(saved)
				assert.match(encoded, /Recovered/)
				assert.notMatch(encoded, /Unfinished text/)
				const events = yield* Caller.read(
					ExecutionsApi.EventPage,
					send(
						`/v1/executions/${first.executionId}/events?afterSequence=0`,
						"GET",
					),
				)
				const steps = Arr.filter(
					events.events,
					(event) => event.body._tag === "StepStarted",
				)
				assert.ok(
					Arr.some(
						steps,
						(event) =>
							event.body._tag === "StepStarted" && event.body.attempt === 0,
					),
				)
				assert.ok(
					Arr.some(
						steps,
						(event) =>
							event.body._tag === "StepStarted" && event.body.attempt === 1,
					),
				)
				assert.strictEqual(yield* Ref.get(attempts), 3)
			}),
		90000,
	)
})
