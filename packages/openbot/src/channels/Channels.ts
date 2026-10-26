import { BotsApi, ChannelsApi } from "@openbot-build/api"
import { and, eq, isNull } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	pipe,
	Record as Rec,
	Schema,
} from "effect"
import { Base64Url, Hex } from "effect/encoding"
import * as Failures from "../app/Failures.ts"
import { ConversationKind } from "./Channel.ts"
import {
	channelConversations,
	channelIdentities,
	channelLinks,
	channels,
} from "../database/Schema.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"

/**
 * The secrets of a Channel, opened. Only the server sees them. They are stored as
 * sealed JSON, and this schema reads them back. The fields are plain strings: the
 * API checked them when they came in.
 */
export const Credentials = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("slack"),
		botToken: Schema.String,
		signingSecret: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("lark"),
		domain: ChannelsApi.LarkDomain,
		appId: Schema.String,
		appSecret: Schema.String,
		verificationToken: Schema.String,
		encryptKey: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("telegram"),
		botToken: Schema.String,
		webhookSecret: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("custom"),
		endpoint: Schema.String,
		secret: Schema.NullOr(Schema.String),
	}),
])
export type Credentials = typeof Credentials.Type

const CredentialsJson = Schema.fromJsonString(Credentials)
const decodeCredentials = Schema.decodeUnknownEffect(CredentialsJson)
const encodeCredentials = Schema.encodeEffect(CredentialsJson)

/** A stored Channel. The API view adds the webhook address of the public origin. */
export type StoredChannel = Omit<ChannelsApi.Channel, "webhookUrl">

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

/** A link code lasts this long. A person asks the bot again for a new one. */
export const linkLifetimeMs = 15 * 60 * 1000

const binding = (id: string) => `openbot_channels:${id}:credentials`

/**
 * Secure random bytes. A platform without secure random numbers cannot keep
 * secrets, so a failure here is a defect.
 */
const randomBytes = (crypto: Crypto.Crypto, size: number) =>
	Effect.orDie(crypto.randomBytes(size))

/** The credentials of the API, with the secrets that OpenBot makes itself. */
export const fromInput = (
	crypto: Crypto.Crypto,
	value: ChannelsApi.ChannelCredentials,
	current?: Credentials,
): Effect.Effect<Credentials> =>
	Effect.gen(function* () {
		const input = yield* Schema.encodeEffect(ChannelsApi.ChannelCredentials)(
			value,
		).pipe(Effect.orDie)
		switch (input.kind) {
			case "slack":
			case "lark":
				return input
			case "telegram":
				return {
					...input,
					// A new token keeps the webhook secret, so Telegram does not need it again.
					webhookSecret:
						current?.kind === "telegram"
							? current.webhookSecret
							: Base64Url.encode(yield* randomBytes(crypto, 32)),
				}
			case "custom":
				return {
					...input,
					secret: current?.kind === "custom" ? current.secret : null,
				}
		}
	})

const state = (
	hints: Readonly<Record<string, string | null>>,
	key: string,
) => ({
	set: key in hints,
	hint: hints[key] ?? null,
})

/** What the API shows of the credentials. It never shows a secret. */
const credentialsView = (
	kind: ChannelsApi.ChannelKind,
	hints: Readonly<Record<string, string | null>>,
	plain: Readonly<Record<string, string>>,
): ChannelsApi.ChannelCredentialsView => {
	switch (kind) {
		case "slack":
			return {
				kind,
				botToken: state(hints, "botToken"),
				signingSecret: state(hints, "signingSecret"),
			}
		case "lark":
			return {
				kind,
				domain: plain["domain"] === "lark" ? "lark" : "feishu",
				appId: plain["appId"] ?? "",
				appSecret: state(hints, "appSecret"),
				verificationToken: state(hints, "verificationToken"),
				encryptKey: state(hints, "encryptKey"),
			}
		case "telegram":
			return { kind, botToken: state(hints, "botToken") }
		case "custom":
			return {
				kind,
				endpoint: plain["endpoint"] ?? "",
				secret: state(hints, "secret"),
			}
	}
}

/** The fields of credentials that the API may show. The other fields are secret. */
const isPlain = (key: string) =>
	key === "domain" || key === "appId" || key === "endpoint"

/** The secret fields of credentials, and the plain fields that the API may show. */
const split = (credentials: Credentials) => {
	const fields = Arr.filter(
		Rec.toEntries<string, string | null>(credentials),
		(entry): entry is [string, string] =>
			entry[0] !== "kind" && entry[1] !== null,
	)
	return {
		hints: pipe(
			fields,
			// The webhook secret of Telegram is between OpenBot and Telegram, so it gets no hint.
			Arr.filter(([key]) => !isPlain(key) && key !== "webhookSecret"),
			Arr.map(([key, value]) => [key, hint(value)] as const),
			Rec.fromEntries,
		),
		plain: pipe(
			fields,
			Arr.filter(([key]) => isPlain(key)),
			Rec.fromEntries,
		),
	}
}

type Row = typeof channels.$inferSelect

const decodeKind = Schema.decodeUnknownEffect(ChannelsApi.ChannelKind)
const decodeConversationKind = Schema.decodeUnknownEffect(ConversationKind)

/** The hints column holds JSON that only `split` writes. */
const Hints = Schema.fromJsonString(
	Schema.Struct({
		hints: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
		plain: Schema.Record(Schema.String, Schema.String),
	}),
)
const decodeHints = Schema.decodeUnknownEffect(Hints)
const encodeHints = Schema.encodeEffect(Hints)

/**
 * Reads a value that OpenBot stored. A bad value is logged here. The caller only
 * learns that Channels are unavailable.
 */
const readStored = <A>(effect: Effect.Effect<A, Schema.SchemaError>) =>
	effect.pipe(
		Failures.replace("A stored Channel has a bad value.", () =>
			ChannelsApi.ChannelsUnavailable.make({}),
		),
	)

const fromRow = (row: Row): Effect.Effect<StoredChannel, Failure> =>
	Effect.gen(function* () {
		const stored = yield* readStored(decodeHints(row.hints))
		const kind = yield* readStored(decodeKind(row.kind))
		return {
			id: ChannelsApi.ChannelId.make(row.id),
			kind,
			name: row.name,
			bot: BotsApi.BotId.make(row.bot),
			actor: row.actor,
			enabled: row.enabled,
			linkPath: row.linkPath,
			credentials: credentialsView(kind, stored.hints, stored.plain),
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}
	})

type IdentityRow = typeof channelIdentities.$inferSelect
const identityOf = (row: IdentityRow): ChannelsApi.ChannelIdentity => ({
	channel: ChannelsApi.ChannelId.make(row.channelId),
	externalUserId: row.externalUserId,
	displayName: row.displayName,
	userId: row.userId,
	createdAt: row.createdAt,
})

type Failure = ChannelsApi.ChannelsUnavailable

/**
 * The Channels of each organization: their secrets, the people linked to them,
 * and the Chat of each chat.
 */
export class Channels extends Context.Service<
	Channels,
	{
		readonly list: (
			organizationId: string,
		) => Effect.Effect<ReadonlyArray<StoredChannel>, Failure>
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
			readonly organizationId: string
			readonly actor: string
			readonly name: string
			readonly bot: BotsApi.BotId
			readonly credentials: Credentials
			readonly linkPath: string | null
			readonly enabled: boolean
		}) => Effect.Effect<StoredChannel, Failure>
		/** Changes a Channel. The caller of the change becomes its actor. */
		readonly update: (
			organizationId: string,
			id: string,
			expected: number,
			change: {
				readonly actor: string
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
		readonly remove: (
			organizationId: string,
			id: string,
		) => Effect.Effect<boolean, Failure>
		readonly credentials: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Credentials, Failure | ChannelsApi.ChannelNotFound>
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
>()("@openbot-build/openbot/channels/Channels") {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	/** A failure of the database or of the secrets is `ChannelsUnavailable`. The log keeps the cause. */
	const stored = Failures.replace(
		"OpenBot could not read or write a Channel.",
		() => ChannelsApi.ChannelsUnavailable.make({}),
	)
	/** The SHA-256 of a link code, as hex. Only this hash is stored. */
	const hashOf = (code: string) =>
		crypto.digest("SHA-256", new TextEncoder().encode(code)).pipe(
			// SHA-256 is always there on a working platform, so a failure here is a defect.
			Effect.orDie,
			Effect.map(Hex.encode),
		)
	const where = (organizationId: string, id: string) =>
		and(eq(channels.organizationId, organizationId), eq(channels.id, id))
	const row = (organizationId: string, id: string) =>
		stored(db.select().from(channels).where(where(organizationId, id))).pipe(
			Effect.map((rows) => Option.fromNullishOr(rows[0])),
		)
	const seal = (id: string, credentials: Credentials) =>
		Effect.gen(function* () {
			// The types already check the credentials, so a failure to encode them is a defect.
			const json = yield* Effect.orDie(encodeCredentials(credentials))
			const hints = yield* Effect.orDie(encodeHints(split(credentials)))
			const sealed = yield* stored(secrets.seal(json, binding(id)))
			return { credentials: sealed, hints }
		})
	const open = (row: Row) =>
		stored(secrets.open(row.credentials, binding(row.id))).pipe(
			Effect.flatMap((json) => readStored(decodeCredentials(json))),
		)
	/** An open code of the organization, with its Channel. */
	const openLink = (organizationId: string, code: string) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const hash = yield* hashOf(code)
			const link = (yield* stored(
				db.select().from(channelLinks).where(eq(channelLinks.codeHash, hash)),
			))[0]
			if (
				link === undefined ||
				link.organizationId !== organizationId ||
				link.usedAt !== null ||
				link.expiresAt <= now
			)
				return yield* ChannelsApi.ChannelLinkInvalid.make({})
			const channel = yield* row(organizationId, link.channelId)
			if (Option.isNone(channel))
				return yield* ChannelsApi.ChannelLinkInvalid.make({})
			return { link, channel: channel.value, now }
		})
	const conversationOf = (row: typeof channelConversations.$inferSelect) =>
		Effect.map(
			readStored(decodeConversationKind(row.kind)),
			(kind): Conversation => ({
				organizationId: row.organizationId,
				channelId: row.channelId,
				key: row.conversationKey,
				kind,
				title: row.title,
				chat: row.chat,
				owner: row.owner,
			}),
		)
	return Channels.of({
		list: (organizationId) =>
			stored(
				db
					.select()
					.from(channels)
					.where(eq(channels.organizationId, organizationId))
					.orderBy(channels.createdAt),
			).pipe(Effect.flatMap((rows) => Effect.forEach(rows, fromRow))),
		get: (organizationId, id) =>
			row(organizationId, id).pipe(
				Effect.flatMap((found) =>
					Effect.transposeOption(Option.map(found, fromRow)),
				),
			),
		find: (id) =>
			stored(db.select().from(channels).where(eq(channels.id, id))).pipe(
				Effect.flatMap((rows) =>
					Effect.transposeOption(
						Option.map(Option.fromNullishOr(rows[0]), (row) =>
							Effect.map(fromRow(row), (channel) => ({
								organizationId: row.organizationId,
								channel,
							})),
						),
					),
				),
			),
		create: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const id = "chn_" + Hex.encode(yield* randomBytes(crypto, 16))
				const sealed = yield* seal(id, input.credentials)
				const values = {
					organizationId: input.organizationId,
					id,
					kind: input.credentials.kind,
					name: input.name,
					bot: input.bot,
					actor: input.actor,
					enabled: input.enabled,
					linkPath: input.linkPath,
					...sealed,
					version: 0,
					createdAt: now,
					updatedAt: now,
				}
				yield* stored(db.insert(channels).values(values))
				return yield* fromRow(values)
			}),
		update: (organizationId, id, expected, change) =>
			Effect.gen(function* () {
				const current = yield* row(organizationId, id)
				if (Option.isNone(current))
					return yield* ChannelsApi.ChannelNotFound.make({ id })
				if (current.value.version !== expected)
					return yield* ChannelsApi.ChannelConflict.make({
						version: current.value.version,
					})
				const now = yield* Clock.currentTimeMillis
				const sealed =
					change.credentials === undefined
						? {}
						: yield* seal(id, change.credentials)
				const values = {
					...current.value,
					actor: change.actor,
					...(change.name === undefined ? {} : { name: change.name }),
					...(change.bot === undefined ? {} : { bot: change.bot }),
					...(change.linkPath === undefined
						? {}
						: { linkPath: change.linkPath }),
					...(change.enabled === undefined ? {} : { enabled: change.enabled }),
					...sealed,
					version: expected + 1,
					updatedAt: now,
				}
				const changed = yield* stored(
					db
						.update(channels)
						.set(values)
						.where(
							and(where(organizationId, id), eq(channels.version, expected)),
						)
						.returning({ id: channels.id }),
				)
				if (changed.length === 0)
					return yield* ChannelsApi.ChannelConflict.make({ version: expected })
				return yield* fromRow(values)
			}),
		remove: (organizationId, id) =>
			stored(
				db
					.delete(channels)
					.where(where(organizationId, id))
					.returning({ id: channels.id }),
			).pipe(Effect.map((rows) => rows.length > 0)),
		credentials: (organizationId, id) =>
			Effect.gen(function* () {
				const current = yield* row(organizationId, id)
				if (Option.isNone(current))
					return yield* ChannelsApi.ChannelNotFound.make({ id })
				return yield* open(current.value)
			}),
		identities: (organizationId, channelId) =>
			stored(
				db
					.select()
					.from(channelIdentities)
					.where(
						and(
							eq(channelIdentities.organizationId, organizationId),
							eq(channelIdentities.channelId, channelId),
						),
					)
					.orderBy(channelIdentities.createdAt),
			).pipe(Effect.map((rows) => Arr.map(rows, identityOf))),
		identitiesOf: (organizationId, userId) =>
			stored(
				db
					.select()
					.from(channelIdentities)
					.where(
						and(
							eq(channelIdentities.organizationId, organizationId),
							eq(channelIdentities.userId, userId),
						),
					)
					.orderBy(channelIdentities.createdAt),
			).pipe(Effect.map((rows) => Arr.map(rows, identityOf))),
		identity: (channelId, externalUserId) =>
			stored(
				db
					.select()
					.from(channelIdentities)
					.where(
						and(
							eq(channelIdentities.channelId, channelId),
							eq(channelIdentities.externalUserId, externalUserId),
						),
					),
			).pipe(
				Effect.map((rows) =>
					Option.map(Option.fromNullishOr(rows[0]), identityOf),
				),
			),
		identityOfUser: (channelId, userId) =>
			stored(
				db
					.select()
					.from(channelIdentities)
					.where(
						and(
							eq(channelIdentities.channelId, channelId),
							eq(channelIdentities.userId, userId),
						),
					)
					.orderBy(channelIdentities.createdAt)
					.limit(1),
			).pipe(
				Effect.map((rows) =>
					Option.map(Option.fromNullishOr(rows[0]), identityOf),
				),
			),
		unlink: (input) =>
			stored(
				db
					.delete(channelIdentities)
					.where(
						and(
							eq(channelIdentities.organizationId, input.organizationId),
							eq(channelIdentities.channelId, input.channelId),
							eq(channelIdentities.externalUserId, input.externalUserId),
							...(input.userId === undefined
								? []
								: [eq(channelIdentities.userId, input.userId)]),
						),
					)
					.returning({ id: channelIdentities.externalUserId }),
			).pipe(Effect.map((rows) => rows.length > 0)),
		createLink: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const code = "ocl_" + Base64Url.encode(yield* randomBytes(crypto, 32))
				const hash = yield* hashOf(code)
				yield* stored(
					db.insert(channelLinks).values({
						codeHash: hash,
						organizationId: input.organizationId,
						channelId: input.channelId,
						externalUserId: input.externalUserId,
						displayName: input.displayName,
						expiresAt: now + linkLifetimeMs,
						usedAt: null,
					}),
				)
				return code
			}),
		readLink: (organizationId, code) =>
			Effect.gen(function* () {
				const { link, channel } = yield* openLink(organizationId, code)
				return {
					channel: ChannelsApi.ChannelId.make(channel.id),
					channelName: channel.name,
					kind: yield* readStored(decodeKind(channel.kind)),
					externalUserId: link.externalUserId,
					displayName: link.displayName,
					expiresAt: link.expiresAt,
				}
			}),
		acceptLink: (organizationId, code, userId) =>
			Effect.gen(function* () {
				const { link, now } = yield* openLink(organizationId, code)
				// Only one accept can use the code, also when two arrive at the same time.
				const used = yield* stored(
					db
						.update(channelLinks)
						.set({ usedAt: now })
						.where(
							and(
								eq(channelLinks.codeHash, link.codeHash),
								isNull(channelLinks.usedAt),
							),
						)
						.returning({ code: channelLinks.codeHash }),
				)
				if (used.length === 0)
					return yield* ChannelsApi.ChannelLinkInvalid.make({})
				const values = {
					organizationId,
					channelId: link.channelId,
					externalUserId: link.externalUserId,
					userId,
					displayName: link.displayName,
					createdAt: now,
				}
				yield* stored(
					db
						.insert(channelIdentities)
						.values(values)
						.onConflictDoUpdate({
							target: [
								channelIdentities.channelId,
								channelIdentities.externalUserId,
							],
							set: {
								userId,
								displayName: link.displayName,
								createdAt: now,
							},
						}),
				)
				return identityOf(values)
			}),
		conversation: (channelId, key) =>
			stored(
				db
					.select()
					.from(channelConversations)
					.where(
						and(
							eq(channelConversations.channelId, channelId),
							eq(channelConversations.conversationKey, key),
						),
					),
			).pipe(
				Effect.flatMap((rows) =>
					Effect.transposeOption(
						Option.map(Option.fromNullishOr(rows[0]), conversationOf),
					),
				),
			),
		conversationOfChat: (chat) =>
			stored(
				db
					.select()
					.from(channelConversations)
					.where(eq(channelConversations.chat, chat)),
			).pipe(
				Effect.flatMap((rows) =>
					Effect.transposeOption(
						Option.map(Option.fromNullishOr(rows[0]), conversationOf),
					),
				),
			),
		conversations: (channelId) =>
			stored(
				db
					.select()
					.from(channelConversations)
					.where(eq(channelConversations.channelId, channelId))
					.orderBy(channelConversations.createdAt),
			).pipe(Effect.flatMap((rows) => Effect.forEach(rows, conversationOf))),
		saveConversation: (conversation) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.insert(channelConversations)
						.values({
							organizationId: conversation.organizationId,
							channelId: conversation.channelId,
							conversationKey: conversation.key,
							kind: conversation.kind,
							title: conversation.title,
							chat: conversation.chat,
							owner: conversation.owner,
							createdAt: now,
						})
						.onConflictDoUpdate({
							target: [
								channelConversations.channelId,
								channelConversations.conversationKey,
							],
							set: {
								chat: conversation.chat,
								owner: conversation.owner,
								title: conversation.title,
							},
						}),
				)
			}),
	})
})
export const layer = Layer.effect(Channels, make)
