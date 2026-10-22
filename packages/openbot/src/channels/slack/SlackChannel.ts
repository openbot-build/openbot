import { Effect } from "effect"
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
import { hmacHex, recentSeconds, sameSecret, slackMrkdwn } from "../Text.ts"

export interface Secrets {
	readonly botToken: string
	readonly signingSecret: string
}

const api = "https://slack.com/api/"

/** Slack puts `<@U123>` in the text for each mention. The Agent does not need them. */
const withoutMentions = (value: string) =>
	value.replace(/<@[A-Z0-9]+>/g, "").trim()

const blocks = (message: OutboundMessage) => [
	{
		type: "section",
		text: { type: "mrkdwn", text: slackMrkdwn(message.markdown) },
	},
	...(message.buttons === undefined || message.buttons.length === 0
		? []
		: [
				{
					type: "actions",
					elements: message.buttons.map((button) => ({
						type: "button",
						text: { type: "plain_text", text: button.label },
						value: button.value,
						...(button.style === undefined ? {} : { style: button.style }),
					})),
				},
			]),
]

/**
 * Reads the events of the Events API and the button presses of interactivity.
 * Slack signs each request with `v0=HMAC(signing secret, "v0:" + timestamp + ":" + body)`.
 */
const read = (secrets: Secrets, request: Parameters<Channel["receive"]>[0]) =>
	Effect.gen(function* () {
		const timestamp = request.headers["x-slack-request-timestamp"]
		const signature = request.headers["x-slack-signature"]
		if (!recentSeconds(timestamp, request.now) || signature === undefined)
			return yield* new ChannelDenied({ reason: "missing or old signature" })
		const expected =
			"v0=" + hmacHex(secrets.signingSecret, `v0:${timestamp}:${request.body}`)
		if (!sameSecret(signature, expected))
			return yield* new ChannelDenied({ reason: "wrong signature" })
		// Button presses come as a form with one `payload` field.
		const form = request.body.startsWith("payload=")
			? new URLSearchParams(request.body).get("payload")
			: null
		const body = parse(form ?? request.body)
		if (body === undefined)
			return yield* new ChannelDenied({ reason: "the body is not JSON" })
		const type = text(body, "type")
		if (type === "url_verification")
			return { events: [], reply: { challenge: text(body, "challenge") } }
		if (type === "block_actions") {
			const action = field(body, "actions")
			const first = Array.isArray(action) ? action[0] : undefined
			const user = field(body, "user")
			const channel = field(body, "channel")
			const value = text(first, "value")
			const userId = text(user, "id")
			const channelId = text(channel, "id")
			if (
				value === undefined ||
				userId === undefined ||
				channelId === undefined
			)
				return { events: [], reply: {} }
			return {
				events: [
					ChannelEvent.Action({
						eventId: `action:${text(body, "trigger_id") ?? text(first, "action_ts")}`,
						conversation: {
							key: channelId,
							kind: channelId.startsWith("D") ? "direct" : "group",
						},
						sender: {
							externalId: userId,
							displayName: text(user, "name") ?? userId,
						},
						value,
					}),
				],
				reply: {},
			}
		}
		if (type !== "event_callback") return { events: [], reply: {} }
		const event = field(body, "event")
		const kind = text(event, "type")
		const user = text(event, "user")
		const channel = text(event, "channel")
		const message = text(event, "text")
		// The bot's own messages, edits and other subtypes are not new words from a person.
		if (
			user === undefined ||
			channel === undefined ||
			message === undefined ||
			field(event, "bot_id") !== undefined ||
			field(event, "subtype") !== undefined
		)
			return { events: [], reply: {} }
		const direct = text(event, "channel_type") === "im"
		// In a group, only `app_mention` events are for the bot. A group `message` event is not.
		if (kind !== "app_mention" && !(kind === "message" && direct))
			return { events: [], reply: {} }
		return {
			events: [
				ChannelEvent.Message({
					eventId: text(body, "event_id") ?? `${channel}:${text(event, "ts")}`,
					conversation: { key: channel, kind: direct ? "direct" : "group" },
					sender: { externalId: user, displayName: user },
					text: withoutMentions(message),
					mentioned: kind === "app_mention" || direct,
				}),
			],
			reply: {},
		}
	})

export const make = (secrets: Secrets, call: Call): Channel => {
	const post = (method: string, body: Record<string, unknown>) =>
		Effect.gen(function* () {
			const reply = yield* call(
				HttpClientRequest.post(api + method).pipe(
					HttpClientRequest.bearerToken(secrets.botToken),
					HttpClientRequest.bodyJsonUnsafe(body),
				),
			)
			if (reply.status !== 200)
				return yield* failed(
					reply,
					`Slack answered ${reply.status} to ${method}`,
				)
			if (field(reply.json, "ok") !== true)
				return yield* new ChannelDeliveryFailed({
					message: `Slack refused ${method}: ${text(reply.json, "error") ?? "unknown error"}`,
					retry: text(reply.json, "error") === "ratelimited",
				})
			return reply.json
		})
	return new Channel({
		kind: "slack",
		features: { edit: true, maxLength: 3000, private: true },
		receive: (request) => read(secrets, request),
		send: (target, message) =>
			target._tag === "Private"
				? post("chat.postEphemeral", {
						channel: target.conversation,
						user: target.person,
						text: message.markdown,
						blocks: blocks(message),
					}).pipe(
						Effect.map((json) => ({
							conversation: target.conversation,
							id: text(json, "message_ts") ?? "",
						})),
					)
				: // A user ID as the channel opens the direct chat of the app with that person.
					post("chat.postMessage", {
						channel:
							target._tag === "Person" ? target.person : target.conversation,
						text: message.markdown,
						blocks: blocks(message),
					}).pipe(
						Effect.map((json) => ({
							conversation:
								text(json, "channel") ??
								(target._tag === "Person"
									? target.person
									: target.conversation),
							id: text(json, "ts") ?? "",
						})),
					),
		edit: (ref, message) =>
			post("chat.update", {
				channel: ref.conversation,
				ts: ref.id,
				text: message.markdown,
				blocks: blocks(message),
			}).pipe(Effect.asVoid),
		// Slack needs no answer to a button press besides the 200 of the webhook.
		acknowledge: () => Effect.void,
		// The webhook address goes into the settings of the Slack app by hand.
		register: () => Effect.void,
	})
}
