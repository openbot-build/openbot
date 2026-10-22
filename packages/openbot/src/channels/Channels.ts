// Credentials are plain data. A pipeable form of their helpers does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { createHash, randomBytes } from "node:crypto"
import { type AgentsApi, ChannelsApi } from "@openbot-build/api"
import { and, eq, isNull } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Clock, Context, Effect, Layer, Option } from "effect"
import {
	channelConversations,
	channelIdentities,
	channelLinks,
	channels,
} from "../database/Schema.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"

/** The secrets of a Channel, opened. Only the server sees them. */
export type Credentials =
	| {
			readonly kind: "slack"
			readonly botToken: string
			readonly signingSecret: string
	  }
	| {
			readonly kind: "lark"
			readonly domain: ChannelsApi.LarkDomain
			readonly appId: string
			readonly appSecret: string
			readonly verificationToken: string
			readonly encryptKey: string
	  }
	| {
			readonly kind: "telegram"
			readonly botToken: string
			readonly webhookSecret: string
	  }
	| {
			readonly kind: "custom"
			readonly endpoint: string
			readonly secret: string | null
	  }

/** A stored Channel. The API view adds the webhook address of the public origin. */
export type StoredChannel = Omit<ChannelsApi.Channel, "webhookUrl">

export interface Conversation {
	readonly organizationId: string
	readonly channelId: string
	readonly key: string
	readonly kind: "direct" | "group"
	readonly title: string | null
	readonly session: string
	/** The member that owns the Session. */
	readonly owner: string
}

const unavailable = () => ChannelsApi.ChannelsUnavailable.make({})

/** A link code lasts this long. A person asks the bot again for a new one. */
export const linkLifetimeMs = 15 * 60 * 1000

const hashCode = (code: string) =>
	createHash("sha256").update(code).digest("hex")

const binding = (id: string) => `openbot_channels:${id}:credentials`

/** The credentials of the API, with the secrets that OpenBot makes itself. */
export const fromInput = (
	input: ChannelsApi.ChannelCredentials,
	current?: Credentials,
): Credentials => {
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
						: randomBytes(32).toString("base64url"),
			}
		case "custom":
			return {
				...input,
				secret: current?.kind === "custom" ? current.secret : null,
			}
	}
}

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

/** The secret fields of credentials, and the plain fields that the API may show. */
const split = (credentials: Credentials) => {
	const hints: Record<string, string | null> = {}
	const plain: Record<string, string> = {}
	for (const [key, value] of Object.entries(credentials)) {
		if (key === "kind" || value === null) continue
		if (key === "domain" || key === "appId" || key === "endpoint")
			plain[key] = value
		// The webhook secret of Telegram is between OpenBot and Telegram, so it gets no hint.
		else if (key !== "webhookSecret") hints[key] = hint(value)
	}
	return { hints, plain }
}

type Row = typeof channels.$inferSelect

const fromRow = (row: Row): StoredChannel => {
	const stored = JSON.parse(row.hints) as {
		readonly hints: Record<string, string | null>
		readonly plain: Record<string, string>
	}
	const kind = row.kind as ChannelsApi.ChannelKind
	return {
		id: ChannelsApi.ChannelId.make(row.id),
		kind,
		name: row.name,
		agent: row.agent as AgentsApi.AgentId,
		actor: row.actor,
		enabled: row.enabled,
		linkPath: row.linkPath,
		credentials: credentialsView(kind, stored.hints, stored.plain),
		version: row.version,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

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
 * and the Session of each chat.
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
			readonly agent: AgentsApi.AgentId
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
				readonly agent?: AgentsApi.AgentId
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
		readonly conversationOfSession: (
			session: string,
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
	const db = yield* makeWithDefaults()
	const secrets = yield* Secrets
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
	const where = (organizationId: string, id: string) =>
		and(eq(channels.organizationId, organizationId), eq(channels.id, id))
	const row = (organizationId: string, id: string) =>
		stored(db.select().from(channels).where(where(organizationId, id))).pipe(
			Effect.map((rows) => Option.fromNullishOr(rows[0])),
		)
	const seal = (id: string, credentials: Credentials) =>
		Effect.gen(function* () {
			const sealed = yield* stored(
				secrets.seal(JSON.stringify(credentials), binding(id)),
			)
			return { credentials: sealed, hints: JSON.stringify(split(credentials)) }
		})
	const open = (row: Row) =>
		stored(secrets.open(row.credentials, binding(row.id))).pipe(
			Effect.map((json) => JSON.parse(json) as Credentials),
		)
	const linkInvalid = () => ChannelsApi.ChannelLinkInvalid.make({})
	/** An open code of the organization, with its Channel. */
	const openLink = (organizationId: string, code: string) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const link = (yield* stored(
				db
					.select()
					.from(channelLinks)
					.where(eq(channelLinks.codeHash, hashCode(code))),
			))[0]
			if (
				link === undefined ||
				link.organizationId !== organizationId ||
				link.usedAt !== null ||
				link.expiresAt <= now
			)
				return yield* linkInvalid()
			const channel = yield* row(organizationId, link.channelId)
			if (Option.isNone(channel)) return yield* linkInvalid()
			return { link, channel: channel.value, now }
		})
	const conversationOf = (
		row: typeof channelConversations.$inferSelect,
	): Conversation => ({
		organizationId: row.organizationId,
		channelId: row.channelId,
		key: row.conversationKey,
		kind: row.kind === "direct" ? "direct" : "group",
		title: row.title,
		session: row.session,
		owner: row.owner,
	})
	return Channels.of({
		list: (organizationId) =>
			stored(
				db
					.select()
					.from(channels)
					.where(eq(channels.organizationId, organizationId))
					.orderBy(channels.createdAt),
			).pipe(Effect.map((rows) => rows.map(fromRow))),
		get: (organizationId, id) =>
			row(organizationId, id).pipe(Effect.map(Option.map(fromRow))),
		find: (id) =>
			stored(db.select().from(channels).where(eq(channels.id, id))).pipe(
				Effect.map((rows) =>
					Option.map(Option.fromNullishOr(rows[0]), (row) => ({
						organizationId: row.organizationId,
						channel: fromRow(row),
					})),
				),
			),
		create: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const id = "chn_" + randomBytes(16).toString("hex")
				const sealed = yield* seal(id, input.credentials)
				const values = {
					organizationId: input.organizationId,
					id,
					kind: input.credentials.kind,
					name: input.name,
					agent: input.agent,
					actor: input.actor,
					enabled: input.enabled,
					linkPath: input.linkPath,
					...sealed,
					version: 0,
					createdAt: now,
					updatedAt: now,
				}
				yield* stored(db.insert(channels).values(values))
				return fromRow(values)
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
					...(change.agent === undefined ? {} : { agent: change.agent }),
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
				return fromRow(values)
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
			).pipe(Effect.map((rows) => rows.map(identityOf))),
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
			).pipe(Effect.map((rows) => rows.map(identityOf))),
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
				const code = "ocl_" + randomBytes(32).toString("base64url")
				yield* stored(
					db.insert(channelLinks).values({
						codeHash: hashCode(code),
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
			openLink(organizationId, code).pipe(
				Effect.map(({ link, channel }) => ({
					channel: ChannelsApi.ChannelId.make(channel.id),
					channelName: channel.name,
					kind: channel.kind as ChannelsApi.ChannelKind,
					externalUserId: link.externalUserId,
					displayName: link.displayName,
					expiresAt: link.expiresAt,
				})),
			),
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
				if (used.length === 0) return yield* linkInvalid()
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
				Effect.map((rows) =>
					Option.map(Option.fromNullishOr(rows[0]), conversationOf),
				),
			),
		conversationOfSession: (session) =>
			stored(
				db
					.select()
					.from(channelConversations)
					.where(eq(channelConversations.session, session)),
			).pipe(
				Effect.map((rows) =>
					Option.map(Option.fromNullishOr(rows[0]), conversationOf),
				),
			),
		conversations: (channelId) =>
			stored(
				db
					.select()
					.from(channelConversations)
					.where(eq(channelConversations.channelId, channelId))
					.orderBy(channelConversations.createdAt),
			).pipe(Effect.map((rows) => rows.map(conversationOf))),
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
							session: conversation.session,
							owner: conversation.owner,
							createdAt: now,
						})
						.onConflictDoUpdate({
							target: [
								channelConversations.channelId,
								channelConversations.conversationKey,
							],
							set: {
								session: conversation.session,
								owner: conversation.owner,
								title: conversation.title,
							},
						}),
				)
			}),
	})
})
export const layer = Layer.effect(Channels, make)
