import {
	Authorization,
	Caller,
	Channels as ChannelsApi,
} from "@openbot-build/domain"
import { Bots as BotsApi } from "@openbot-build/domain"
import { Context, Effect, Option, Schema } from "effect"
import { ConversationKind } from "./Channel.ts"

/**
 * The secrets of a Channel, opened. Only the server sees them. They are stored as
 * sealed JSON. Secret fields stay redacted until an adapter uses them.
 */
export const Credentials = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("slack"),
		botToken: Schema.RedactedFromValue(Schema.String),
		signingSecret: Schema.RedactedFromValue(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("lark"),
		domain: ChannelsApi.LarkDomain,
		appId: Schema.String,
		appSecret: Schema.RedactedFromValue(Schema.String),
		verificationToken: Schema.RedactedFromValue(Schema.String),
		encryptKey: Schema.RedactedFromValue(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("telegram"),
		botToken: Schema.RedactedFromValue(Schema.String),
		webhookSecret: Schema.RedactedFromValue(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("custom"),
		endpoint: Schema.String,
		secret: Schema.NullOr(Schema.RedactedFromValue(Schema.String)),
	}),
])

export type Credentials = typeof Credentials.Type

/** A stored Channel. The API view adds the webhook address of the public origin. */
export type StoredChannel = ChannelsApi.Channel

export interface Conversation {
	readonly organizationId: string
	readonly channelId: string
	readonly key: string
	readonly kind: ConversationKind
	readonly title: string | null
	readonly chat: string
	/** The member that owns the Chat. */
	readonly owner: string
}

type Failure = ChannelsApi.ChannelsUnavailable

/**
 * The Channels of each organization: their secrets, the people linked to them,
 * and the Chat of each chat.
 */
export class Channels extends Context.Service<
	Channels,
	{
		readonly list: (
			caller: Caller,
		) => Effect.Effect<
			ReadonlyArray<StoredChannel>,
			Failure | Authorization.PolicyUnavailable
		>
		readonly get: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<StoredChannel>, Failure>
		/** Finds a Channel by its ID alone, for its webhook. */
		readonly find: (id: string) => Effect.Effect<
			Option.Option<{
				readonly organizationId: string
				readonly channel: StoredChannel
			}>,
			Failure
		>
		readonly create: (input: {
			readonly caller: Caller
			readonly name: string
			readonly bot: BotsApi.BotId
			readonly credentials: Credentials
			readonly linkPath: string | null
			readonly enabled: boolean
		}) => Effect.Effect<StoredChannel, Failure>
		/** Changes a Channel. The caller of the change becomes its actor. */
		readonly update: (
			caller: Caller,
			id: string,
			expected: number,
			change: {
				readonly name?: string
				readonly bot?: BotsApi.BotId
				readonly credentials?: Credentials
				readonly linkPath?: string | null
				readonly enabled?: boolean
			},
		) => Effect.Effect<
			StoredChannel,
			Failure | ChannelsApi.ChannelNotFound | ChannelsApi.ChannelConflict
		>
		readonly credentials: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			{ readonly version: number; readonly credentials: Credentials },
			Failure | ChannelsApi.ChannelNotFound
		>
		readonly authority: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			Option.Option<Caller>,
			Failure | ChannelsApi.ChannelNotFound
		>
		readonly identities: (
			organizationId: string,
			channelId: string,
		) => Effect.Effect<ReadonlyArray<ChannelsApi.ChannelIdentity>, Failure>
		readonly identitiesOf: (
			organizationId: string,
			userId: string,
		) => Effect.Effect<ReadonlyArray<ChannelsApi.ChannelIdentity>, Failure>
		readonly identity: (
			channelId: string,
			externalUserId: string,
		) => Effect.Effect<Option.Option<ChannelsApi.ChannelIdentity>, Failure>
		/** The account of a member on the platform of a Channel, if they linked one. */
		readonly identityOfUser: (
			channelId: string,
			userId: string,
		) => Effect.Effect<Option.Option<ChannelsApi.ChannelIdentity>, Failure>
		/** Removes a link. With `userId`, only a link of that member. */
		readonly unlink: (input: {
			readonly organizationId: string
			readonly channelId: string
			readonly externalUserId: string
			readonly userId?: string
		}) => Effect.Effect<boolean, Failure>
		/** Makes a link code for a person on the platform. Only its hash is stored. */
		readonly createLink: (input: {
			readonly organizationId: string
			readonly channelId: string
			readonly externalUserId: string
			readonly displayName: string
		}) => Effect.Effect<string, Failure>
		readonly readLink: (
			organizationId: string,
			code: string,
		) => Effect.Effect<
			ChannelsApi.ChannelLink,
			Failure | ChannelsApi.ChannelLinkInvalid
		>
		/** Links the person of the code to the member. A code works only once. */
		readonly acceptLink: (
			organizationId: string,
			code: string,
			userId: string,
		) => Effect.Effect<
			ChannelsApi.ChannelIdentity,
			Failure | ChannelsApi.ChannelLinkInvalid
		>
		readonly conversation: (
			channelId: string,
			key: string,
		) => Effect.Effect<Option.Option<Conversation>, Failure>
		readonly conversationOfChat: (
			chat: string,
		) => Effect.Effect<Option.Option<Conversation>, Failure>
		readonly conversations: (
			channelId: string,
		) => Effect.Effect<ReadonlyArray<Conversation>, Failure>
		readonly saveConversation: (
			conversation: Conversation,
		) => Effect.Effect<void, Failure>
	}
>()("@openbot-build/openbot/conversation-contract/channels/Channels") {}

export { type Failure }
