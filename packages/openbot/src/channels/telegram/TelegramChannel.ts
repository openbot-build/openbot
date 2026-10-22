// `make` builds a Channel from its secrets and a way to call the platform. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { Effect, Predicate } from "effect"
import { HttpClientRequest } from "effect/http"
import {
	Channel,
	ChannelDeliveryFailed,
	ChannelDenied,
	ChannelEvent,
	type OutboundMessage,
} from "../Channel.ts"
import { type Call, failed } from "../Http.ts"
import { field, id, parse, text } from "../Json.ts"
import { sameSecret, telegramHtml } from "../Text.ts"

export interface Secrets {
	readonly botToken: string
	/** OpenBot makes it and gives it to Telegram. Telegram sends it back with each update. */
	readonly webhookSecret: string
}

const sender = (from: unknown) => {
	const userId = id(from, "id")
	if (userId === undefined) return undefined
	const name = [text(from, "first_name"), text(from, "last_name")]
		.filter((part) => part !== undefined)
		.join(" ")
	return {
		externalId: userId,
		displayName: name.length > 0 ? name : (text(from, "username") ?? userId),
	}
}

const conversation = (chat: unknown) => {
	const chatId = id(chat, "id")
	if (chatId === undefined) return undefined
	const title = text(chat, "title")
	return {
		key: chatId,
		kind:
			text(chat, "type") === "private"
				? ("direct" as const)
				: ("group" as const),
		...(title === undefined ? {} : { title }),
	}
}

const markup = (message: OutboundMessage) =>
	message.buttons === undefined || message.buttons.length === 0
		? {}
		: {
				reply_markup: {
					inline_keyboard: [
						message.buttons.map((button) => ({
							text: button.label,
							callback_data: button.value,
						})),
					],
				},
			}

/**
 * Reads the updates of a Telegram bot. Telegram sends the secret of `setWebhook` in the
 * `X-Telegram-Bot-Api-Secret-Token` header.
 *
 * In a group, a bot with privacy mode on only gets commands and messages that mention it
 * or answer it. So every group message that arrives counts as a mention.
 */
const read = (secrets: Secrets, request: Parameters<Channel["receive"]>[0]) =>
	Effect.gen(function* () {
		const secret = request.headers["x-telegram-bot-api-secret-token"]
		if (secret === undefined || !sameSecret(secret, secrets.webhookSecret))
			return yield* new ChannelDenied({ reason: "wrong secret token" })
		const update = parse(request.body)
		if (update === undefined)
			return yield* new ChannelDenied({ reason: "the body is not JSON" })
		const updateId = id(update, "update_id")
		const callback = field(update, "callback_query")
		if (callback !== undefined) {
			const message = field(callback, "message")
			const chat = conversation(field(message, "chat"))
			const from = sender(field(callback, "from"))
			const data = text(callback, "data")
			const callbackId = text(callback, "id")
			if (chat === undefined || from === undefined || data === undefined)
				return { events: [], reply: {} }
			return {
				events: [
					ChannelEvent.Action({
						eventId: `update:${updateId}`,
						conversation: chat,
						sender: from,
						value: data,
						...(callbackId === undefined ? {} : { receipt: callbackId }),
					}),
				],
				reply: {},
			}
		}
		const message = field(update, "message")
		const chat = conversation(field(message, "chat"))
		const from = sender(field(message, "from"))
		const body = text(message, "text")
		if (
			chat === undefined ||
			from === undefined ||
			body === undefined ||
			field(field(message, "from"), "is_bot") === true
		)
			return { events: [], reply: {} }
		return {
			events: [
				ChannelEvent.Message({
					eventId: `update:${updateId}`,
					conversation: chat,
					sender: from,
					// Commands such as `/ask@my_bot` name the bot. The Agent does not need that part.
					text: body.replace(/^\/\w+(@\w+)?\s*/, "").trim() || body,
					mentioned: true,
				}),
			],
			reply: {},
		}
	})

export const make = (secrets: Secrets, call: Call): Channel => {
	const method = (name: string, body: Record<string, unknown>) =>
		Effect.gen(function* () {
			const reply = yield* call(
				HttpClientRequest.post(
					`https://api.telegram.org/bot${secrets.botToken}/${name}`,
				).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
			)
			if (reply.status === 200 && field(reply.json, "ok") === true)
				return field(reply.json, "result")
			const after = field(field(reply.json, "parameters"), "retry_after")
			if (reply.status === 429 && Predicate.isNumber(after))
				return yield* new ChannelDeliveryFailed({
					message: `Telegram asked to wait before ${name}`,
					retry: true,
					retryAfterMs: after * 1000,
				})
			return yield* failed(
				reply,
				`Telegram refused ${name}: ${text(reply.json, "description") ?? reply.status}`,
			)
		})
	return new Channel({
		kind: "telegram",
		features: { edit: true, maxLength: 4096, private: false },
		receive: (request) => read(secrets, request),
		send: (target, message) => {
			// The direct chat of a person has the same ID as the person. Telegram has no
			// private messages in a group, so `Private` goes to the direct chat too.
			const chat =
				target._tag === "Conversation" ? target.conversation : target.person
			return method("sendMessage", {
				chat_id: chat,
				text: telegramHtml(message.markdown),
				parse_mode: "HTML",
				...markup(message),
			}).pipe(
				Effect.map((result) => ({
					conversation: chat,
					id: id(result, "message_id") ?? "",
				})),
			)
		},
		edit: (ref, message) =>
			method("editMessageText", {
				chat_id: ref.conversation,
				message_id: Number(ref.id),
				text: telegramHtml(message.markdown),
				parse_mode: "HTML",
				...markup(message),
			}).pipe(Effect.asVoid),
		acknowledge: (action) =>
			action.receipt === undefined
				? Effect.void
				: method("answerCallbackQuery", {
						callback_query_id: action.receipt,
					}).pipe(Effect.asVoid),
		register: (webhookUrl) =>
			method("setWebhook", {
				url: webhookUrl,
				secret_token: secrets.webhookSecret,
				allowed_updates: ["message", "callback_query"],
			}).pipe(Effect.asVoid),
	})
}
