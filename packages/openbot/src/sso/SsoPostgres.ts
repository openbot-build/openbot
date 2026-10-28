import { Sso as SsoModel } from "@openbot-build/domain"

import {
	Array as Arr,
	Cause,
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
import { Base64Url } from "effect/encoding"
import { SqlError } from "effect/sql"
import { and, asc, eq, isNotNull, ne } from "drizzle-orm"
import * as Failures from "../errors/Failures.ts"
import * as Report from "../errors/Report.ts"
import { DomainControl } from "../apps/DomainControl.ts"
import { openbot_auth_account } from "../database/AuthSchema.ts"
import { organizationDomains, ssoConnections } from "../database/Schema.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"
import { signInScope } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import { type Connection, recordName, Sso } from "./Sso.ts"
import * as Db from "../database/Database.ts"

const Domains = Schema.fromJsonString(Schema.Array(Schema.String))
const unavailable = (message: string) =>
	Failures.replace(message, () => SsoModel.SsoUnavailable.make({}))
/** The extra data that seals the client secret of a connection to its row. */
const binding = (id: string) =>
	"openbot_sso_connections:" + id + ":client_secret"
/** True when a unique index stopped the query. Drizzle keeps the `SqlError` in its cause. */
const isUniqueViolation = (error: { readonly cause: unknown }) =>
	Cause.isCause(error.cause) &&
	Option.exists(
		Cause.findErrorOption(error.cause),
		(failure) =>
			SqlError.isSqlError(failure) && failure.reason._tag === "UniqueViolation",
	)
/** The domains have their type already, so they always encode. */
const encodeDomains = (domains: ReadonlyArray<string>) =>
	Schema.encodeEffect(Domains)(domains).pipe(Effect.orDie)

const domainView = (
	row: typeof organizationDomains.$inferSelect,
): SsoModel.Domain => ({
	domain: row.domain,
	recordName: recordName(row.domain),
	recordValue: row.token,
	verifiedAt:
		row.verifiedAt === null
			? null
			: DateTime.formatIso(DateTime.makeUnsafe(row.verifiedAt)),
	createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.createdAt)),
})
/** A stored connection whose domains do not decode makes SSO unavailable. The log keeps the reason. */
const connection = (
	row: typeof ssoConnections.$inferSelect,
): Effect.Effect<Connection, SsoModel.SsoUnavailable> =>
	Schema.decodeEffect(Domains)(row.domains).pipe(
		unavailable("A stored SSO connection has bad domains."),
		Effect.map((domains) => ({
			id: row.id,
			organizationId: row.organizationId,
			name: row.name,
			issuer: row.issuer,
			clientId: row.clientId,
			clientSecret: row.clientSecret,
			clientSecretHint: row.clientSecretHint,
			domains,
			enforce: row.enforce,
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		})),
	)

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const control = yield* DomainControl
	const settings = yield* Settings
	const report = yield* Report.make
	const crypto = yield* Crypto.Crypto
	// A platform without secure random numbers is broken.
	const newId = crypto
		.randomUUIDv7()
		.pipe(Effect.orDie, Effect.map(Str.replaceAll("-", "")))
	const randomBytes = (size: number) =>
		crypto.randomBytes(size).pipe(Effect.orDie)
	/**
	 * Tells every instance, this one too, to read the connections again after a
	 * change. The notice is best-effort: the change is already saved, and
	 * BetterAuth also reads the connections again every 30 seconds. So a failed
	 * notice is logged, and the change still succeeds.
	 */
	const changed = settings.notify(signInScope).pipe(
		Effect.tapCauseIf(Cause.hasFails, (cause) =>
			report(
				"The instances could not learn that the SSO settings changed. They read them again within 30 seconds.",
				cause,
			),
		),
		Effect.orElseSucceed(() => undefined),
	)
	const sealSecret = (id: string, secret: string) =>
		secrets.seal(secret, binding(id)).pipe(
			unavailable(
				"The client secret of an SSO connection could not be sealed.",
			),
			Effect.map((sealed) => ({
				clientSecret: sealed,
				clientSecretHint: hint(secret),
			})),
		)

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
				unavailable("A domain could not be read."),
				Effect.flatMap(([row]) =>
					row === undefined
						? Effect.fail(SsoModel.DomainNotFound.make({ domain }))
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
				unavailable(
					"The SSO connections of an organization could not be read.",
				),
				Effect.flatMap((rows) => Effect.forEach(rows, connection)),
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
				.pipe(
					unavailable(
						"The verified domains of an organization could not be read.",
					),
				)
			for (const domain of domains)
				if (!Arr.some(verified, (row) => row.domain === domain))
					return yield* SsoModel.SsoConnectionInvalid.make({
						message: `Verify the domain ${domain} first.`,
					})
			const others = Arr.filter(
				yield* listConnections(organizationId),
				(other) => other.id !== except,
			)
			for (const domain of domains)
				if (Arr.some(others, (other) => other.domains.includes(domain)))
					return yield* SsoModel.SsoConnectionInvalid.make({
						message: `Another SSO connection already uses the domain ${domain}.`,
					})
		})

	return Sso.of({
		listDomains: (organizationId) =>
			db
				.select()
				.from(organizationDomains)
				.where(eq(organizationDomains.organizationId, organizationId))
				.orderBy(asc(organizationDomains.domain))
				.pipe(
					Effect.map(Arr.map(domainView)),
					unavailable("The domains of an organization could not be read."),
				),
		addDomain: (organizationId, domain) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const row = {
					organizationId,
					domain,
					token:
						"openbot-verification=" + Base64Url.encode(yield* randomBytes(32)),
					verifiedAt: null,
					createdAt: now,
				}
				yield* db
					.insert(organizationDomains)
					.values(row)
					.onConflictDoNothing()
					.pipe(unavailable("A domain could not be added."))
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
					.pipe(
						unavailable(
							"OpenBot could not check if another organization verified a domain.",
						),
					)
				if (taken !== undefined)
					return yield* SsoModel.DomainTaken.make({ domain })
				const tokens = yield* control
					.tokens(domain)
					.pipe(unavailable("The TXT records of a domain could not be read."))
				if (!tokens.includes(row.token))
					return yield* SsoModel.DomainNotVerified.make({ domain })
				const now = yield* Clock.currentTimeMillis
				// The unique index stops two organizations that verify at the same time.
				const [updated] = yield* db
					.update(organizationDomains)
					.set({ verifiedAt: now })
					.where(domainWhere(organizationId, domain))
					.returning()
					.pipe(
						Effect.catchTag(
							"EffectDrizzleQueryError",
							(
								error,
							): Effect.Effect<
								never,
								SsoModel.DomainTaken | SsoModel.SsoUnavailable
							> =>
								isUniqueViolation(error)
									? Effect.fail(SsoModel.DomainTaken.make({ domain }))
									: Effect.fail(error).pipe(
											unavailable("A domain could not be marked as verified."),
										),
						),
					)
				if (updated === undefined)
					return yield* SsoModel.DomainNotFound.make({ domain })
				yield* changed
				return domainView(updated)
			}),
		removeDomain: (organizationId, domain) =>
			Effect.gen(function* () {
				yield* findDomain(organizationId, domain)
				const used = Arr.some(
					yield* listConnections(organizationId),
					(connection) => connection.domains.includes(domain),
				)
				if (used) return yield* SsoModel.DomainInUse.make({ domain })
				yield* db
					.delete(organizationDomains)
					.where(domainWhere(organizationId, domain))
					.pipe(unavailable("A domain could not be removed."))
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
					unavailable("An SSO connection could not be read."),
					Effect.flatMap((rows) =>
						Effect.transposeOption(Option.map(Arr.head(rows), connection)),
					),
				),
		createConnection: (organizationId, input) =>
			Effect.gen(function* () {
				yield* checkDomains(organizationId, input.domains)
				const now = yield* Clock.currentTimeMillis
				const id = "sso_" + (yield* newId)
				const row = {
					id,
					organizationId,
					name: Str.trim(input.name),
					issuer: input.issuer,
					clientId: input.clientId,
					...(input.clientSecret === undefined
						? { clientSecret: null, clientSecretHint: null }
						: yield* sealSecret(id, Redacted.value(input.clientSecret))),
					domains: yield* encodeDomains(input.domains),
					enforce: input.enforce,
					version: 1,
					createdAt: now,
					updatedAt: now,
				}
				yield* db
					.insert(ssoConnections)
					.values(row)
					.pipe(unavailable("An SSO connection could not be created."))
				yield* changed
				return yield* connection(row)
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
					.pipe(unavailable("An SSO connection could not be read."))
				if (row === undefined)
					return yield* SsoModel.SsoConnectionNotFound.make({
						connectionId: id,
					})
				if (row.version !== patch.expectedVersion)
					return yield* SsoModel.SsoConnectionConflict.make({
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
							: yield* sealSecret(id, Redacted.value(patch.clientSecret))
				const [updated] = yield* db
					.update(ssoConnections)
					.set({
						...(patch.name === undefined ? {} : { name: Str.trim(patch.name) }),
						...(patch.issuer === undefined ? {} : { issuer: patch.issuer }),
						...(patch.clientId === undefined
							? {}
							: { clientId: patch.clientId }),
						...secret,
						...(patch.domains === undefined
							? {}
							: { domains: yield* encodeDomains(patch.domains) }),
						...(patch.enforce === undefined ? {} : { enforce: patch.enforce }),
						version: row.version + 1,
						updatedAt: now,
					})
					// The version check makes a parallel change fail instead of winning.
					.where(and(where, eq(ssoConnections.version, row.version)))
					.returning()
					.pipe(unavailable("An SSO connection could not be changed."))
				if (updated === undefined)
					return yield* SsoModel.SsoConnectionConflict.make({
						version: row.version + 1,
					})
				yield* changed
				return yield* connection(updated)
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
					.pipe(unavailable("An SSO connection could not be deleted."))
				if (deleted.length === 0)
					return yield* SsoModel.SsoConnectionNotFound.make({
						connectionId: id,
					})
				yield* changed
			}),
		all: db
			.select()
			.from(ssoConnections)
			.orderBy(asc(ssoConnections.createdAt))
			.pipe(
				unavailable("The SSO connections could not be read."),
				Effect.flatMap((rows) => Effect.forEach(rows, connection)),
			),
		openSecret: (value) =>
			value.clientSecret === null
				? Effect.succeedNone
				: secrets.open(value.clientSecret, binding(value.id)).pipe(
						Effect.map((secret) => Option.some(Redacted.make(secret))),
						unavailable(
							"The client secret of an SSO connection could not be opened.",
						),
					),
		providerOf: (userId) =>
			db
				.select({ providerId: openbot_auth_account.providerId })
				.from(openbot_auth_account)
				.where(eq(openbot_auth_account.userId, userId))
				.limit(1)
				.pipe(
					Effect.map((rows) => Option.fromNullishOr(rows[0]?.providerId)),
					unavailable("The sign-in provider of a user could not be read."),
				),
	})
})

export const layer = Layer.effect(Sso, make)
