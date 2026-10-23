import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotId } from "./BotsApi.ts"
import { BotAuth, ReturnTo } from "./AuthApi.ts"
import {
	Authorize,
	GroupRequired,
	PermissionErrors,
	requires,
} from "./Permissions.ts"
import { SecretInput, SecretState, Version } from "./Settings.ts"

export const ChannelId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/ChannelId"))
export type ChannelId = typeof ChannelId.Type

/**
 * The platform of a Channel. `custom` is any other system that speaks the
 * Channel protocol of OpenBot over signed HTTP requests.
 */
export const ChannelKind = Schema.Literals([
	"slack",
	"lark",
	"telegram",
	"custom",
])
export type ChannelKind = typeof ChannelKind.Type

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

/** Lark has two domains: `feishu` in China and `lark` in other places. */
export const LarkDomain = Schema.Literals(["feishu", "lark"])
export type LarkDomain = typeof LarkDomain.Type

/** The secrets that a Channel needs. They go in, but they never come out. */
export const ChannelCredentials = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("slack"),
		botToken: SecretInput,
		signingSecret: SecretInput,
	}),
	Schema.Struct({
		kind: Schema.Literal("lark"),
		domain: LarkDomain,
		appId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
		appSecret: SecretInput,
		verificationToken: SecretInput,
		encryptKey: SecretInput,
	}),
	/** OpenBot makes the webhook secret itself and tells Telegram the webhook. */
	Schema.Struct({
		kind: Schema.Literal("telegram"),
		botToken: SecretInput,
	}),
	/** Make the signing secret with `PUT /v1/organization/channels/:channelId/secret`. */
	Schema.Struct({
		kind: Schema.Literal("custom"),
		endpoint: ChannelEndpoint,
	}),
])
export type ChannelCredentials = typeof ChannelCredentials.Type

/** What the API shows of the secrets of a Channel. */
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
	/**
	 * A path on the public origin where your client lets a person link their account.
	 * OpenBot adds `?code=...`. Without it, the bot sends only the code.
	 */
	linkPath: Schema.NullOr(Schema.String),
	/** Give this address to the platform. It receives the events of the Channel. */
	webhookUrl: Schema.String,
	credentials: ChannelCredentialsView,
	version: Version,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Channel = typeof Channel.Type

const ChannelName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(120),
)

export const CreateChannelRequest = Schema.Struct({
	name: ChannelName,
	bot: BotId,
	credentials: ChannelCredentials,
	linkPath: Schema.optionalKey(ReturnTo),
	enabled: Schema.optionalKey(Schema.Boolean),
})
export type CreateChannelRequest = typeof CreateChannelRequest.Type

export const UpdateChannelRequest = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(ChannelName),
	bot: Schema.optionalKey(BotId),
	/** Leave it out to keep the current secrets. The kind cannot change. */
	credentials: Schema.optionalKey(ChannelCredentials),
	/** `null` removes the path. */
	linkPath: Schema.optionalKey(Schema.NullOr(ReturnTo)),
	enabled: Schema.optionalKey(Schema.Boolean),
})
export type UpdateChannelRequest = typeof UpdateChannelRequest.Type

/** The signing secret of a custom Channel. OpenBot shows it only once. */
export const ChannelSecret = Schema.Struct({ secret: Schema.String })
export type ChannelSecret = typeof ChannelSecret.Type

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

export class ChannelNotFound extends Schema.TaggedError<ChannelNotFound>()(
	"ChannelNotFound",
	{ id: Schema.String },
) {}
export class ChannelConflict extends Schema.TaggedError<ChannelConflict>()(
	"ChannelConflict",
	{ version: Version },
) {}
export class ChannelInvalid extends Schema.TaggedError<ChannelInvalid>()(
	"ChannelInvalid",
	{ message: Schema.String },
) {}
/** The code is unknown, used or too old. Ask the bot for a new one. */
export class ChannelLinkInvalid extends Schema.TaggedError<ChannelLinkInvalid>()(
	"ChannelLinkInvalid",
	{},
) {}
export class ChannelIdentityNotFound extends Schema.TaggedError<ChannelIdentityNotFound>()(
	"ChannelIdentityNotFound",
	{},
) {}
export class ChannelsUnavailable extends Schema.TaggedError<ChannelsUnavailable>()(
	"ChannelsUnavailable",
	{},
) {}
/** The signature is wrong, the Channel does not exist, or it is disabled. */
export class ChannelHookDenied extends Schema.TaggedError<ChannelHookDenied>()(
	"ChannelHookDenied",
	{},
) {}

export const ChannelErrors = [
	...PermissionErrors,
	ChannelNotFound.pipe(HttpApiSchema.status(404)),
	ChannelConflict.pipe(HttpApiSchema.status(409)),
	ChannelInvalid.pipe(HttpApiSchema.status(400)),
	ChannelIdentityNotFound.pipe(HttpApiSchema.status(404)),
	ChannelsUnavailable.pipe(HttpApiSchema.status(503)),
] as const
const LinkErrors = [
	...PermissionErrors,
	ChannelLinkInvalid.pipe(HttpApiSchema.status(404)),
	ChannelIdentityNotFound.pipe(HttpApiSchema.status(404)),
	ChannelsUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const channelParams = { channelId: ChannelId }
const identityParams = { channelId: ChannelId, externalUserId: Schema.String }

/** The Channels of the organization. Administrators manage them. */
export class ChannelsApi extends HttpApiGroup.make("channels")
	.add(
		HttpApiEndpoint.get("listChannels", "/v1/organization/channels", {
			success: Schema.Array(Channel),
			error: ChannelErrors,
		}),
		HttpApiEndpoint.post("createChannel", "/v1/organization/channels", {
			payload: CreateChannelRequest,
			success: Channel.pipe(HttpApiSchema.status(201)),
			error: ChannelErrors,
		}).annotate(
			OpenApi.Description,
			"Creates a Channel. The caller becomes its actor. For Telegram, OpenBot also sets the webhook of the bot.",
		),
		HttpApiEndpoint.get("getChannel", "/v1/organization/channels/:channelId", {
			params: channelParams,
			success: Channel,
			error: ChannelErrors,
		}),
		HttpApiEndpoint.patch(
			"updateChannel",
			"/v1/organization/channels/:channelId",
			{
				params: channelParams,
				payload: UpdateChannelRequest,
				success: Channel,
				error: ChannelErrors,
			},
		).annotate(
			OpenApi.Description,
			"Changes a Channel. The caller becomes its actor.",
		),
		HttpApiEndpoint.delete(
			"deleteChannel",
			"/v1/organization/channels/:channelId",
			{
				params: channelParams,
				success: HttpApiSchema.NoContent,
				error: ChannelErrors,
			},
		).annotate(
			OpenApi.Description,
			"Deletes a Channel with its linked people. Its Chats stay.",
		),
		HttpApiEndpoint.put(
			"setChannelSecret",
			"/v1/organization/channels/:channelId/secret",
			{
				params: channelParams,
				success: ChannelSecret,
				error: ChannelErrors,
			},
		).annotate(
			OpenApi.Description,
			"Makes a new signing secret for a custom Channel. The old secret stops working.",
		),
		HttpApiEndpoint.get(
			"listChannelIdentities",
			"/v1/organization/channels/:channelId/identities",
			{
				params: channelParams,
				success: Schema.Array(ChannelIdentity),
				error: ChannelErrors,
			},
		),
		HttpApiEndpoint.delete(
			"deleteChannelIdentity",
			"/v1/organization/channels/:channelId/identities/:externalUserId",
			{
				params: identityParams,
				success: HttpApiSchema.NoContent,
				error: ChannelErrors,
			},
		).annotate(
			OpenApi.Description,
			"Unlinks a person. The bot asks them to link again.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.annotate(GroupRequired, {
		read: [requires("channels.read").on("channel", "channelId")],
		write: [requires("channels.write").on("channel", "channelId")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}

/** Each member links their own accounts on the platforms of the Channels. */
export class ChannelLinksApi extends HttpApiGroup.make("channelLinks")
	.add(
		HttpApiEndpoint.get("getChannelLink", "/v1/channel-links/:code", {
			params: { code: Schema.String },
			success: ChannelLink,
			error: LinkErrors,
		}).annotate(
			OpenApi.Description,
			"Shows who a link code is for, so the person can check it before they accept.",
		),
		HttpApiEndpoint.post(
			"acceptChannelLink",
			"/v1/channel-links/:code/accept",
			{
				params: { code: Schema.String },
				success: ChannelIdentity,
				error: LinkErrors,
			},
		).annotate(
			OpenApi.Description,
			"Links the person on the platform to the caller. A code works only once.",
		),
		HttpApiEndpoint.get(
			"listMyChannelIdentities",
			"/v1/user/channel-identities",
			{
				success: Schema.Array(ChannelIdentity),
				error: LinkErrors,
			},
		),
		HttpApiEndpoint.delete(
			"deleteMyChannelIdentity",
			"/v1/user/channel-identities/:channelId/:externalUserId",
			{
				params: identityParams,
				success: HttpApiSchema.NoContent,
				error: LinkErrors,
			},
		),
	)
	.annotate(GroupRequired, {
		read: [requires("channel_identities.read").on("user")],
		write: [requires("channel_identities.write").on("user")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}

/**
 * Receives the events of a platform. The signature of the platform is the only credential,
 * so OpenBot reads the exact body of the request.
 */
export class ChannelHooksApi extends HttpApiGroup.make("channelHooks").add(
	HttpApiEndpoint.post("receiveChannelEvent", "/v1/hooks/channels/:channelId", {
		params: channelParams,
		payload: Schema.Json,
		success: Schema.Json,
		error: [
			ChannelHookDenied.pipe(HttpApiSchema.status(401)),
			ChannelsUnavailable.pipe(HttpApiSchema.status(503)),
		],
	}).annotate(
		OpenApi.Description,
		'Takes an event from Slack, Lark, Telegram or a custom Channel. OpenBot checks the signature, answers at once, and does the work later. A custom Channel sends a `CustomEvent` with `X-OpenBot-Timestamp` and `X-OpenBot-Signature: sha256=<hex HMAC-SHA256 of timestamp + "." + body>`.',
	),
) {}
