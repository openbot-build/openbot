import { SsoApi } from "@openbot-build/api"
import {
	Clock,
	DateTime,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
} from "effect"
import { and, asc, eq, isNotNull, ne } from "drizzle-orm"
import { randomBytes, randomUUID } from "node:crypto"
import { DomainControl } from "../apps/DomainControl.ts"
import { openbot_auth_account } from "../database/AuthSchema.ts"
import { organizationDomains, ssoConnections } from "../database/Schema.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"
import { signInScope } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import { type Connection, recordName, Sso } from "./Sso.ts"
import * as Db from "../database/Database.ts"

const Domains = Schema.fromJsonString(Schema.Array(Schema.String))
const decodeDomains = Schema.decodeUnknownSync(Domains)
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))
const binding = (id: string) =>
	"openbot_sso_connections:" + id + ":client_secret"

const domainView = (
	row: typeof organizationDomains.$inferSelect,
): SsoApi.Domain => ({
	domain: row.domain,
	recordName: recordName(row.domain),
	recordValue: row.token,
	verifiedAt: row.verifiedAt === null ? null : iso(row.verifiedAt),
	createdAt: iso(row.createdAt),
})
const connection = (row: typeof ssoConnections.$inferSelect): Connection => ({
	id: row.id,
	organizationId: row.organizationId,
	name: row.name,
	issuer: row.issuer,
	clientId: row.clientId,
	clientSecret: row.clientSecret,
	clientSecretHint: row.clientSecretHint,
	domains: decodeDomains(row.domains),
	enforce: row.enforce,
	version: row.version,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const control = yield* DomainControl
	const settings = yield* Settings
	const unavailable = () => SsoApi.SsoUnavailable.make({})
	/** Every instance reads the connections again after a change. */
	const changed = settings
		.notify(signInScope)
		.pipe(Effect.mapError(unavailable))

	const domainWhere = (organizationId: string, domain: string) =>
		and(
			eq(organizationDomains.organizationId, organizationId),
			eq(organizationDomains.domain, domain),
		)
	const findDomain = (organizationId: string, domain: string) =>
		db
			.select()
			.from(organizationDomains)
			.where(domainWhere(organizationId, domain))
			.pipe(
				Effect.mapError(unavailable),
				Effect.flatMap(([row]) =>
					row === undefined
						? Effect.fail(SsoApi.DomainNotFound.make({ domain }))
						: Effect.succeed(row),
				),
			)
	const listConnections = (organizationId: string) =>
		db
			.select()
			.from(ssoConnections)
			.where(eq(ssoConnections.organizationId, organizationId))
			.orderBy(asc(ssoConnections.createdAt))
			.pipe(
				Effect.map((rows) => rows.map(connection)),
				Effect.mapError(unavailable),
			)

	/** Domains of a connection must be verified by its organization, and no other connection may use them. */
	const checkDomains = (
		organizationId: string,
		domains: ReadonlyArray<string>,
		except?: string,
	) =>
		Effect.gen(function* () {
			const verified = yield* db
				.select({ domain: organizationDomains.domain })
				.from(organizationDomains)
				.where(
					and(
						eq(organizationDomains.organizationId, organizationId),
						isNotNull(organizationDomains.verifiedAt),
					),
				)
				.pipe(Effect.mapError(unavailable))
			for (const domain of domains)
				if (!verified.some((row) => row.domain === domain))
					return yield* SsoApi.SsoConnectionInvalid.make({
						message: `Verify the domain ${domain} first.`,
					})
			const others = (yield* listConnections(organizationId)).filter(
				(other) => other.id !== except,
			)
			for (const domain of domains)
				if (others.some((other) => other.domains.includes(domain)))
					return yield* SsoApi.SsoConnectionInvalid.make({
						message: `Another SSO connection already uses the domain ${domain}.`,
					})
		})

	const sealSecret = (id: string, value: string) =>
		secrets.seal(value, binding(id)).pipe(Effect.mapError(unavailable))

	return Sso.of({
		listDomains: (organizationId) =>
			db
				.select()
				.from(organizationDomains)
				.where(eq(organizationDomains.organizationId, organizationId))
				.orderBy(asc(organizationDomains.domain))
				.pipe(
					Effect.map((rows) => rows.map(domainView)),
					Effect.mapError(unavailable),
				),
		addDomain: (organizationId, domain) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const row = {
					organizationId,
					domain,
					token:
						"openbot-verification=" + randomBytes(32).toString("base64url"),
					verifiedAt: null,
					createdAt: now,
				}
				yield* db
					.insert(organizationDomains)
					.values(row)
					.onConflictDoNothing()
					.pipe(Effect.mapError(unavailable))
				return domainView(yield* findDomain(organizationId, domain))
			}),
		verifyDomain: (organizationId, domain) =>
			Effect.gen(function* () {
				const row = yield* findDomain(organizationId, domain)
				if (row.verifiedAt !== null) return domainView(row)
				const [taken] = yield* db
					.select({ organizationId: organizationDomains.organizationId })
					.from(organizationDomains)
					.where(
						and(
							eq(organizationDomains.domain, domain),
							isNotNull(organizationDomains.verifiedAt),
							ne(organizationDomains.organizationId, organizationId),
						),
					)
					.pipe(Effect.mapError(unavailable))
				if (taken !== undefined)
					return yield* SsoApi.DomainTaken.make({ domain })
				const tokens = yield* control
					.tokens(domain)
					.pipe(Effect.mapError(unavailable))
				if (!tokens.includes(row.token))
					return yield* SsoApi.DomainNotVerified.make({ domain })
				const now = yield* Clock.currentTimeMillis
				// The unique index stops two organizations that verify at the same time.
				const [updated] = yield* db
					.update(organizationDomains)
					.set({ verifiedAt: now })
					.where(domainWhere(organizationId, domain))
					.returning()
					.pipe(Effect.mapError(() => SsoApi.DomainTaken.make({ domain })))
				if (updated === undefined)
					return yield* SsoApi.DomainNotFound.make({ domain })
				yield* changed
				return domainView(updated)
			}),
		removeDomain: (organizationId, domain) =>
			Effect.gen(function* () {
				yield* findDomain(organizationId, domain)
				const used = (yield* listConnections(organizationId)).some(
					(connection) => connection.domains.includes(domain),
				)
				if (used) return yield* SsoApi.DomainInUse.make({ domain })
				yield* db
					.delete(organizationDomains)
					.where(domainWhere(organizationId, domain))
					.pipe(Effect.mapError(unavailable))
				yield* changed
			}),
		listConnections,
		getConnection: (organizationId, id) =>
			db
				.select()
				.from(ssoConnections)
				.where(
					and(
						eq(ssoConnections.organizationId, organizationId),
						eq(ssoConnections.id, id),
					),
				)
				.pipe(
					Effect.map((rows) =>
						Option.map(Option.fromNullishOr(rows[0]), connection),
					),
					Effect.mapError(unavailable),
				),
		createConnection: (organizationId, input) =>
			Effect.gen(function* () {
				yield* checkDomains(organizationId, input.domains)
				const now = yield* Clock.currentTimeMillis
				const id = "sso_" + randomUUID().replaceAll("-", "")
				const row = {
					id,
					organizationId,
					name: input.name.trim(),
					issuer: input.issuer,
					clientId: input.clientId,
					clientSecret:
						input.clientSecret === undefined
							? null
							: yield* sealSecret(id, input.clientSecret),
					clientSecretHint:
						input.clientSecret === undefined ? null : hint(input.clientSecret),
					domains: JSON.stringify(input.domains),
					enforce: input.enforce,
					version: 1,
					createdAt: now,
					updatedAt: now,
				}
				yield* db
					.insert(ssoConnections)
					.values(row)
					.pipe(Effect.mapError(unavailable))
				yield* changed
				return connection(row)
			}),
		updateConnection: (organizationId, id, patch) =>
			Effect.gen(function* () {
				const where = and(
					eq(ssoConnections.organizationId, organizationId),
					eq(ssoConnections.id, id),
				)
				const [row] = yield* db
					.select()
					.from(ssoConnections)
					.where(where)
					.pipe(Effect.mapError(unavailable))
				if (row === undefined)
					return yield* SsoApi.SsoConnectionNotFound.make({ connectionId: id })
				if (row.version !== patch.expectedVersion)
					return yield* SsoApi.SsoConnectionConflict.make({
						version: row.version,
					})
				if (patch.domains !== undefined)
					yield* checkDomains(organizationId, patch.domains, id)
				const now = yield* Clock.currentTimeMillis
				const secret =
					patch.clientSecret === undefined
						? {}
						: patch.clientSecret === null
							? { clientSecret: null, clientSecretHint: null }
							: {
									clientSecret: yield* sealSecret(id, patch.clientSecret),
									clientSecretHint: hint(patch.clientSecret),
								}
				const [updated] = yield* db
					.update(ssoConnections)
					.set({
						...(patch.name === undefined ? {} : { name: patch.name.trim() }),
						...(patch.issuer === undefined ? {} : { issuer: patch.issuer }),
						...(patch.clientId === undefined
							? {}
							: { clientId: patch.clientId }),
						...secret,
						...(patch.domains === undefined
							? {}
							: { domains: JSON.stringify(patch.domains) }),
						...(patch.enforce === undefined ? {} : { enforce: patch.enforce }),
						version: row.version + 1,
						updatedAt: now,
					})
					// The version check makes a parallel change fail instead of winning.
					.where(and(where, eq(ssoConnections.version, row.version)))
					.returning()
					.pipe(Effect.mapError(unavailable))
				if (updated === undefined)
					return yield* SsoApi.SsoConnectionConflict.make({
						version: row.version + 1,
					})
				yield* changed
				return connection(updated)
			}),
		deleteConnection: (organizationId, id) =>
			Effect.gen(function* () {
				const deleted = yield* db
					.delete(ssoConnections)
					.where(
						and(
							eq(ssoConnections.organizationId, organizationId),
							eq(ssoConnections.id, id),
						),
					)
					.returning({ id: ssoConnections.id })
					.pipe(Effect.mapError(unavailable))
				if (deleted.length === 0)
					return yield* SsoApi.SsoConnectionNotFound.make({ connectionId: id })
				yield* changed
			}),
		all: db
			.select()
			.from(ssoConnections)
			.orderBy(asc(ssoConnections.createdAt))
			.pipe(
				Effect.map((rows) => rows.map(connection)),
				Effect.mapError(unavailable),
			),
		openSecret: (value) =>
			value.clientSecret === null
				? Effect.succeedNone
				: secrets.open(value.clientSecret, binding(value.id)).pipe(
						Effect.map((secret) => Option.some(Redacted.make(secret))),
						Effect.mapError(unavailable),
					),
		providerOf: (userId) =>
			db
				.select({ providerId: openbot_auth_account.providerId })
				.from(openbot_auth_account)
				.where(eq(openbot_auth_account.userId, userId))
				.limit(1)
				.pipe(
					Effect.map((rows) => Option.fromNullishOr(rows[0]?.providerId)),
					Effect.mapError(unavailable),
				),
	})
})

export const layer = Layer.effect(Sso, make)
