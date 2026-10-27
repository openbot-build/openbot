import { Channels as Domain, Execution } from "@openbot-build/domain"
import { errors as executionErrors } from "./ExecutionsApi.ts"
import { SecretOutput } from "./Secret.ts"
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
	AuthorizationErrors,
	GroupRequired,
	Required,
	channel,
	channels,
	own,
} from "./Authorization.ts"
import { Version } from "./Settings.ts"

export const ChannelId = Domain.ChannelId
export type ChannelId = Domain.ChannelId

export const ChannelEndpoint = Domain.ChannelEndpoint
export const LarkDomain = Domain.LarkDomain
export type LarkDomain = Domain.LarkDomain
export const ChannelCredentials = Domain.CredentialsInput
export type ChannelCredentials = Domain.CredentialsInput

/**
 * The platform of a Channel. `custom` is any other system that speaks the
 * Channel protocol of OpenBot over signed HTTP requests. It comes from
 * `ChannelCredentials`.
 */
export const ChannelKind = Domain.ChannelKind
export type ChannelKind = Domain.ChannelKind

export const ChannelCredentialsView = Domain.ChannelCredentialsView
export type ChannelCredentialsView = Domain.ChannelCredentialsView

export const Channel = Schema.Struct({
	...Domain.Channel.fields,
	webhookUrl: Schema.String,
})
export type Channel = typeof Channel.Type

const ChannelName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(120),
)

export const CreateChannelRequest = Schema.Struct({
	commandKey: Execution.CommandKey,
	name: ChannelName,
	bot: BotId,
	credentials: ChannelCredentials,
	linkPath: Schema.optionalKey(ReturnTo),
	enabled: Schema.optionalKey(Schema.Boolean),
})
export type CreateChannelRequest = typeof CreateChannelRequest.Type

export const UpdateChannelRequest = Schema.Struct({
	commandKey: Execution.CommandKey,
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
export const ChannelSecret = Schema.Struct({
	secret: SecretOutput,
	channel: Channel,
})
export type ChannelSecret = typeof ChannelSecret.Type

export const ChannelIdentity = Domain.ChannelIdentity
export type ChannelIdentity = Domain.ChannelIdentity

export const ChannelLink = Domain.ChannelLink
export type ChannelLink = Domain.ChannelLink

export const CustomConversation = Domain.CustomConversation

export const CustomSender = Domain.CustomSender

export const CustomEvent = Domain.CustomEvent
export type CustomEvent = Domain.CustomEvent

export const CustomButton = Domain.CustomButton

export const CustomDelivery = Domain.CustomDelivery
export type CustomDelivery = Domain.CustomDelivery

export const CustomDeliveryResult = Domain.CustomDeliveryResult

export const ChannelNotFound = Domain.ChannelNotFound
export type ChannelNotFound = Domain.ChannelNotFound

export const ChannelConflict = Domain.ChannelConflict
export type ChannelConflict = Domain.ChannelConflict

export const ChannelInvalid = Domain.ChannelInvalid
export type ChannelInvalid = Domain.ChannelInvalid

export const ChannelLinkInvalid = Domain.ChannelLinkInvalid
export type ChannelLinkInvalid = Domain.ChannelLinkInvalid

export const ChannelIdentityNotFound = Domain.ChannelIdentityNotFound
export type ChannelIdentityNotFound = Domain.ChannelIdentityNotFound

export const ChannelsUnavailable = Domain.ChannelsUnavailable
export type ChannelsUnavailable = Domain.ChannelsUnavailable

export const ChannelHookDenied = Domain.ChannelHookDenied
export type ChannelHookDenied = Domain.ChannelHookDenied

export const ChannelErrors = [
	...executionErrors,
	...AuthorizationErrors,
	ChannelNotFound.pipe(HttpApiSchema.status(404)),
	ChannelConflict.pipe(HttpApiSchema.status(409)),
	ChannelInvalid.pipe(HttpApiSchema.status(400)),
	ChannelIdentityNotFound.pipe(HttpApiSchema.status(404)),
	ChannelsUnavailable.pipe(HttpApiSchema.status(503)),
] as const
const LinkErrors = [
	...AuthorizationErrors,
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
		}).annotate(Required, []),
		HttpApiEndpoint.post("createChannel", "/v1/organization/channels", {
			payload: CreateChannelRequest,
			success: Channel.pipe(HttpApiSchema.status(201)),
			error: ChannelErrors,
		})
			.annotate(Required, [channels("write")])
			.annotate(
				OpenApi.Description,
				"Saves a Channel and starts its configuration execution. The caller becomes its actor. Read executionId to check registration.",
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
			"Changes a Channel. The caller becomes its actor and clears needsAuthorization.",
		),
		HttpApiEndpoint.delete(
			"deleteChannel",
			"/v1/organization/channels/:channelId",
			{
				params: channelParams,
				payload: Schema.Struct({ commandKey: Execution.CommandKey }),
				success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
				error: ChannelErrors,
			},
		).annotate(
			OpenApi.Description,
			"Stops Channel work, then deletes the Channel and its links. Read the returned execution to wait for release. Its Chats stay.",
		),
		HttpApiEndpoint.put(
			"setChannelSecret",
			"/v1/organization/channels/:channelId/secret",
			{
				params: channelParams,
				payload: Schema.Struct({
					commandKey: Execution.CommandKey,
					expectedVersion: Version,
				}),
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
		read: [channel("read", "channelId")],
		write: [channel("write", "channelId")],
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
		read: [own("read", "ChannelIdentity")],
		write: [own("write", "ChannelIdentity")],
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
