import type { ChannelsApi } from "@openbot-build/api"
import { Data, type Effect } from "effect"

/** One chat on a platform. Each chat of a Channel is one Session. */
export interface Conversation {
	/** The ID of the chat on the platform, such as a Slack channel ID. */
	readonly key: string
	readonly kind: "direct" | "group"
	readonly title?: string
}

/** The person on the platform who sent an event. */
export interface Sender {
	readonly externalId: string
	readonly displayName: string
}

/** Something that happened on the platform, in the form that every Channel shares. */
export type ChannelEvent = Data.TaggedEnum<{
	/** A person wrote to the bot. In a group chat, `mentioned` tells if they named the bot. */
	Message: {
		readonly eventId: string
		readonly conversation: Conversation
		readonly sender: Sender
		readonly text: string
		readonly mentioned: boolean
	}
	/** A person pressed a button of the bot. `value` is the value of the button. */
	Action: {
		readonly eventId: string
		readonly conversation: Conversation
		readonly sender: Sender
		readonly value: string
		/** What the platform needs to stop showing that the press is in progress. */
		readonly receipt?: string
	}
}>
export const ChannelEvent = Data.taggedEnum<ChannelEvent>()

export interface Button {
	readonly label: string
	readonly value: string
	readonly style?: "primary" | "danger"
}

/** A message from the bot. The text is Markdown. Each Channel turns it into its own format. */
export interface OutboundMessage {
	readonly markdown: string
	readonly buttons?: ReadonlyArray<Button>
}

/**
 * Where the bot sends a message: to a chat, to one person inside a chat (only when the
 * Channel has the `private` feature), or to a direct chat with one person.
 */
export type Target = Data.TaggedEnum<{
	Conversation: { readonly conversation: string }
	Private: { readonly conversation: string; readonly person: string }
	Person: { readonly person: string }
}>
export const Target = Data.taggedEnum<Target>()

/** A message that the bot sent. The Channel can change it later with this ref. */
export interface MessageRef {
	readonly conversation: string
	readonly id: string
}

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
export class ChannelDenied extends Data.TaggedError("ChannelDenied")<{
	readonly reason: string
}> {}

/** The platform did not take a message. `retryAfterMs` is set when it asked to wait. */
export class ChannelDeliveryFailed extends Data.TaggedError(
	"ChannelDeliveryFailed",
)<{
	readonly message: string
	readonly retryAfterMs?: number
	/** False when trying again cannot help, such as a wrong token. */
	readonly retry: boolean
}> {}

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
