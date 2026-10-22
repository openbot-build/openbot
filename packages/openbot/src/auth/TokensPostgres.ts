import { Permissions, UserTokensApi } from "@openbot-build/api"
import type { PgClient } from "@effect/sql-pg"
import {
	Clock,
	DateTime,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
} from "effect"
import { and, count, eq, sql } from "drizzle-orm"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { tokens } from "../database/Schema.ts"
import {
	defaultTokenPolicies,
	inOrganization,
} from "../authorization/Policy.ts"
import { Tokens } from "./Tokens.ts"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"
import * as Db from "../database/Database.ts"

const day = 24 * 60 * 60 * 1000
/** Do not write on every request, but keep the usage information useful. */
const lastUsedResolution = 60 * 1000

const decodePolicies = Schema.decodeUnknownSync(
	Schema.fromJsonString(Permissions.Policies),
)
const hash = (secret: string) =>
	createHash("sha256").update(secret).digest("hex")
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))
const view = (row: typeof tokens.$inferSelect): UserTokensApi.Token => ({
	id: row.id,
	name: row.name,
	prefix: row.prefix,
	policies: decodePolicies(row.policies),
	createdAt: iso(row.createdAt),
	expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
	lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
})

export const make: Effect.Effect<
	typeof Tokens.Service,
	never,
	PgClient.PgClient
> = Effect.gen(function* () {
	const db = yield* Db.make
	const unavailable = () => UserTokensApi.TokenStorageUnavailable.make({})
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
				const policies = input.policies ?? defaultTokenPolicies
				if (
					!inOrganization({
						policies,
						organizationId: owner.organizationId,
						// A platform admin can make a token for the platform API.
						platform: true,
					})
				)
					return yield* UserTokensApi.TokenPolicyInvalid.make({
						message:
							"A token policy can only name resources in your own organization.",
					})
				return yield* db.transaction((tx) =>
					Effect.gen(function* () {
						// Create tokens one at a time per member, so concurrent requests keep the limit.
						yield* tx.execute(
							sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["tokens", owner.organizationId, owner.userId])}, 0))`,
						)
						const [existing] = yield* tx
							.select({ total: count() })
							.from(tokens)
							.where(owned(owner))
						if ((existing?.total ?? 0) >= UserTokensApi.MaxTokens)
							return yield* UserTokensApi.TokenLimitReached.make({
								limit: UserTokensApi.MaxTokens,
							})
						const now = yield* Clock.currentTimeMillis
						const secret =
							UserTokensApi.SecretPrefix + randomBytes(32).toString("base64url")
						const row = {
							id: randomUUID(),
							organizationId: owner.organizationId,
							userId: owner.userId,
							name: input.name.trim(),
							prefix: secret.slice(0, UserTokensApi.SecretPrefix.length + 8),
							hash: hash(secret),
							policies: JSON.stringify(policies),
							createdAt: now,
							expiresAt:
								input.expiresInDays === undefined
									? null
									: now + input.expiresInDays * day,
							lastUsedAt: null,
						}
						yield* tx.insert(tokens).values(row)
						return { token: view(row), secret }
					}),
				)
			}).pipe(
				Effect.mapError((error) =>
					error._tag === "TokenLimitReached" ||
					error._tag === "TokenPolicyInvalid"
						? error
						: unavailable(),
				),
			),
		list: (owner) =>
			db
				.select()
				.from(tokens)
				.where(owned(owner))
				.orderBy(tokens.createdAt, tokens.id)
				.pipe(
					Effect.map((rows) => rows.map(view)),
					Effect.mapError(unavailable),
				),
		revoke: (owner, id) =>
			db
				.delete(tokens)
				.where(and(owned(owner), eq(tokens.id, id)))
				.returning()
				.pipe(
					Effect.mapError(unavailable),
					Effect.flatMap(([row]) =>
						row === undefined
							? Effect.fail(UserTokensApi.TokenNotFound.make({}))
							: Effect.succeed(view(row)),
					),
				),
		find: (owner, id) =>
			db
				.select()
				.from(tokens)
				.where(and(owned(owner), eq(tokens.id, id)))
				.pipe(
					Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), view)),
					Effect.mapError(unavailable),
				),
		authenticate: (credential) =>
			Effect.gen(function* () {
				const secret = Redacted.value(credential)
				if (!secret.startsWith(UserTokensApi.SecretPrefix))
					return yield* CredentialRejected.make({ kind: "token" })
				const [row] = yield* db
					.select()
					.from(tokens)
					.where(eq(tokens.hash, hash(secret)))
					.pipe(
						Effect.mapError(() =>
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
							Effect.mapError(() =>
								AuthUnavailable.make({ dependency: "storage" }),
							),
						)
				return {
					kind: "user_token" as const,
					userId: row.userId,
					organizationId: row.organizationId,
					tokenId: row.id,
				}
			}),
	})
})
export const layer = Layer.effect(Tokens, make)
