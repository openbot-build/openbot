import { assert, layer } from "@effect/vitest"

import { Chat, Turn } from "@openbot-build/core"

import { RequestsApi } from "@openbot-build/api"
import { Array as Arr, Effect, HashMap, Option, Ref, Schema } from "effect"

import { bot, message, model, settled } from "../support/Development.ts"

import {
	Caller,
	PostgresTest,
	DevelopmentTesting,
} from "@openbot-build/openbot/testing"
import {
	signIn,
	settings,
	platform,
	ItemPage,
	toJson,
	migrate,
	launch,
	poll,
} from "../support/Development.ts"

// These journeys use real servers and the real clock.
layer(platform, { excludeTestServices: true })((it) => {
	it.effect(
		"server assembly keeps extra per-Chat handlers and approvals",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const options = settings(database.url)
				const calls = yield* Ref.make(HashMap.empty<Chat.Id, number>())
				const assembly = DevelopmentTesting.layerWithConfirmation(
					options,
					calls,
				)
				yield* migrate(options)
				const { address } = yield* launch(assembly)
				const { send } = yield* signIn(address, options.auth.publicOrigin)
				// Two Bots with the tool model, so each one has its own Chat.
				const talk = (name: string) =>
					Effect.flatMap(bot(send, { name, model: model("mock-tool") }), (id) =>
						message(send, id, "Confirm independently"),
					)
				const [first, second] = yield* Effect.all(
					[talk("First"), talk("Second")],
					{ concurrency: "unbounded" },
				)
				assert.ok(first !== undefined && second !== undefined)
				assert.notStrictEqual(first.chat, second.chat)
				const pendingOf = (chat: string) =>
					poll(
						Effect.map(
							Effect.flatMap(
								send("/v1/requests?status=pending", "GET"),
								Caller.json(Schema.Array(RequestsApi.CapabilityRequest)),
							),
							(pending) => Arr.filter(pending, (entry) => entry.chat === chat),
						),
						Arr.isReadonlyArrayNonEmpty,
					)
				const [firstRequests, secondRequests] = yield* Effect.all(
					[pendingOf(first.chat), pendingOf(second.chat)],
					{ concurrency: "unbounded" },
				)
				assert.strictEqual(firstRequests.length, 1)
				assert.strictEqual(secondRequests.length, 1)
				for (const entry of [...firstRequests, ...secondRequests])
					assert.deepStrictEqual(
						[entry.capability.action, entry.capability.target],
						["tools.call", "DevelopmentConfirmation"],
					)
				const [firstRequest] = firstRequests
				const [secondRequest] = secondRequests
				assert.ok(firstRequest !== undefined && secondRequest !== undefined)
				// The Turns do not wait for the decisions, and no call runs before one.
				const turnStatus = (receipt: typeof first) =>
					Effect.map(
						Effect.flatMap(
							send(`/v1/chats/${receipt.chat}/turns/${receipt.turn}`, "GET"),
							Caller.json(Schema.Struct({ turn: Turn.Record })),
						),
						(view) => view.turn.status._tag,
					)
				yield* Effect.all(
					[settled(send, first.chat), settled(send, second.chat)],
					{ concurrency: "unbounded" },
				)
				const firstTurns = yield* Effect.all([
					turnStatus(first),
					turnStatus(second),
				])
				assert.strictEqual(HashMap.size(yield* Ref.get(calls)), 0)
				const decide = Effect.fn("DevelopmentAssembly.decide")(function* (
					entry: RequestsApi.CapabilityRequest,
					decision: "allow" | "deny",
				) {
					const response = yield* send("/v1/requests/" + entry.id, "POST", {
						commandKey: `answer-14661:${entry.id}`,
						expected: entry.revision,
						decision,
						...(decision === "deny" ? { reason: "rejected" } : {}),
					})
					assert.strictEqual(response.status, 202)
				})
				yield* decide(firstRequest, "allow")
				yield* decide(secondRequest, "deny")
				const itemsOf = (chat: string) =>
					Effect.map(
						Effect.flatMap(
							send(`/v1/chats/${chat}/items?limit=100`, "GET"),
							Caller.json(ItemPage),
						),
						(page) => page.items,
					)
				const noticeOf = (chat: string, ref: string) =>
					poll(
						Effect.map(itemsOf(chat), (items) =>
							Arr.findFirst(
								items,
								(item) =>
									item.origin?.notice?.kind === "request" &&
									item.origin.notice.ref === ref,
							),
						),
						Option.isSome,
					)
				// The allowed call runs once, with the handlers of its own Chat.
				assert.ok(Option.isSome(yield* noticeOf(first.chat, firstRequest.id)))
				yield* poll(Ref.get(calls), HashMap.has(Chat.Id.make(first.chat)))
				const approved = yield* settled(send, first.chat)
				assert.strictEqual(
					Option.getOrElse(
						HashMap.get(yield* Ref.get(calls), Chat.Id.make(first.chat)),
						() => 0,
					),
					1,
				)
				assert.match(
					yield* toJson(yield* itemsOf(first.chat)),
					new RegExp(first.chat + ": Confirm independently"),
				)
				// The denial comes back as a notice, and the call never runs.
				const denial = yield* noticeOf(second.chat, secondRequest.id)
				assert.ok(Option.isSome(denial))
				assert.match(yield* toJson(denial.value.content), /rejected/)
				yield* settled(send, second.chat)
				const finalCalls = yield* Ref.get(calls)
				assert.strictEqual(
					HashMap.has(finalCalls, Chat.Id.make(second.chat)),
					false,
				)
				assert.strictEqual(HashMap.size(finalCalls), 1)
				// A pending result lets the first Turns end well. After the allowed call,
				// the model answers with its result and asks for nothing more.
				assert.deepStrictEqual(firstTurns, ["Completed", "Completed"])
				assert.match(
					yield* toJson(approved.response),
					new RegExp(
						"Development confirmation result: " +
							first.chat +
							": Confirm independently",
					),
				)
				assert.strictEqual(approved.open.requests, 0)
			}),
		{ timeout: 60000 },
	)
})
