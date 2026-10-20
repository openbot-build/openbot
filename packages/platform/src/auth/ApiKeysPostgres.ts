import { ApiKeysApi } from "@openbot-build/platform-api"
import type { PgClient } from "@effect/sql-pg"
import { Clock, DateTime, Effect, Layer, Redacted } from "effect"
import { and, count, eq, sql } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { apiKeys } from "../database/Schema.ts"
import { ApiKeys } from "./ApiKeys.ts"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"

const day = 24 * 60 * 60 * 1000
/** Do not write on every request, but keep the usage information useful. */
const lastUsedResolution = 60 * 1000

const hash = (secret: string) =>
	createHash("sha256").update(secret).digest("hex")
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))
const view = (row: typeof apiKeys.$inferSelect): ApiKeysApi.ApiKey => ({
	id: row.id,
	name: row.name,
	prefix: row.prefix,
	createdAt: iso(row.createdAt),
	expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
	lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
})

export const make: Effect.Effect<
	typeof ApiKeys.Service,
	never,
	PgClient.PgClient
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const unavailable = () => ApiKeysApi.ApiKeyStorageUnavailable.make({})
	const owned = (owner: {
		readonly tenantId: string
		readonly userId: string
	}) =>
		and(eq(apiKeys.tenantId, owner.tenantId), eq(apiKeys.userId, owner.userId))
	return ApiKeys.of({
		create: (owner, input) =>
			db
				.transaction((tx) =>
					Effect.gen(function* () {
						// Create keys one at a time per account, so concurrent requests keep the limit.
						yield* tx.execute(
							sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["api-keys", owner.tenantId, owner.userId])}, 0))`,
						)
						const [existing] = yield* tx
							.select({ total: count() })
							.from(apiKeys)
							.where(owned(owner))
						if ((existing?.total ?? 0) >= ApiKeysApi.MaxKeys)
							return yield* ApiKeysApi.ApiKeyLimitReached.make({
								limit: ApiKeysApi.MaxKeys,
							})
						const now = yield* Clock.currentTimeMillis
						const secret =
							ApiKeysApi.SecretPrefix + randomBytes(32).toString("base64url")
						const row = {
							id: randomUUID(),
							userId: owner.userId,
							tenantId: owner.tenantId,
							name: input.name.trim(),
							prefix: secret.slice(0, ApiKeysApi.SecretPrefix.length + 8),
							hash: hash(secret),
							createdAt: now,
							expiresAt:
								input.expiresInDays === undefined
									? null
									: now + input.expiresInDays * day,
							lastUsedAt: null,
						}
						yield* tx.insert(apiKeys).values(row)
						return { key: view(row), secret }
					}),
				)
				.pipe(
					Effect.mapError((error) =>
						error._tag === "ApiKeyLimitReached" ? error : unavailable(),
					),
				),
		list: (owner) =>
			db
				.select()
				.from(apiKeys)
				.where(owned(owner))
				.orderBy(apiKeys.createdAt, apiKeys.id)
				.pipe(
					Effect.map((rows) => rows.map(view)),
					Effect.mapError(unavailable),
				),
		revoke: (owner, id) =>
			db
				.delete(apiKeys)
				.where(and(owned(owner), eq(apiKeys.id, id)))
				.returning({ id: apiKeys.id })
				.pipe(
					Effect.mapError(unavailable),
					Effect.flatMap((rows) =>
						rows.length === 0
							? Effect.fail(ApiKeysApi.ApiKeyNotFound.make({}))
							: Effect.void,
					),
				),
		authenticate: (credential) =>
			Effect.gen(function* () {
				const secret = Redacted.value(credential)
				if (!secret.startsWith(ApiKeysApi.SecretPrefix))
					return yield* CredentialRejected.make({ kind: "apiKey" })
				const [row] = yield* db
					.select()
					.from(apiKeys)
					.where(eq(apiKeys.hash, hash(secret)))
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
					return yield* CredentialRejected.make({ kind: "apiKey" })
				if (
					row.lastUsedAt === null ||
					now - row.lastUsedAt >= lastUsedResolution
				)
					yield* db
						.update(apiKeys)
						.set({ lastUsedAt: now })
						.where(eq(apiKeys.id, row.id))
						.pipe(
							Effect.mapError(() =>
								AuthUnavailable.make({ dependency: "storage" }),
							),
						)
				return { userId: row.userId, tenantId: row.tenantId }
			}),
	})
})
export const layer = Layer.effect(ApiKeys, make)
