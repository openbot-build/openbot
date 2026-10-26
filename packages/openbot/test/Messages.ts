import { ChatView, MessageReceipt } from "@openbot-build/api"
import { Effect, Schema } from "effect"
import * as Caller from "./Caller.ts"

/** Sends one request with the credential of a person. */
export type Send = (
	path: string,
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
	payload?: unknown,
) => Caller.Call

/** A Chat did not come to rest in time. */
export class ChatNotSettled extends Schema.TaggedError<
	ChatNotSettled,
	{ readonly brand: unique symbol }
>()("ChatNotSettled", { chat: Schema.String }) {
	override get message() {
		return `The Chat ${this.chat} did not come to rest in time`
	}
}

const Created = Schema.Struct({ id: Schema.String })

/** A simulated model of the development platform. */
export const model = (name: string) => ({
	_tag: "Config.Selection",
	provider: "development",
	model: name,
})

/** Makes a Bot of the caller and answers its ID. */
export const bot = Effect.fn("Messages.bot")(function* (
	send: Send,
	input: {
		readonly name?: string
		readonly model?: ReturnType<typeof model>
		readonly instructions?: string
	} = {},
) {
	const created = yield* Effect.flatMap(
		send("/v1/bots", "POST", {
			name: input.name ?? "Helper",
			role: "Helps in tests",
			instructions: input.instructions ?? "Help the person.",
			...(input.model === undefined ? {} : { model: input.model }),
		}),
		Caller.json(Created),
	)
	return created.id
})

/** Sends a message to the direct Chat of the caller with a Bot. */
export const message = (send: Send, bot: string, input: string) =>
	Effect.flatMap(
		send(`/v1/bots/${bot}/messages`, "POST", { input }),
		Caller.json(MessageReceipt, 202),
	)

/** Sends a message to a Chat. */
export const send = (request: Send, chat: string, input: string) =>
	Effect.flatMap(
		request(`/v1/chats/${chat}/messages`, "POST", { input }),
		Caller.json(MessageReceipt, 202),
	)

/** Reads the view of a Chat. */
export const view = (send: Send, chat: string) =>
	Effect.flatMap(send(`/v1/chats/${chat}`, "GET"), Caller.json(ChatView))

/** Waits for a change of a Chat after the given view, at most half a second. */
const next = (send: Send, chat: string, current: ChatView) =>
	Effect.flatMap(
		send(
			`/v1/chats/${chat}/wait?` +
				new URLSearchParams({
					after: String(current.chat.revision),
					afterActivity: current.activity,
					timeoutMs: "500",
				}),
			"GET",
		),
		Caller.json(ChatView),
	)

/** Waits from a view until the Chat rests. */
const rest = (
	send: Send,
	chat: string,
	current: ChatView,
): Effect.Effect<
	ChatView,
	Effect.Error<ReturnType<typeof next>>,
	Effect.Services<ReturnType<typeof next>>
> =>
	current.activity !== "active" &&
	current.status !== "Running" &&
	current.inbox === 0
		? Effect.succeed(current)
		: Effect.flatMap(next(send, chat, current), (view) =>
				rest(send, chat, view),
			)

/**
 * Waits until no Turn runs in a Chat and no input waits in its inbox.
 * It fails with `ChatNotSettled` after twenty seconds. That is less than the
 * time limit of a test, so a test shows this error first. The wait needs the
 * live clock.
 */
export const settled = (send: Send, chat: string) =>
	Effect.flatMap(view(send, chat), (current) => rest(send, chat, current)).pipe(
		Effect.timeoutOrElse({
			duration: "20 seconds",
			orElse: () => Effect.fail(ChatNotSettled.make({ chat })),
		}),
	)

/** Sends a message to a Bot and waits until its Chat comes to rest. */
export const talk = Effect.fn("Messages.talk")(function* (
	send: Send,
	bot: string,
	input: string,
) {
	const receipt = yield* message(send, bot, input)
	return { receipt, view: yield* settled(send, receipt.chat) }
})
