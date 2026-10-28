import { Tokens as TokensModel } from "@openbot-build/domain"

import { Authorization } from "@openbot-build/domain"
import type { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Clock,
	Crypto,
	DateTime,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import { Base64Url, Hex } from "effect/encoding"
import { and, count, eq, sql } from "drizzle-orm"
import { tokens } from "../database/Schema.ts"
import { Tokens } from "./Tokens.ts"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"
import * as Failures from "../errors/Failures.ts"
import * as Db from "../database/Database.ts"

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

const day = 24 * 60 * 60 * 1000
/** Do not write on every request, but keep the usage information useful. */
const lastUsedResolution = 60 * 1000

const PolicyJson = Authorization.PolicySchema
/** The lock key of the tokens of one member. */
const LockKey = Schema.fromJsonString(
	Schema.Tuple([Schema.Literal("tokens"), Schema.String, Schema.String]),
)
/** Fails with `TokenStorageUnavailable` in place of a storage failure, and logs the failure. */
const storageUnavailable = (message: string) =>
	Failures.replace(message, () => TokensModel.TokenStorageUnavailable.make({}))
/** The policy column holds JSON that only this file writes, from a checked policy. */
const encodePolicy = (policy: typeof PolicyJson.Type) =>
	Schema.encodeEffect(PolicyJson)(policy).pipe(Effect.orDie)
const view = (
	row: typeof tokens.$inferSelect,
): Effect.Effect<TokensModel.Token, TokensModel.TokenStorageUnavailable> =>
	Schema.decodeEffect(PolicyJson)(row.policy).pipe(
		storageUnavailable("The stored policy of a token does not decode."),
		Effect.map((policy) => ({
			id: TokensModel.TokenId.make(row.id),
			name: row.name,
			prefix: row.prefix,
			policy,
			createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.createdAt)),
			expiresAt:
				row.expiresAt === null
					? null
					: DateTime.formatIso(DateTime.makeUnsafe(row.expiresAt)),
			lastUsedAt:
				row.lastUsedAt === null
					? null
					: DateTime.formatIso(DateTime.makeUnsafe(row.lastUsedAt)),
		})),
	)

export const make: Effect.Effect<
	typeof Tokens.Service,
	never,
	PgClient.PgClient | Crypto.Crypto
> = Effect.gen(function* () {
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	/** The SHA-256 hash of a secret, in hex. Only the hash goes into the database. */
	const hash = (secret: string) =>
		crypto
			.digest("SHA-256", new TextEncoder().encode(secret))
			.pipe(Effect.orDie, Effect.map(Hex.encode))
	const owned = (owner: {
		readonly organizationId: string
		readonly userId: string
	}) =>
		and(
			eq(tokens.organizationId, owner.organizationId),
			eq(tokens.userId, owner.userId),
		)
	return Tokens.of({
		create: (owner, input) =>
			Effect.gen(function* () {
				// The policy of a token can never give more than its member has,
				// because a check needs both to allow the act.
				const policy = input.policy ?? Authorization.defaultTokenPolicy
				return yield* db.transaction((tx) =>
					Effect.gen(function* () {
						// Create tokens one at a time per member, so concurrent requests keep the limit.
						const lockKey = yield* Schema.encodeEffect(LockKey)([
							"tokens",
							owner.organizationId,
							owner.userId,
						]).pipe(Effect.orDie)
						yield* tx.execute(
							sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
						)
						const [existing] = yield* tx
							.select({ total: count() })
							.from(tokens)
							.where(owned(owner))
						if ((existing?.total ?? 0) >= TokensModel.MaxTokens)
							return yield* TokensModel.TokenLimitReached.make({
								limit: TokensModel.MaxTokens,
							})
						const now = yield* Clock.currentTimeMillis
						const secret =
							TokensModel.SecretPrefix +
							Base64Url.encode(yield* Effect.orDie(crypto.randomBytes(32)))
						const row = {
							id: yield* Effect.orDie(crypto.randomUUIDv7()),
							organizationId: owner.organizationId,
							userId: owner.userId,
							name: Str.trim(input.name),
							prefix: Str.slice(0, TokensModel.SecretPrefix.length + 8)(secret),
							hash: yield* hash(secret),
							policy: yield* encodePolicy(policy),
							createdAt: now,
							expiresAt:
								input.expiresInDays === undefined
									? null
									: now + input.expiresInDays * day,
							lastUsedAt: null,
						}
						yield* tx.insert(tokens).values(row)
						return { token: yield* view(row), secret: Redacted.make(secret) }
					}),
				)
			}).pipe(
				// `TokenLimitReached` keeps its meaning.
				Failures.replaceTag(
					"EffectDrizzleQueryError",
					"A token could not be created.",
					() => TokensModel.TokenStorageUnavailable.make({}),
				),
				Failures.replaceTag("SqlError", "A token could not be created.", () =>
					TokensModel.TokenStorageUnavailable.make({}),
				),
			),
		list: (owner) =>
			db
				.select()
				.from(tokens)
				.where(owned(owner))
				.orderBy(tokens.createdAt, tokens.id)
				.pipe(
					storageUnavailable("The tokens of a member could not be listed."),
					Effect.flatMap((rows) => Effect.forEach(rows, view)),
				),
		revoke: (owner, id) =>
			!isUuid(id)
				? Effect.fail(TokensModel.TokenNotFound.make({}))
				: db
						.delete(tokens)
						.where(and(owned(owner), eq(tokens.id, id)))
						.returning()
						.pipe(
							storageUnavailable("A token could not be revoked."),
							Effect.flatMap(([row]) =>
								row === undefined
									? Effect.fail(TokensModel.TokenNotFound.make({}))
									: Effect.succeed(row),
							),
							Effect.flatMap(view),
						),
		find: (owner, id) =>
			!isUuid(id)
				? Effect.succeedNone
				: db
						.select()
						.from(tokens)
						.where(and(owned(owner), eq(tokens.id, id)))
						.pipe(
							storageUnavailable("A token could not be read."),
							Effect.flatMap((rows) =>
								Effect.transposeOption(Option.map(Arr.head(rows), view)),
							),
						),
		authenticate: (credential) =>
			Effect.gen(function* () {
				const secret = Redacted.value(credential)
				if (!Str.startsWith(TokensModel.SecretPrefix)(secret))
					return yield* CredentialRejected.make({ kind: "token" })
				const [row] = yield* db
					.select()
					.from(tokens)
					.where(eq(tokens.hash, yield* hash(secret)))
					.pipe(
						Failures.replace("The token of a secret could not be read.", () =>
							AuthUnavailable.make({ dependency: "storage" }),
						),
					)
				const now = yield* Clock.currentTimeMillis
				if (
					row === undefined ||
					(row.expiresAt !== null && row.expiresAt <= now)
				)
					return yield* CredentialRejected.make({ kind: "token" })
				if (
					row.lastUsedAt === null ||
					now - row.lastUsedAt >= lastUsedResolution
				)
					yield* db
						.update(tokens)
						.set({ lastUsedAt: now })
						.where(eq(tokens.id, row.id))
						.pipe(
							Failures.replace(
								"The last use time of a token could not be written.",
								() => AuthUnavailable.make({ dependency: "storage" }),
							),
						)
				return {
					kind: "user_token" as const,
					userId: row.userId,
					organizationId: row.organizationId,
					tokenId: TokensModel.TokenId.make(row.id),
				}
			}),
	})
})
export const layer = Layer.effect(Tokens, make)
