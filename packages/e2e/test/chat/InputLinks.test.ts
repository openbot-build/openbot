import { assert, layer } from "@effect/vitest"
import {
	ChatCommandReceipt,
	ChatItem,
	ChatSummary,
	ChatView,
	ExecutionsApi,
	UserTokensApi,
} from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import {
	BrowserHost,
	Caller,
	Messages,
	Wait,
} from "@openbot-build/openbot/testing"
import { Array as Arr, Deferred, Effect, Option, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"

const origin = "https://input-links.example.com"
const ItemPage = Schema.Struct({ items: Schema.Array(ChatItem) })
const answer = Stream.make(
	Response.makePart("text-start", { id: "answer" }),
	Response.makePart("text-delta", { id: "answer", delta: "Done." }),
	Response.makePart("text-end", { id: "answer" }),
	Response.makePart("finish", {
		reason: "stop",
		usage: {
			inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 1, text: 1, reasoning: 0 },
		},
	}),
)
const start = Effect.fn(function* (name: string) {
	const gate = yield* Deferred.make<void>()
	const started = yield* Deferred.make<void>()
	const model = yield* LanguageModel.make({
		generateText: () => Effect.succeed([]),
		streamText: () =>
			Stream.unwrap(
				Deferred.succeed(started, undefined).pipe(
					Effect.andThen(Deferred.await(gate)),
					Effect.as(answer),
				),
			),
	})
	const host = yield* BrowserHost.start({ publicOrigin: origin, model })
	const account = yield* host.login(name)
	const cookie: Messages.Send = (path, method, body) =>
		Effect.flatMap(host.address, (address) =>
			Caller.withCookie({ address, publicOrigin: origin })(
				account.session,
				path,
				method,
				body,
			),
		)
	const bot = yield* Messages.bot(cookie)
	return { host, cookie, bot, gate, started }
})
const read = <S extends Schema.Constraint>(
	schema: S,
	call: Caller.Call,
	status = 200,
) => Effect.flatMap(call, Caller.json(schema, status))
const accepted = (send: Messages.Send, receipt: ChatCommandReceipt) =>
	Effect.gen(function* () {
		assert.ok(receipt.inputId !== undefined)
		const page = yield* read(
			ExecutionsApi.EventPage,
			send(
				`/v1/executions/${receipt.executionId}/events?afterSequence=${receipt.sequence - 1}`,
				"GET",
			),
		)
		const event = Arr.findFirst(
			page.events,
			(event) => event.sequence === receipt.sequence,
		)
		assert.ok(Option.isSome(event))
		assert.deepStrictEqual(event.value.body, {
			_tag: "Checkpoint",
			resource: { kind: "Chat", id: receipt.chat },
			revision:
				event.value.body._tag === "Checkpoint" ? event.value.body.revision : -1,
			inputId: receipt.inputId,
		})
	})

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a lost first Bot reply keeps its input ID after a restart",
		() =>
			Effect.gen(function* () {
				const test = yield* start("lost-input-reply")
				const payload = { commandKey: "first-input", input: "Keep this input." }
				// Do not keep the first reply. The page only has the saved command.
				assert.strictEqual(
					(yield* test.cookie(`/v1/bots/${test.bot}/messages`, "POST", payload))
						.status,
					202,
				)
				yield* Deferred.await(test.started)
				yield* Deferred.succeed(test.gate, undefined)
				const chats = yield* read(
					Schema.Array(ChatSummary),
					test.cookie(`/v1/chats?bot=${test.bot}`, "GET"),
				)
				assert.strictEqual(chats.length, 1)
				yield* Messages.settled(test.cookie, chats[0]!.chat.id)
				yield* test.host.restart
				const repeat = read(
					ChatCommandReceipt,
					test.cookie(`/v1/bots/${test.bot}/messages`, "POST", payload),
					202,
				)
				const receipt = yield* repeat
				yield* accepted(test.cookie, receipt)
				assert.deepStrictEqual(yield* repeat, receipt)
				const page = yield* read(
					ItemPage,
					test.cookie(`/v1/chats/${receipt.chat}/items`, "GET"),
				)
				assert.strictEqual(
					Arr.countBy(page.items, (item) =>
						Schema.toEquivalence(Prompt.Prompt)(
							item.content,
							Prompt.make(payload.input),
						),
					),
					1,
				)
				assert.strictEqual(
					Arr.countBy(page.items, (item) => item.id === receipt.inputId),
					1,
				)
				assert.deepStrictEqual(
					(yield* Messages.view(test.cookie, receipt.chat)).queuedInputs,
					[],
				)
				yield* Deferred.succeed(test.gate, undefined)
				yield* Messages.settled(test.cookie, receipt.chat)
				assert.deepStrictEqual(yield* repeat, receipt)
			}),
		30_000,
	)

	it.effect(
		"queued inputs with the same text keep separate IDs in history with an API key",
		() =>
			Effect.gen(function* () {
				const test = yield* start("queued-input-ids")
				const token = yield* read(
					UserTokensApi.CreatedToken,
					test.cookie("/v1/user/tokens", "POST", { name: "Input work" }),
					201,
				)
				const send: Messages.Send = (path, method, body) =>
					Effect.flatMap(test.host.address, (address) =>
						Caller.withToken(address)(token.secret, path, method, body),
					)
				const first = yield* read(
					ChatCommandReceipt,
					send(`/v1/bots/${test.bot}/messages`, "POST", {
						commandKey: "start",
						input: "Same words.",
					}),
					202,
				)
				yield* Deferred.await(test.started)
				const path = `/v1/chats/${first.chat}`
				const queued = yield* Effect.forEach(
					["queue-one", "queue-two"],
					(commandKey) =>
						read(
							ChatCommandReceipt,
							send(path + "/messages", "POST", {
								commandKey,
								input: "Same words.",
								queue: true,
							}),
							202,
						),
				)
				for (const receipt of [first, ...queued]) yield* accepted(send, receipt)
				assert.notStrictEqual(queued[0]!.inputId, queued[1]!.inputId)
				assert.notStrictEqual(first.inputId, queued[0]!.inputId)
				const waiting = yield* read(ChatView, send(path, "GET"))
				assert.deepStrictEqual(
					Arr.map(waiting.queuedInputs ?? [], (input) => input.id),
					Arr.map(queued, (receipt) => receipt.inputId),
				)
				assert.ok(
					Arr.every(waiting.queuedInputs ?? [], (input) =>
						Schema.toEquivalence(Prompt.Prompt)(
							input.content,
							Prompt.make("Same words."),
						),
					),
				)
				const repeated = yield* read(
					ChatCommandReceipt,
					send(path + "/messages", "POST", {
						commandKey: "queue-one",
						input: "Same words.",
						queue: true,
					}),
					202,
				)
				assert.deepStrictEqual(repeated, queued[0])
				assert.strictEqual(
					(yield* send(path + "/messages", "POST", {
						commandKey: "queue-one",
						input: "Changed words.",
						queue: true,
					})).status,
					409,
				)
				yield* Deferred.succeed(test.gate, undefined)
				const complete = yield* Messages.settled(send, first.chat)
				assert.deepStrictEqual(complete.queuedInputs, [])
				const history = yield* read(ItemPage, send(path + "/items", "GET"))
				assert.strictEqual(
					Arr.countBy(history.items, (item) =>
						Schema.toEquivalence(Prompt.Prompt)(
							item.content,
							Prompt.make("Same words."),
						),
					),
					3,
				)
				for (const receipt of [first, ...queued])
					assert.strictEqual(
						Arr.countBy(history.items, (item) => item.id === receipt.inputId),
						1,
					)
			}),
		30_000,
	)

	it.effect(
		"a cancelled queued input keeps its receipt without making a history Item",
		() =>
			Effect.gen(function* () {
				const test = yield* start("cancelled-input-id")
				const first = yield* Messages.message(
					test.cookie,
					test.bot,
					"Wait for more input.",
				)
				yield* Deferred.await(test.started)
				const path = `/v1/chats/${first.chat}`
				const payload = {
					commandKey: "cancelled-input",
					input: "Do this later.",
					queue: true,
				}
				const repeat = read(
					ChatCommandReceipt,
					test.cookie(path + "/messages", "POST", payload),
					202,
				)
				const receipt = yield* repeat
				yield* accepted(test.cookie, receipt)
				assert.ok(
					Arr.some(
						(yield* Messages.view(test.cookie, first.chat)).queuedInputs ?? [],
						(input) => input.id === receipt.inputId,
					),
				)
				yield* read(
					Execution.Receipt,
					test.cookie(`/v1/executions/${receipt.executionId}/cancel`, "POST", {
						commandKey: "cancel-waiting-input",
					}),
				)
				yield* Wait.untilTrue(
					"the queued input is cancelled",
					read(
						Execution.Record,
						test.cookie(`/v1/executions/${receipt.executionId}`, "GET"),
					),
					(record) => record.status === "cancelled",
				)
				assert.deepStrictEqual(
					(yield* Messages.view(test.cookie, first.chat)).queuedInputs,
					[],
				)
				assert.ok(
					Arr.every(
						(yield* read(ItemPage, test.cookie(path + "/items", "GET"))).items,
						(item) => item.id !== receipt.inputId,
					),
				)
				assert.deepStrictEqual(yield* repeat, receipt)
				assert.deepStrictEqual(
					(yield* Messages.view(test.cookie, first.chat)).queuedInputs,
					[],
				)
				yield* Deferred.succeed(test.gate, undefined)
				yield* Messages.settled(test.cookie, first.chat)
			}),
		30_000,
	)
})
