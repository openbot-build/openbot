import { Redacted } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no API for the AES cipher of Lark events.
import { createDecipheriv } from "node:crypto"
import type { Channels as ChannelsApi } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Crypto,
	Effect,
	Option,
	pipe,
	Predicate,
	String as Str,
	SynchronizedRef,
} from "effect"
import { Hex } from "effect/encoding"
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
	readonly appSecret: Redacted.Redacted<string>
	readonly verificationToken: Redacted.Redacted<string>
	readonly encryptKey: Redacted.Redacted<string>
}

const origins: Record<ChannelsApi.LarkDomain, string> = {
	feishu: "https://open.feishu.cn",
	lark: "https://open.larksuite.com",
}

/** A platform without SHA-256 cannot check Lark events, so a failure here is a defect. */
const sha256 = (crypto: Crypto.Crypto, value: string) =>
	crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie)

/**
 * Lark encrypts each event with AES-256-CBC. The key is the SHA-256 of the encrypt key,
 * and the first 16 bytes of the data are the IV.
 */
const decrypt = Option.liftThrowable((key: Uint8Array, data: string) => {
	const bytes = Buffer.from(data, "base64")
	const decipher = createDecipheriv("aes-256-cbc", key, bytes.subarray(0, 16))
	return Buffer.concat([
		decipher.update(bytes.subarray(16)),
		decipher.final(),
	]).toString("utf8")
})

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
						actions: Arr.map(message.buttons, (button) => ({
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
const read = (
	secrets: Secrets,
	crypto: Crypto.Crypto,
	request: Parameters<Channel["receive"]>[0],
) =>
	Effect.gen(function* () {
		const outer = parse(request.body)
		const encrypted = text(outer, "encrypt")
		if (encrypted === undefined)
			return yield* ChannelDenied.make({ reason: "the event is not encrypted" })
		const key = yield* sha256(crypto, Redacted.value(secrets.encryptKey))
		const body = parse(Option.getOrElse(decrypt(key, encrypted), () => ""))
		if (body === undefined)
			return yield* ChannelDenied.make({ reason: "the event does not decrypt" })
		// The check of the request URL has the token, but no signature.
		if (text(body, "type") === "url_verification") {
			const token = text(body, "token")
			if (
				token === undefined ||
				!sameSecret(token, Redacted.value(secrets.verificationToken))
			)
				return yield* ChannelDenied.make({ reason: "wrong verification token" })
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
			return yield* ChannelDenied.make({ reason: "missing or old signature" })
		const expected = Hex.encode(
			yield* sha256(
				crypto,
				timestamp + nonce + Redacted.value(secrets.encryptKey) + request.body,
			),
		)
		if (!sameSecret(signature, expected))
			return yield* ChannelDenied.make({ reason: "wrong signature" })
		const header = field(body, "header")
		const token = text(header, "token")
		if (
			token === undefined ||
			!sameSecret(token, Redacted.value(secrets.verificationToken))
		)
			return yield* ChannelDenied.make({ reason: "wrong verification token" })
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
							// Lark puts `@_user_1` in the text for each mention. The Bot does not need them.
							text: pipe(content, Str.replace(/@_user_\d+/g, ""), Str.trim),
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

export const make = (
	secrets: Secrets,
	call: Call,
): Effect.Effect<Channel, never, Crypto.Crypto> =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto
		const origin = origins[secrets.domain]
		// The tenant token lasts about two hours. One token serves every message until then.
		// Concurrent callers wait for one request of a new token, and do not each send one.
		const cached = yield* SynchronizedRef.make<
			| { readonly token: Redacted.Redacted<string>; readonly until: number }
			| undefined
		>(undefined)
		const token = SynchronizedRef.modifyEffect(cached, (current) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				if (current !== undefined && current.until > now)
					return [current.token, current] as const
				const reply = yield* call(
					HttpClientRequest.post(
						origin + "/open-apis/auth/v3/tenant_access_token/internal",
					).pipe(
						HttpClientRequest.bodyJsonUnsafe({
							app_id: secrets.appId,
							app_secret: Redacted.value(secrets.appSecret),
						}),
					),
				)
				const value = text(reply.json, "tenant_access_token")
				const expire = field(reply.json, "expire")
				if (reply.status !== 200 || value === undefined)
					return yield* failed(
						reply,
						`Lark did not give a tenant token: ${text(reply.json, "msg") ?? reply.status}`,
					)
				return [
					Redacted.make(value),
					{
						token: Redacted.make(value),
						until:
							now + ((Predicate.isNumber(expire) ? expire : 3600) - 300) * 1000,
					},
				] as const
			}),
		)
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
				return yield* ChannelDeliveryFailed.make({
					message: `Lark refused ${what}: ${text(reply.json, "msg") ?? "unknown error"}`,
					retry: false,
				})
			})
		const create = (
			idType: "chat_id" | "open_id",
			receiver: string,
			message: OutboundMessage,
			key: string,
		) =>
			request(
				HttpClientRequest.post(origin + "/open-apis/im/v1/messages").pipe(
					HttpClientRequest.setUrlParam("receive_id_type", idType),
					HttpClientRequest.bodyJsonUnsafe({
						receive_id: receiver,
						// The key is stable across attempts. The platform deduplicates for one hour.
						// https://open.feishu.cn/document/server-docs/im-v1/message/create
						uuid: key,
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
			receive: (input) => read(secrets, crypto, input),
			send: (target, message, key) =>
				target._tag === "Conversation"
					? create("chat_id", target.conversation, message, key)
					: create("open_id", target.person, message, key),
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
