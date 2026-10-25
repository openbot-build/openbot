import type { ChannelsApi } from "@openbot-build/api"
import { Data, type Effect, Schema } from "effect"

/** One chat on a platform. Each chat of a Channel is one Chat. */
export const Conversation = Schema.Struct({
	/** The ID of the chat on the platform, such as a Slack channel ID. */
	key: Schema.String,
	kind: Schema.Literals(["direct", "group"]),
	title: Schema.optionalKey(Schema.String),
})
export type Conversation = typeof Conversation.Type

/** The person on the platform who sent an event. */
export const Sender = Schema.Struct({
	externalId: Schema.String,
	displayName: Schema.String,
})
export type Sender = typeof Sender.Type

/**
 * Something that happened on the platform, in the form that every Channel shares.
 * The queue keeps events as JSON, so this schema reads them back.
 */
export const ChannelEventSchema = Schema.Union([
	/** A person wrote to the bot. In a group chat, `mentioned` tells if they named the bot. */
	Schema.TaggedStruct("Message", {
		eventId: Schema.String,
		conversation: Conversation,
		sender: Sender,
		text: Schema.String,
		mentioned: Schema.Boolean,
	}),
	/** A person pressed a button of the bot. `value` is the value of the button. */
	Schema.TaggedStruct("Action", {
		eventId: Schema.String,
		conversation: Conversation,
		sender: Sender,
		value: Schema.String,
		/** What the platform needs to stop showing that the press is in progress. */
		receipt: Schema.optionalKey(Schema.String),
	}),
])
export type ChannelEvent = typeof ChannelEventSchema.Type
export const ChannelEvent = Data.taggedEnum<ChannelEvent>()

export const Button = Schema.Struct({
	label: Schema.String,
	value: Schema.String,
	style: Schema.optionalKey(Schema.Literals(["primary", "danger"])),
})
export type Button = typeof Button.Type

/** A message from the bot. The text is Markdown. Each Channel turns it into its own format. */
export const OutboundMessage = Schema.Struct({
	markdown: Schema.String,
	buttons: Schema.optionalKey(Schema.Array(Button)),
})
export type OutboundMessage = typeof OutboundMessage.Type

/**
 * Where the bot sends a message: to a chat, to one person inside a chat (only when the
 * Channel has the `private` feature), or to a direct chat with one person.
 */
export const TargetSchema = Schema.Union([
	Schema.TaggedStruct("Conversation", { conversation: Schema.String }),
	Schema.TaggedStruct("Private", {
		conversation: Schema.String,
		person: Schema.String,
	}),
	Schema.TaggedStruct("Person", { person: Schema.String }),
])
export type Target = typeof TargetSchema.Type
export const Target = Data.taggedEnum<Target>()

/** A message that the bot sent. The Channel can change it later with this ref. */
export const MessageRef = Schema.Struct({
	conversation: Schema.String,
	id: Schema.String,
})
export type MessageRef = typeof MessageRef.Type

export interface Features {
	/** The bot can change a message that it sent. */
	readonly edit: boolean
	/** The longest text that one message can have. */
	readonly maxLength: number
	/** The bot can show a message in a group to one person only. */
	readonly private: boolean
}

/** The raw request that a platform sent to the webhook. */
export interface Request {
	readonly headers: Readonly<Record<string, string | undefined>>
	readonly body: string
	/** The time now, in milliseconds. */
	readonly now: number
}

/** What the webhook answers at once, and the events that OpenBot handles later. */
export interface Received {
	readonly events: ReadonlyArray<ChannelEvent>
	readonly reply: unknown
}

/** The request did not come from the platform: the signature or token is wrong or too old. */
export class ChannelDenied extends Schema.TaggedError<ChannelDenied>()(
	"ChannelDenied",
	{
		reason: Schema.String,
	},
) {}

/** The platform did not take a message. `retryAfterMs` is set when it asked to wait. */
export class ChannelDeliveryFailed extends Schema.TaggedError<ChannelDeliveryFailed>()(
	"ChannelDeliveryFailed",
	{
		message: Schema.String,
		retryAfterMs: Schema.optional(Schema.Finite),
		/** False when trying again cannot help, such as a wrong token. */
		retry: Schema.Boolean,
	},
) {}

/**
 * The integration of one platform. Each kind has its own folder, like the model providers.
 * A Channel value holds the secrets of one stored Channel.
 */
export class Channel extends Data.TaggedClass("Channel.Channel")<{
	readonly kind: ChannelsApi.ChannelKind
	readonly features: Features
	/** Checks that the request came from the platform, and reads its events. */
	readonly receive: (request: Request) => Effect.Effect<Received, ChannelDenied>
	readonly send: (
		target: Target,
		message: OutboundMessage,
	) => Effect.Effect<MessageRef, ChannelDeliveryFailed>
	readonly edit: (
		ref: MessageRef,
		message: OutboundMessage,
	) => Effect.Effect<void, ChannelDeliveryFailed>
	/** Tells the platform that a button press was handled. */
	readonly acknowledge: (
		action: Extract<ChannelEvent, { readonly _tag: "Action" }>,
	) => Effect.Effect<void, ChannelDeliveryFailed>
	/** Tells the platform the webhook address, for platforms that take it by API. */
	readonly register: (
		webhookUrl: string,
	) => Effect.Effect<void, ChannelDeliveryFailed>
}> {}
