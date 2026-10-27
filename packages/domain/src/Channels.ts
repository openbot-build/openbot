import * as Execution from "./Execution.ts"
import { Schema } from "effect"
import { BotId } from "./BotId.ts"
import { Version } from "./Version.ts"
import { SecretState } from "./Secret.ts"

export const ChannelId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/ChannelId"))
export type ChannelId = typeof ChannelId.Type

export const LarkDomain = Schema.Literals(["feishu", "lark"])
export type LarkDomain = typeof LarkDomain.Type

/** Public hints about the stored credentials. */
export const ChannelKind = Schema.Literals([
	"slack",
	"lark",
	"telegram",
	"custom",
])
export type ChannelKind = typeof ChannelKind.Type

export const ChannelCredentialsView = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("slack"),
		botToken: SecretState,
		signingSecret: SecretState,
	}),
	Schema.Struct({
		kind: Schema.Literal("lark"),
		domain: LarkDomain,
		appId: Schema.String,
		appSecret: SecretState,
		verificationToken: SecretState,
		encryptKey: SecretState,
	}),
	Schema.Struct({
		kind: Schema.Literal("telegram"),
		botToken: SecretState,
	}),
	Schema.Struct({
		kind: Schema.Literal("custom"),
		endpoint: Schema.String,
		secret: SecretState,
	}),
])
export type ChannelCredentialsView = typeof ChannelCredentialsView.Type

/**
 * A Channel is one bot of the organization on one platform, such as a Slack app.
 * People talk with its Bot in direct chats and group chats. Each chat is one Chat.
 */
export const Channel = Schema.Struct({
	id: ChannelId,
	kind: ChannelKind,
	name: Schema.String,
	/** The persistent Bot of the organization that answers in this Channel. */
	bot: BotId,
	/**
	 * The member that owns the Chats of the Channel. It is the last member who
	 * created or changed the Channel. Each Turn works for the person who spoke.
	 */
	actor: Schema.String,
	enabled: Schema.Boolean,
	/** True when a saved change must set a caller before this Channel can work. */
	needsAuthorization: Schema.Boolean,
	/**
	 * A path on the public origin where your client lets a person link their account.
	 * OpenBot adds `?code=...`. Without it, the bot sends only the code.
	 */
	linkPath: Schema.NullOr(Schema.String),
	credentials: ChannelCredentialsView,
	/** The saved configuration or removal work. Older records need data conversion. */
	executionId: Schema.NullOr(Execution.Id),
	version: Version,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Channel = typeof Channel.Type

/** A person on a platform, linked to a member of the organization. */
export const ChannelIdentity = Schema.Struct({
	channel: ChannelId,
	externalUserId: Schema.String,
	displayName: Schema.String,
	userId: Schema.String,
	createdAt: Schema.Finite,
})
export type ChannelIdentity = typeof ChannelIdentity.Type

/** A link code that a bot gave to a person who is not linked yet. */
export const ChannelLink = Schema.Struct({
	channel: ChannelId,
	channelName: Schema.String,
	kind: ChannelKind,
	externalUserId: Schema.String,
	displayName: Schema.String,
	expiresAt: Schema.Finite,
})
export type ChannelLink = typeof ChannelLink.Type

export class ChannelNotFound extends Schema.TaggedError<
	ChannelNotFound,
	{ readonly brand: unique symbol }
>()("ChannelNotFound", { id: Schema.String }) {}
export class ChannelConflict extends Schema.TaggedError<
	ChannelConflict,
	{ readonly brand: unique symbol }
>()("ChannelConflict", { version: Version }) {}
export class ChannelInvalid extends Schema.TaggedError<
	ChannelInvalid,
	{ readonly brand: unique symbol }
>()("ChannelInvalid", { message: Schema.String }) {}
/** The code is unknown, used or too old. Ask the bot for a new one. */
export class ChannelLinkInvalid extends Schema.TaggedError<
	ChannelLinkInvalid,
	{ readonly brand: unique symbol }
>()("ChannelLinkInvalid", {}) {}
export class ChannelIdentityNotFound extends Schema.TaggedError<
	ChannelIdentityNotFound,
	{ readonly brand: unique symbol }
>()("ChannelIdentityNotFound", {}) {}
export class ChannelsUnavailable extends Schema.TaggedError<
	ChannelsUnavailable,
	{ readonly brand: unique symbol }
>()("ChannelsUnavailable", {}) {}
/** The signature is wrong, the Channel does not exist, or it is disabled. */
export class ChannelHookDenied extends Schema.TaggedError<
	ChannelHookDenied,
	{ readonly brand: unique symbol }
>()("ChannelHookDenied", {}) {}

/** An HTTPS address that a custom Channel sends its replies to. */
export const ChannelEndpoint = Schema.NonEmptyString.check(
	Schema.isMaxLength(2048),
	Schema.makeFilter(
		(value: string) => {
			const url = URL.parse(value)
			return (
				url !== null &&
				url.protocol === "https:" &&
				url.username === "" &&
				url.password === "" &&
				url.hash === ""
			)
		},
		{ message: "Expected an HTTPS URL without credentials or fragment" },
	),
)

/** The secrets that a Channel needs. They go in, but they never come out. */
export const CredentialsInput = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("slack"),
		botToken: Schema.RedactedFromValue(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
		),
		signingSecret: Schema.RedactedFromValue(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
		),
	}),
	Schema.Struct({
		kind: Schema.Literal("lark"),
		domain: LarkDomain,
		appId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
		appSecret: Schema.RedactedFromValue(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
		),
		verificationToken: Schema.RedactedFromValue(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
		),
		encryptKey: Schema.RedactedFromValue(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
		),
	}),
	/** OpenBot makes the webhook secret itself and tells Telegram the webhook. */
	Schema.Struct({
		kind: Schema.Literal("telegram"),
		botToken: Schema.RedactedFromValue(
			Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
		),
	}),
	/** Make the signing secret with `PUT /v1/organization/channels/:channelId/secret`. */
	Schema.Struct({
		kind: Schema.Literal("custom"),
		endpoint: ChannelEndpoint,
	}),
])
export type CredentialsInput = typeof CredentialsInput.Type

const ExternalId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(256),
)

/** A chat on the platform of a custom Channel. */
export const CustomConversation = Schema.Struct({
	id: ExternalId,
	kind: Schema.Literals(["direct", "group"]),
	title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
})
export const CustomSender = Schema.Struct({
	id: ExternalId,
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})

/**
 * An event that a custom Channel sends to its webhook. `id` must be unique for the
 * Channel, so OpenBot can drop a repeated event.
 */
export const CustomEvent = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("message"),
		id: ExternalId,
		conversation: CustomConversation,
		sender: CustomSender,
		text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20000)),
		/** In a group chat, OpenBot only answers when the message mentions the bot. */
		mentioned: Schema.optionalKey(Schema.Boolean),
	}),
	/** A person pressed a button. `value` is the value of the button. */
	Schema.Struct({
		type: Schema.Literal("action"),
		id: ExternalId,
		conversation: CustomConversation,
		sender: CustomSender,
		value: Schema.String.check(Schema.isMaxLength(1000)),
	}),
])
export type CustomEvent = typeof CustomEvent.Type

/** A button in a message. Pressing it sends an `action` event with its value. */
export const CustomButton = Schema.Struct({
	label: Schema.String,
	value: Schema.String,
	style: Schema.optionalKey(Schema.Literals(["primary", "danger"])),
})

/**
 * What OpenBot sends to the endpoint of a custom Channel. A `send` answers with
 * `{ "ref": "<message id>", "conversation": "<chat id>" }`. An `edit` changes the message
 * with that ref.
 */
export const CustomDelivery = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("send"),
		/** The chat. Without it, send the message in a direct chat with `person`. */
		conversation: Schema.optionalKey(Schema.String),
		/** With a `conversation`, only this person should see the message in that chat. */
		person: Schema.optionalKey(Schema.String),
		markdown: Schema.String,
		buttons: Schema.optionalKey(Schema.Array(CustomButton)),
	}),
	Schema.Struct({
		type: Schema.Literal("edit"),
		conversation: Schema.String,
		ref: Schema.String,
		markdown: Schema.String,
		buttons: Schema.optionalKey(Schema.Array(CustomButton)),
	}),
])
export type CustomDelivery = typeof CustomDelivery.Type
export const CustomDeliveryResult = Schema.Struct({
	ref: Schema.String,
	/** The chat of the message. Give it when OpenBot sent no `conversation`. */
	conversation: Schema.optionalKey(Schema.String),
})
