import { createDecipheriv, createHash } from "node:crypto"
import type { ChannelsApi } from "@openbot-build/api"
import { Clock, Effect, Predicate, Ref } from "effect"
import { HttpClientRequest } from "effect/http"
import {
	Channel,
	ChannelDeliveryFailed,
	ChannelDenied,
	ChannelEvent,
	type OutboundMessage,
} from "../Channel.ts"
import { type Call, failed } from "../Http.ts"
import { field, parse, text } from "../Json.ts"
import { recentSeconds, sameSecret } from "../Text.ts"

export interface Secrets {
	readonly domain: ChannelsApi.LarkDomain
	readonly appId: string
	readonly appSecret: string
	readonly verificationToken: string
	readonly encryptKey: string
}

const origins: Record<ChannelsApi.LarkDomain, string> = {
	feishu: "https://open.feishu.cn",
	lark: "https://open.larksuite.com",
}

/**
 * Lark encrypts each event with AES-256-CBC. The key is the SHA-256 of the encrypt key,
 * and the first 16 bytes of the data are the IV.
 */
const decrypt = (encryptKey: string, data: string) => {
	try {
		const bytes = Buffer.from(data, "base64")
		const key = createHash("sha256").update(encryptKey).digest()
		const decipher = createDecipheriv("aes-256-cbc", key, bytes.subarray(0, 16))
		return Buffer.concat([
			decipher.update(bytes.subarray(16)),
			decipher.final(),
		]).toString("utf8")
	} catch {
		return undefined
	}
}

/** Lark puts `@_user_1` in the text for each mention. The Bot does not need them. */

/** Every message is a card, because Lark can only change a card after it sends it. */
const card = (message: OutboundMessage) => ({
	config: { wide_screen_mode: true, update_multi: true },
	elements: [
		{ tag: "markdown", content: message.markdown },
		...(message.buttons === undefined || message.buttons.length === 0
			? []
			: [
					{
						tag: "action",
						actions: message.buttons.map((button) => ({
							tag: "button",
							text: { tag: "plain_text", content: button.label },
							type: button.style ?? "default",
							value: { value: button.value },
						})),
					},
				]),
	],
})

/**
 * Reads the events of the event subscription (schema 2.0) and card button presses.
 * With an encrypt key, Lark signs each request with
 * `SHA-256(timestamp + nonce + encrypt key + body)`, and each event has the verification token.
 */
const read = (secrets: Secrets, request: Parameters<Channel["receive"]>[0]) =>
	Effect.gen(function* () {
		const outer = parse(request.body)
		const encrypted = text(outer, "encrypt")
		if (encrypted === undefined)
			return yield* new ChannelDenied({ reason: "the event is not encrypted" })
		const body = parse(decrypt(secrets.encryptKey, encrypted) ?? "")
		if (body === undefined)
			return yield* new ChannelDenied({ reason: "the event does not decrypt" })
		// The check of the request URL has the token, but no signature.
		if (text(body, "type") === "url_verification") {
			const token = text(body, "token")
			if (token === undefined || !sameSecret(token, secrets.verificationToken))
				return yield* new ChannelDenied({ reason: "wrong verification token" })
			return { events: [], reply: { challenge: text(body, "challenge") } }
		}
		const timestamp = request.headers["x-lark-request-timestamp"]
		const nonce = request.headers["x-lark-request-nonce"]
		const signature = request.headers["x-lark-signature"]
		if (
			!recentSeconds(timestamp, request.now) ||
			nonce === undefined ||
			signature === undefined
		)
			return yield* new ChannelDenied({ reason: "missing or old signature" })
		const expected = createHash("sha256")
			.update(timestamp + nonce + secrets.encryptKey + request.body)
			.digest("hex")
		if (!sameSecret(signature, expected))
			return yield* new ChannelDenied({ reason: "wrong signature" })
		const header = field(body, "header")
		const token = text(header, "token")
		if (token === undefined || !sameSecret(token, secrets.verificationToken))
			return yield* new ChannelDenied({ reason: "wrong verification token" })
		const eventId = text(header, "event_id") ?? ""
		const event = field(body, "event")
		switch (text(header, "event_type")) {
			case "im.message.receive_v1": {
				const message = field(event, "message")
				const sender = text(
					field(field(event, "sender"), "sender_id"),
					"open_id",
				)
				const chat = text(message, "chat_id")
				const content = text(parse(text(message, "content") ?? ""), "text")
				if (
					sender === undefined ||
					chat === undefined ||
					content === undefined ||
					text(field(event, "sender"), "sender_type") === "app"
				)
					return { events: [], reply: {} }
				const direct = text(message, "chat_type") === "p2p"
				return {
					events: [
						ChannelEvent.Message({
							eventId,
							conversation: { key: chat, kind: direct ? "direct" : "group" },
							sender: { externalId: sender, displayName: sender },
							text: content.replace(/@_user_\d+/g, "").trim(),
							// By default Lark only sends the group messages that mention the bot.
							mentioned: true,
						}),
					],
					reply: {},
				}
			}
			case "card.action.trigger": {
				const operator = text(field(event, "operator"), "open_id")
				const chat = text(field(event, "context"), "open_chat_id")
				const value = text(field(field(event, "action"), "value"), "value")
				if (operator === undefined || chat === undefined || value === undefined)
					return { events: [], reply: {} }
				return {
					events: [
						ChannelEvent.Action({
							eventId,
							conversation: { key: chat, kind: "group" },
							sender: { externalId: operator, displayName: operator },
							value,
						}),
					],
					reply: {},
				}
			}
			default:
				return { events: [], reply: {} }
		}
	})

export const make = (secrets: Secrets, call: Call): Effect.Effect<Channel> =>
	Effect.gen(function* () {
		const origin = origins[secrets.domain]
		// The tenant token lasts about two hours. One token serves every message until then.
		const cached = yield* Ref.make<
			{ readonly token: string; readonly until: number } | undefined
		>(undefined)
		const token = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const current = yield* Ref.get(cached)
			if (current !== undefined && current.until > now) return current.token
			const reply = yield* call(
				HttpClientRequest.post(
					origin + "/open-apis/auth/v3/tenant_access_token/internal",
				).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						app_id: secrets.appId,
						app_secret: secrets.appSecret,
					}),
				),
			)
			const value = text(reply.json, "tenant_access_token")
			const expire = field(reply.json, "expire")
			if (reply.status !== 200 || value === undefined)
				return yield* failed(reply, "Lark did not give a tenant token")
			yield* Ref.set(cached, {
				token: value,
				until:
					now + ((Predicate.isNumber(expire) ? expire : 3600) - 300) * 1000,
			})
			return value
		})
		const request = (
			build: HttpClientRequest.HttpClientRequest,
			what: string,
		) =>
			Effect.gen(function* () {
				const reply = yield* call(
					build.pipe(HttpClientRequest.bearerToken(yield* token)),
				)
				if (reply.status === 200 && field(reply.json, "code") === 0)
					return field(reply.json, "data")
				if (reply.status !== 200)
					return yield* failed(
						reply,
						`Lark answered ${reply.status} to ${what}`,
					)
				return yield* new ChannelDeliveryFailed({
					message: `Lark refused ${what}: ${text(reply.json, "msg") ?? "unknown error"}`,
					retry: false,
				})
			})
		const create = (
			idType: "chat_id" | "open_id",
			receiver: string,
			message: OutboundMessage,
		) =>
			request(
				HttpClientRequest.post(origin + "/open-apis/im/v1/messages").pipe(
					HttpClientRequest.setUrlParam("receive_id_type", idType),
					HttpClientRequest.bodyJsonUnsafe({
						receive_id: receiver,
						msg_type: "interactive",
						content: JSON.stringify(card(message)),
					}),
				),
				"a new message",
			).pipe(
				Effect.map((data) => ({
					conversation: text(data, "chat_id") ?? receiver,
					id: text(data, "message_id") ?? "",
				})),
			)
		return new Channel({
			kind: "lark",
			features: { edit: true, maxLength: 20_000, private: false },
			receive: (input) => read(secrets, input),
			send: (target, message) =>
				target._tag === "Conversation"
					? create("chat_id", target.conversation, message)
					: create("open_id", target.person, message),
			edit: (ref, message) =>
				request(
					HttpClientRequest.patch(
						origin + "/open-apis/im/v1/messages/" + encodeURIComponent(ref.id),
					).pipe(
						HttpClientRequest.bodyJsonUnsafe({
							content: JSON.stringify(card(message)),
						}),
					),
					"a change of a message",
				).pipe(Effect.asVoid),
			acknowledge: () => Effect.void,
			// The request URL goes into the settings of the Lark app by hand.
			register: () => Effect.void,
		})
	})
