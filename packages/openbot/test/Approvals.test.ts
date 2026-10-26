import { assert, describe, it } from "@effect/vitest"
import { BotsApi } from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import { Effect, HashMap, Layer, Option, Ref } from "effect"
import { Prompt } from "effect/ai"
import * as Approvals from "../src/capabilities/Approvals.ts"
import { Answer, Gate } from "../src/capabilities/Gate.ts"
import { Requests, type Stored } from "../src/capabilities/Requests.ts"
import { Work } from "../src/capabilities/Work.ts"
import { bot } from "./BotFixture.ts"

const chat = Chat.Id.make("chat_1")
const turn = Turn.Id.make("turn_1")
const chain = {
	organizationId: "org_1",
	userId: "user_1",
	bots: [bot.id],
	chats: [],
}

/** A request for a tool call that runs again when a decider allows it. */
const waiting = {
	request: {
		id: "request_1",
		capability: { action: "tools.call", target: "search" },
	},
	chain,
} as unknown as Stored

const down = Effect.fail(BotsApi.BotStorageUnavailable.make({}))

/** Asks Approvals about one call. The Gate makes a request that waits for a decider. */
const decide = (requests: Partial<Requests["Service"]>) =>
	Effect.gen(function* () {
		const checks = yield* Ref.make(HashMap.empty<string, Answer>())
		const approvals = yield* Chat.Approvals
		return yield* approvals
			.decide({
				chat,
				turn,
				approvalId: "approval_1",
				toolCall: Prompt.toolCallPart({
					id: "call_1",
					name: "search",
					params: { query: "tea" },
					providerExecuted: false,
				}),
			})
			.pipe(
				Effect.provideService(
					Work,
					Work.of({
						caller: {
							kind: "member",
							organizationId: "org_1",
							userId: "user_1",
						},
						namespace: "org_1:user_1",
						bot,
						chain,
						deciders: [bot.id],
						chat,
						turn,
						checks,
					}),
				),
			)
	}).pipe(
		Effect.provide(
			Approvals.layer.pipe(
				Layer.provide([
					Layer.succeed(Gate, {
						...({} as Gate["Service"]),
						check: () =>
							Effect.succeed(Answer.Pending({ request: "request_1" })),
					}),
					Layer.succeed(Requests, {
						...({} as Requests["Service"]),
						...requests,
					}),
				]),
			),
		),
	)

const pending = Chat.Decision.Pending({
	result: Approvals.pendingResult("request_1"),
})

describe("Approvals", () => {
	it.effect("keeps the call that waits for a request", () =>
		Effect.gen(function* () {
			const kept = yield* Ref.make<ReadonlyArray<string>>([])
			const decision = yield* decide({
				find: () => Effect.succeed(Option.some(waiting)),
				setCall: (_organizationId, _id, call) =>
					Ref.update(kept, (names) => [...names, call.name]),
			})
			assert.deepStrictEqual(decision, pending)
			assert.deepStrictEqual(yield* Ref.get(kept), ["search"])
		}),
	)

	it.effect(
		"says the call waits when the request cannot be read after the Gate made it",
		() =>
			Effect.gen(function* () {
				const decision = yield* decide({ find: () => down })
				assert.deepStrictEqual(decision, pending)
			}),
	)

	it.effect(
		"says the call waits when the call cannot be kept with its request",
		() =>
			Effect.gen(function* () {
				const decision = yield* decide({
					find: () => Effect.succeed(Option.some(waiting)),
					setCall: () => down,
				})
				assert.deepStrictEqual(decision, pending)
			}),
	)
})
