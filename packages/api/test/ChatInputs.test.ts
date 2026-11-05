import { assert, it } from "@effect/vitest"
import { Chat } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Effect, Schema } from "effect"
import { Prompt } from "effect/ai"
import { ChatCommandReceipt, ChatView } from "../src/ChatsApi.ts"

const receipt = {
	executionId: "execution_one",
	commandKey: "message_one",
	sequence: 2,
	chat: "chat_one",
	turn: "turn_one",
} satisfies typeof ChatCommandReceipt.Encoded
const view = {
	chat: {
		id: "chat_one",
		revision: 1,
		kind: "direct",
		bot: "bot_one",
		parent: null,
		settings: { mode: "build" },
		createdAt: 0,
	},
	status: "Idle",
	turn: null,
	response: null,
	executionId: null,
	inbox: 0,
	open: { delegations: 0, requests: 0, reminders: 0 },
} satisfies typeof ChatView.Encoded

it.effect("old Chat replies stay readable without input links", () =>
	Effect.gen(function* () {
		const oldReceipt = yield* Schema.decodeEffect(ChatCommandReceipt)(receipt)
		assert.deepStrictEqual(
			yield* Schema.encodeEffect(ChatCommandReceipt)(oldReceipt),
			receipt,
		)
		const oldView = yield* Schema.decodeEffect(ChatView)(view)
		assert.deepStrictEqual(yield* Schema.encodeEffect(ChatView)(oldView), view)
	}),
)

it.effect(
	"input links keep repeated text distinct and leave out private fields",
	() =>
		Effect.gen(function* () {
			const content = yield* Schema.encodeEffect(
				Chat.InboxEntry.fields.content,
			)(Prompt.make("Read the plan."))
			const pending = {
				...view,
				inbox: 2,
				queuedInputs: [
					{
						id: "input_one",
						kind: "message" as const,
						turn: "turn_one",
						content,
						author: "private_author",
						approved: { id: "call_one", name: "write", params: {} },
					},
					{
						id: "input_two",
						kind: "steer" as const,
						turn: "turn_one",
						content,
					},
				],
			}
			const decoded = yield* Schema.decodeEffect(ChatView)(pending)
			const encoded = yield* Schema.encodeEffect(ChatView)(decoded)
			assert.strictEqual(encoded.queuedInputs?.length, 2)
			assert.deepStrictEqual(encoded.queuedInputs?.[0], {
				id: "input_one",
				kind: "message",
				turn: "turn_one",
				content,
			})
			assert.strictEqual(encoded.queuedInputs?.[1]?.id, "input_two")
			const linked = yield* Schema.decodeEffect(ChatCommandReceipt)({
				...receipt,
				inputId: "input_one",
			})
			assert.strictEqual(linked.inputId, encoded.queuedInputs?.[0]?.id)
		}),
)

it.effect("old and linked Checkpoints keep their wire fields", () =>
	Effect.gen(function* () {
		const old = {
			_tag: "Checkpoint",
			resource: { kind: "Chat", id: "chat_one" },
			revision: 1,
		} satisfies typeof Execution.EventBody.Encoded
		for (const wire of [old, { ...old, inputId: "input_one" }]) {
			const decoded = yield* Schema.decodeEffect(Execution.EventBody)(wire)
			assert.deepStrictEqual(
				yield* Schema.encodeEffect(Execution.EventBody)(decoded),
				wire,
			)
		}
	}),
)
