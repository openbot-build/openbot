import { Channels } from "@openbot-build/domain"
import { Clock, Effect, Redacted, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import {
	Channel,
	ChannelDeliveryFailed,
	ChannelDenied,
	ChannelEvent,
	type OutboundMessage,
} from "../Channel.ts"
import { type Call, failed } from "../Http.ts"
import { hmacHex, recentSeconds, sameSecret } from "../Text.ts"

export interface Secrets {
	readonly endpoint: string
	/** The signing secret. A custom Channel without one takes no events and sends nothing. */
	readonly secret: Redacted.Redacted<string> | null
}

const signature = (secret: string, timestamp: string, body: string) =>
	"sha256=" + hmacHex(secret, `${timestamp}.${body}`)

const decodeEvent = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Channels.CustomEvent),
)
const decodeResult = Schema.decodeUnknownEffect(Channels.CustomDeliveryResult)
const encodeDelivery = Schema.encodeEffect(
	Schema.fromJsonString(Channels.CustomDelivery),
)

/**
 * Reads the events of a custom Channel. Each request has `X-OpenBot-Timestamp` in seconds
 * and `X-OpenBot-Signature: sha256=HMAC(secret, timestamp + "." + body)`.
 */
const read = (secrets: Secrets, request: Parameters<Channel["receive"]>[0]) =>
	Effect.gen(function* () {
		const timestamp = request.headers["x-openbot-timestamp"]
		const given = request.headers["x-openbot-signature"]
		if (
			secrets.secret === null ||
			given === undefined ||
			timestamp === undefined ||
			!recentSeconds(timestamp, request.now)
		)
			return yield* ChannelDenied.make({ reason: "missing or old signature" })
		if (
			!sameSecret(
				given,
				signature(Redacted.value(secrets.secret), timestamp, request.body),
			)
		)
			return yield* ChannelDenied.make({ reason: "wrong signature" })
		const value = yield* decodeEvent(request.body).pipe(
			Effect.mapError((error) =>
				ChannelDenied.make({
					reason: `the body is not a CustomEvent: ${error.message}`,
				}),
			),
		)
		const conversation = {
			key: value.conversation.id,
			kind: value.conversation.kind,
			...(value.conversation.title === undefined
				? {}
				: { title: value.conversation.title }),
		}
		const sender = {
			externalId: value.sender.id,
			displayName: value.sender.name,
		}
		return {
			events: [
				value.type === "message"
					? ChannelEvent.Message({
							eventId: value.id,
							conversation,
							sender,
							text: value.text,
							mentioned:
								value.conversation.kind === "direct" ||
								value.mentioned === true,
						})
					: ChannelEvent.Action({
							eventId: value.id,
							conversation,
							sender,
							value: value.value,
						}),
			],
			reply: {},
		}
	})

const buttons = (message: OutboundMessage) =>
	message.buttons === undefined ? {} : { buttons: message.buttons }

export const make = (secrets: Secrets, call: Call): Channel => {
	const deliver = (delivery: Channels.CustomDelivery) =>
		Effect.gen(function* () {
			if (secrets.secret === null)
				return yield* ChannelDeliveryFailed.make({
					message: "The custom Channel has no signing secret yet",
					retry: false,
				})
			// OpenBot makes the delivery, so a value that does not encode is a defect.
			const body = yield* encodeDelivery(delivery).pipe(Effect.orDie)
			const timestamp = String(
				Math.floor((yield* Clock.currentTimeMillis) / 1000),
			)
			const reply = yield* call(
				HttpClientRequest.post(secrets.endpoint).pipe(
					HttpClientRequest.setHeaders({
						"x-openbot-timestamp": timestamp,
						"x-openbot-signature": signature(
							Redacted.value(secrets.secret),
							timestamp,
							body,
						),
					}),
					HttpClientRequest.bodyText(body, "application/json"),
				),
			)
			if (reply.status < 200 || reply.status > 299)
				return yield* failed(
					reply,
					`The custom Channel answered ${reply.status}`,
				)
			return reply.json
		})
	return new Channel({
		kind: "custom",
		features: { edit: true, maxLength: 20_000, private: true },
		receive: (request) => read(secrets, request),
		send: (target, message) =>
			deliver({
				type: "send",
				...(target._tag === "Person"
					? {}
					: { conversation: target.conversation }),
				...(target._tag === "Conversation" ? {} : { person: target.person }),
				markdown: message.markdown,
				...buttons(message),
			}).pipe(
				Effect.flatMap((json) =>
					decodeResult(json).pipe(
						Effect.mapError((error) =>
							ChannelDeliveryFailed.make({
								message: `The custom Channel did not answer with a ref: ${error.message}`,
								retry: false,
							}),
						),
						Effect.map((result) => ({
							conversation:
								result.conversation ??
								(target._tag === "Person"
									? target.person
									: target.conversation),
							id: result.ref,
						})),
					),
				),
			),
		edit: (ref, message) =>
			deliver({
				type: "edit",
				conversation: ref.conversation,
				ref: ref.id,
				markdown: message.markdown,
				...buttons(message),
			}).pipe(Effect.asVoid),
		acknowledge: () => Effect.void,
		register: () => Effect.void,
	})
}
