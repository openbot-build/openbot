import { SqlError } from "effect/sql"
import type { SettingsUnavailable } from "@openbot-build/domain/SettingsErrors"
import * as Model from "@openbot-build/domain/Access"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
	String as Str,
} from "effect"
import { Settings } from "../settings/Settings.ts"
import * as Failures from "../errors/Failures.ts"

export interface Identity {
	readonly providerId: string
	readonly issuer: string
	readonly subject: string
	readonly email: string
	readonly emailVerified: boolean
	readonly groups: unknown
	readonly claims?: Readonly<Record<string, unknown>>
	readonly invitation?: string
}
const denied = (reason: Model.AccessDenied["reason"]) =>
	Model.AccessDenied.make({ reason })
const conflict = (message: string) => Model.AccessConflict.make({ message })
type InternalError =
	| Model.AccessDenied
	| Model.AccessConflict
	| Model.AccessUnavailable
	| SettingsUnavailable
	| Schema.SchemaError
	| SqlError.SqlError
class AccessStorageError extends Schema.TaggedError<
	AccessStorageError,
	{ readonly brand: unique symbol }
>()("AccessStorageError", { cause: Schema.Defect() }) {}
const storageFailure = (error: unknown) =>
	Effect.fail(AccessStorageError.make({ cause: error })).pipe(
		Failures.replace("The account access store failed.", () =>
			Model.AccessUnavailable.make({}),
		),
	)
const protect = <A, R>(effect: Effect.Effect<A, InternalError, R>) =>
	effect.pipe(
		Effect.catchTags({
			SqlError: storageFailure,
			SchemaError: storageFailure,
			SettingsUnavailable: storageFailure,
		}),
	)
type Failure =
	Model.AccessDenied | Model.AccessConflict | Model.AccessUnavailable
interface Page<A> {
	readonly items: ReadonlyArray<A>
	readonly next: string | null
}
export interface Service {
	readonly registration: Effect.Effect<Model.Registration, Failure>
	readonly loginOptions: Effect.Effect<typeof Model.LoginOptions.Type, Failure>
	readonly provider: (id: string) => Effect.Effect<
		{
			readonly access: Model.ProviderAccess
			readonly issuer: string
			readonly organizationId: string | null
		},
		Failure
	>
	readonly validateProvider: (
		value: Model.ProviderAccess,
		organizationId?: string,
	) => Effect.Effect<void, Failure>
	readonly check: (identity: Identity) => Effect.Effect<void, Failure>
	readonly sync: (
		userId: string,
		identity: Identity,
	) => Effect.Effect<void, Failure>
	readonly active: (
		userId: string,
		issuedAt?: number,
	) => Effect.Effect<boolean, Failure>
	readonly emailRate: (key: string, max: number) => Effect.Effect<void, Failure>
	readonly emailAccount: (email: string) => Effect.Effect<void, Failure>
	readonly bindEmail: (
		userId: string,
		email: string,
	) => Effect.Effect<void, Failure>
	readonly record: (
		action: string,
		actor: string,
		subject: string,
	) => Effect.Effect<void, Failure>
	readonly users: (
		after: string | undefined,
		limit: number,
	) => Effect.Effect<Page<typeof Model.User.Type>, Failure>
	readonly updateUser: (
		userId: string,
		status: typeof Model.AccountStatus.Type,
		actor: string,
	) => Effect.Effect<void, Failure>
	readonly requests: (
		after: string | undefined,
		limit: number,
	) => Effect.Effect<Page<typeof Model.Request.Type>, Failure>
	readonly decide: (
		id: string,
		version: number,
		status: "approved" | "rejected",
		actor: string,
	) => Effect.Effect<void, Failure>
	readonly grants: (
		after: string | undefined,
		limit: number,
	) => Effect.Effect<Page<typeof Model.Grant.Type>, Failure>
	readonly grant: (
		email: string,
		providerId: string,
		actor: string,
		remove?: boolean,
	) => Effect.Effect<void, Failure>
	readonly audit: (
		after: string | undefined,
		limit: number,
	) => Effect.Effect<Page<typeof Model.Event.Type>, Failure>
}

export const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const settings = yield* Settings
	const crypto = yield* Crypto.Crypto
	const newId = crypto.randomUUIDv7().pipe(Effect.orDie)
	const registration = settings.platform.pipe(
		Effect.flatMap((p) =>
			Option.isSome(p)
				? Effect.succeed(p.value.document.registration ?? Model.defaults)
				: Effect.fail(Model.AccessUnavailable.make({})),
		),
	)
	const record = (action: string, actor: string, subject: string) =>
		Effect.gen(function* () {
			const id = yield* newId
			const now = yield* Clock.currentTimeMillis
			yield* sql`insert into openbot_access_events (id, action, actor, subject, created_at) values (${id}, ${action}, ${actor}, ${subject}, ${now})`
		})
	const active = (userId: string, issuedAt?: number) =>
		sql<{
			status: string
			revokedAt: number | null
		}>`select status, revoked_at::float8 as "revokedAt" from openbot_account_states where user_id = ${userId}`.pipe(
			Effect.map(
				(rows) =>
					rows[0]?.status !== "suspended" &&
					(issuedAt === undefined ||
						rows[0]?.revokedAt == null ||
						issuedAt > rows[0].revokedAt),
			),
		)
	const provider = (id: string) =>
		Effect.gen(function* () {
			if (id === "email") {
				const platform = yield* settings.platform
				if (
					Option.isNone(platform) ||
					platform.value.document.registration?.emailSignIn !== true ||
					platform.value.document.mail == null
				)
					return yield* denied("closed")
				return {
					access: Model.providerDefaults,
					issuer: platform.value.document.publicOrigin,
					organizationId: null as string | null,
				}
			}
			if (id === "oidc") {
				const platform = yield* settings.platform
				if (
					Option.isNone(platform) ||
					platform.value.document.identityProvider === null
				)
					return yield* denied("identity")
				return {
					access: (platform.value.document.registration ?? Model.defaults)
						.provider,
					issuer: platform.value.document.identityProvider.issuer,
					organizationId: null as string | null,
				}
			}
			const [row] = yield* sql<{
				access: string
				issuer: string
				organizationId: string
			}>`select c.access, c.issuer, c.organization_id as "organizationId" from openbot_sso_connections c join openbot_organizations o on o.id = c.organization_id where c.id = ${id} and o.status = 'active'`
			if (row === undefined) return yield* denied("identity")
			return {
				...row,
				access: yield* Schema.decodeEffect(
					Schema.fromJsonString(Model.ProviderAccess),
				)(row.access),
			}
		})
	const groups = (access: Model.ProviderAccess, value: unknown) => {
		if (access.groupsClaim === null)
			return access.mappings.length > 0 || access.requiredGroups.length > 0
				? Effect.fail(denied("groups"))
				: Effect.succeed<ReadonlyArray<string>>([])
		const decoded = Schema.decodeUnknownOption(Schema.Array(Schema.String))(
			value,
		)
		return Effect.fromOption(decoded).pipe(
			Effect.catchTag("NoSuchElementError", () =>
				Effect.fail(denied("groups")),
			),
		)
	}
	const validateProvider = (
		access: Model.ProviderAccess,
		organizationId?: string,
	) =>
		Effect.gen(function* () {
			if (
				(access.mappings.length > 0 || access.requiredGroups.length > 0) &&
				access.groupsClaim === null
			)
				return yield* conflict("Set a groups claim first.")
			if (organizationId !== undefined && access.trusted)
				return yield* conflict(
					"Only the platform can trust a provider for first access.",
				)
			for (const mapping of access.mappings) {
				if (
					organizationId !== undefined &&
					mapping.organizationId !== organizationId
				)
					return yield* conflict(
						"A connection may grant roles only in its organization.",
					)
				if (mapping.roles.includes("super_administrator"))
					return yield* conflict("Grant the Super Administrator role by hand.")
				const [organization] =
					yield* sql`select id from openbot_organizations where id = ${mapping.organizationId}`
				if (organization === undefined)
					return yield* conflict("The mapped organization does not exist.")
				for (const role of mapping.roles) {
					if (Str.startsWith("role_")(role)) {
						const [found] =
							yield* sql`select id from openbot_roles where id = ${role} and organization_id = ${mapping.organizationId}`
						if (found === undefined)
							return yield* conflict(
								"The mapped role does not exist in this organization.",
							)
					}
				}
			}
		})
	const check = (identity: Identity) =>
		Effect.gen(function* () {
			const policy = yield* registration
			const config = yield* provider(identity.providerId)
			if (config.issuer !== identity.issuer) return yield* denied("identity")
			const values = yield* groups(
				config.access,
				identity.claims === undefined
					? identity.groups
					: config.access.groupsClaim === null
						? undefined
						: identity.claims[config.access.groupsClaim],
			)
			if (
				config.access.requiredGroups.length > 0 &&
				!Arr.some(config.access.requiredGroups, (g) => values.includes(g))
			)
				return yield* denied("groups")
			const email = Str.toLowerCase(identity.email)
			if (identity.subject.length === 0 || email.length === 0)
				return yield* denied("identity")
			if (identity.providerId !== "oidc" && identity.providerId !== "email") {
				const [domain] =
					yield* sql`select id from openbot_sso_connections where id = ${identity.providerId} and domains::jsonb ? ${Str.split(email, "@").at(-1) ?? ""}`
				if (domain === undefined) return yield* denied("domain")
			}
			let invited = false
			if (identity.invitation !== undefined) {
				const now = yield* Clock.currentTimeMillis
				const [invite] =
					yield* sql`select i.id from openbot_invitations i join openbot_organizations o on o.id = i.organization_id where i.id = ${identity.invitation} and i.target = 'organization' and i.status = 'pending' and i.email = ${email} and i.expires_at > ${now} and o.status = 'active'`
				if (invite === undefined || !identity.emailVerified)
					return yield* denied("invitation")
				invited = true
			}
			const [existing] = yield* sql<{
				userId: string
			}>`select user_id as "userId" from openbot_auth_account where provider_id = ${identity.providerId} and account_id = ${identity.subject}`
			if (existing !== undefined) {
				if (!(yield* active(existing.userId))) return yield* denied("suspended")
				return
			}
			if (!identity.emailVerified) return yield* denied("identity")
			if (identity.providerId === "email") {
				const [collision] =
					yield* sql`select id from openbot_auth_user where lower(email) = ${email}`
				if (collision !== undefined) return yield* denied("identity")
			}
			const [bootstrap] =
				yield* sql`select email from openbot_platform_admins where email = ${email} and provider_id = ${identity.providerId} and user_id is null`
			const [grant] =
				yield* sql`select email from openbot_user_grants where email = ${email} and provider_id = ${identity.providerId}`
			const domain = Str.split(email, "@").at(-1) ?? ""
			if (
				policy.allowedEmailDomains.length > 0 &&
				!policy.allowedEmailDomains.includes(domain) &&
				!(invited && policy.allowExternalInvitations)
			)
				return yield* denied("domain")
			if (bootstrap !== undefined || grant !== undefined) return
			const trustedSso =
				identity.providerId === "oidc"
					? config.access.trusted
					: identity.providerId !== "email" &&
						policy.trustedSsoProviders.includes(identity.providerId)
			const source = invited
				? "invitations"
				: trustedSso
					? "sso"
					: "selfService"
			const mode = policy[source]
			if (mode === "closed") return yield* denied("closed")
			const [previous] = yield* sql<{
				status: string
			}>`select status from openbot_registration_requests where provider_id = ${identity.providerId} and issuer = ${identity.issuer} and subject = ${identity.subject}`
			if (previous?.status === "rejected") return yield* denied("rejected")
			if (mode === "allow" || previous?.status === "approved") return
			const id = yield* newId
			const now = yield* Clock.currentTimeMillis
			const created =
				yield* sql`insert into openbot_registration_requests (id, provider_id, issuer, subject, email, source, status, version, created_at) values (${id}, ${identity.providerId}, ${identity.issuer}, ${identity.subject}, ${email}, ${source}, 'pending', 1, ${now}) on conflict (provider_id, issuer, subject) do nothing returning id`
			if (created.length > 0)
				yield* record("registration.requested", "sign-in", id)
			return yield* denied("pending")
		})
	const sync = (userId: string, identity: Identity) =>
		sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`select pg_advisory_xact_lock(hashtextextended(${"openbot-access:" + userId}, 0))`
				if (!(yield* active(userId))) return yield* denied("suspended")
				const config = yield* provider(identity.providerId)
				if (config.issuer !== identity.issuer) return yield* denied("identity")
				const values = yield* groups(
					config.access,
					identity.claims === undefined
						? identity.groups
						: config.access.groupsClaim === null
							? undefined
							: identity.claims[config.access.groupsClaim],
				)
				if (
					config.access.requiredGroups.length > 0 &&
					!Arr.some(config.access.requiredGroups, (g) => values.includes(g))
				)
					return yield* denied("groups")
				const previous = yield* sql<{
					organizationId: string
					role: string
				}>`select organization_id as "organizationId", role from openbot_mapped_roles where user_id = ${userId} and provider_id = ${identity.providerId}`
				yield* sql`delete from openbot_mapped_roles where user_id = ${userId} and provider_id = ${identity.providerId}`
				const matched = Arr.filter(config.access.mappings, (m) =>
					values.includes(m.group),
				)
				for (const mapping of matched) {
					yield* validateProvider(
						{ ...config.access, mappings: [mapping] },
						config.organizationId ?? undefined,
					)
					yield* sql`select pg_advisory_xact_lock(hashtextextended(${"openbot-members:" + mapping.organizationId}, 0))`
					const now = yield* Clock.currentTimeMillis
					yield* sql`insert into openbot_members (organization_id, user_id, email, name, status, roles, policy, joined_at) select ${mapping.organizationId}, id, email, name, 'active', '[]', '{"_tag":"Rules","algorithm":"denyOverrides","rules":[]}', ${now} from openbot_auth_user where id = ${userId} on conflict (organization_id, user_id) do nothing`
					for (const role of mapping.roles)
						yield* sql`insert into openbot_mapped_roles (provider_id, organization_id, user_id, role) values (${identity.providerId}, ${mapping.organizationId}, ${userId}, ${role}) on conflict do nothing`
				}
				if (previous.length > 0 || matched.length > 0)
					yield* record("roles.synced", userId, identity.providerId)
				yield* sql`delete from openbot_user_grants where email = ${Str.toLowerCase(identity.email)} and provider_id = ${identity.providerId}`
			}),
		)
	const page = <A extends { readonly id: string }>(
		rows: ReadonlyArray<A>,
		limit: number,
	) => ({
		items: Arr.take(rows, limit),
		next: rows.length > limit ? rows[limit - 1]!.id : null,
	})
	return {
		loginOptions: protect(
			Effect.gen(function* () {
				const platform = yield* settings.platform
				const policy = yield* registration
				const [connection] =
					yield* sql`select id from openbot_sso_connections limit 1`
				return {
					selfService: policy.selfService,
					invitations: policy.invitations,
					emailSignIn:
						policy.emailSignIn &&
						Option.isSome(platform) &&
						platform.value.document.mail != null,
					oidc:
						(Option.isSome(platform) &&
							platform.value.document.identityProvider !== null) ||
						connection !== undefined,
				}
			}),
		),
		emailRate: (key: string, max: number) =>
			protect(
				sql.withTransaction(
					Effect.gen(function* () {
						const id = "openbot-email-rate:" + key
						yield* sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`
						const now = yield* Clock.currentTimeMillis
						const [row] = yield* sql<{
							value: string
						}>`select value from openbot_auth_verification where identifier=${id} and expires_at > to_timestamp(${now}::double precision / 1000)`
						if (row !== undefined && Number(row.value) >= max)
							return yield* denied("rate_limited")
						if (row === undefined) {
							yield* sql`delete from openbot_auth_verification where identifier=${id}`
							yield* sql`insert into openbot_auth_verification (id,identifier,value,expires_at,updated_at) values (${yield* newId},${id},'1',to_timestamp(${now + 60000}::double precision / 1000),now())`
						} else
							yield* sql`update openbot_auth_verification set value=${String(Number(row.value) + 1)} where identifier=${id}`
					}),
				),
			),
		emailAccount: (email: string) =>
			protect(
				Effect.gen(function* () {
					const [user] = yield* sql<{
						id: string
						emailVerified: boolean
					}>`select id, email_verified as "emailVerified" from openbot_auth_user where lower(email)=${email}`
					if (user !== undefined) {
						const [account] =
							yield* sql`select id from openbot_auth_account where user_id=${user.id} and provider_id='email' and account_id=${email}`
						if (account === undefined || !user.emailVerified)
							return yield* denied("identity")
					}
				}),
			),
		bindEmail: (userId: string, email: string) =>
			protect(
				sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`select pg_advisory_xact_lock(hashtextextended(${"openbot-access:" + userId}, 0))`
						const [user] =
							yield* sql`select id from openbot_auth_user where id=${userId} and email=${email} and email_verified=true`
						const linked =
							yield* sql`select id from openbot_auth_account where user_id=${userId}`
						if (user === undefined || linked.length > 0)
							return yield* denied("identity")
						yield* sql`insert into openbot_auth_account (id,user_id,provider_id,account_id,updated_at) values (${yield* newId},${userId},'email',${email},now())`
					}),
				),
			),
		registration: protect(registration),
		provider: (id: string) => protect(provider(id)),
		validateProvider: (value: Model.ProviderAccess, org?: string) =>
			protect(validateProvider(value, org)),
		check: (identity: Identity) => protect(check(identity)),
		sync: (userId: string, identity: Identity) =>
			protect(sync(userId, identity)),
		active: (userId: string, issuedAt?: number) =>
			protect(active(userId, issuedAt)),
		record: (action: string, actor: string, subject: string) =>
			protect(record(action, actor, subject)),
		users: (after: string | undefined, limit: number) =>
			protect(
				Effect.gen(function* () {
					const rows =
						yield* sql`select u.id, u.email, u.name, coalesce(s.status,'active') as status, u.created_at::text as "createdAt" from openbot_auth_user u left join openbot_account_states s on s.user_id = u.id where u.id > ${after ?? ""} order by u.id limit ${limit + 1}`
					return page(
						yield* Schema.decodeUnknownEffect(Schema.Array(Model.User))(rows),
						limit,
					)
				}),
			),
		updateUser: (
			userId: string,
			status: typeof Model.AccountStatus.Type,
			actor: string,
		) =>
			protect(
				sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`select pg_advisory_xact_lock(hashtextextended('openbot-platform-admins', 0))`
						yield* sql`select pg_advisory_xact_lock(hashtextextended(${"openbot-access:" + userId}, 0))`
						const [user] =
							yield* sql`select id from openbot_auth_user where id = ${userId}`
						if (user === undefined)
							return yield* conflict("The account does not exist.")
						if (status === "suspended") {
							const admins = yield* sql<{
								userId: string
							}>`select a.user_id as "userId" from openbot_platform_admins a left join openbot_account_states s on s.user_id = a.user_id where a.user_id is not null and coalesce(s.status,'active') = 'active'`
							if (
								Arr.some(admins, (a) => a.userId === userId) &&
								admins.length <= 1
							)
								return yield* conflict(
									"Keep at least one active platform admin.",
								)
							yield* sql`delete from openbot_auth_session where user_id = ${userId}`
							yield* sql`delete from openbot_tokens where user_id = ${userId}`
						}
						const revokedAt =
							status === "suspended" ? yield* Clock.currentTimeMillis : null
						yield* sql`insert into openbot_account_states (user_id,status,revoked_at) values (${userId},${status},${revokedAt}) on conflict (user_id) do update set status = excluded.status, revoked_at = coalesce(excluded.revoked_at, openbot_account_states.revoked_at)`
						yield* record("account." + status, actor, userId)
					}),
				),
			),
		requests: (after: string | undefined, limit: number) =>
			protect(
				Effect.gen(function* () {
					const rows =
						yield* sql`select id,provider_id as "providerId",email,source,status,version,created_at::float8 as "createdAt" from openbot_registration_requests where id > ${after ?? ""} order by id limit ${limit + 1}`
					return page(
						yield* Schema.decodeUnknownEffect(Schema.Array(Model.Request))(
							rows,
						),
						limit,
					)
				}),
			),
		decide: (
			id: string,
			version: number,
			status: "approved" | "rejected",
			actor: string,
		) =>
			protect(
				sql.withTransaction(
					Effect.gen(function* () {
						const changed =
							yield* sql`update openbot_registration_requests set status=${status}, version=version+1 where id=${id} and version=${version} returning id`
						if (changed.length === 0)
							return yield* conflict("The request changed. Read it again.")
						yield* record("registration." + status, actor, id)
					}),
				),
			),
		grants: (after: string | undefined, limit: number) =>
			protect(
				Effect.gen(function* () {
					const rows =
						yield* sql`select email, provider_id as "providerId", created_at::float8 as "createdAt" from openbot_user_grants where email || ':' || provider_id > ${after ?? ""} order by email || ':' || provider_id limit ${limit + 1}`
					const decoded = yield* Schema.decodeUnknownEffect(
						Schema.Array(Model.Grant),
					)(rows)
					const items = Arr.take(decoded, limit)
					const last = items.at(-1)
					return {
						items,
						next:
							decoded.length > limit && last !== undefined
								? last.email + ":" + last.providerId
								: null,
					}
				}),
			),
		grant: (email: string, providerId: string, actor: string, remove = false) =>
			protect(
				sql.withTransaction(
					Effect.gen(function* () {
						if (!remove) yield* provider(providerId)
						if (remove)
							yield* sql`delete from openbot_user_grants where email=${Str.toLowerCase(email)} and provider_id=${providerId}`
						else {
							const now = yield* Clock.currentTimeMillis
							yield* sql`insert into openbot_user_grants (email,provider_id,created_at) values (${Str.toLowerCase(email)},${providerId},${now}) on conflict do nothing`
						}
						yield* record(
							remove ? "grant.revoked" : "grant.created",
							actor,
							Str.toLowerCase(email),
						)
					}),
				),
			),
		audit: (after: string | undefined, limit: number) =>
			protect(
				Effect.gen(function* () {
					const rows =
						yield* sql`select id,action,actor,subject,created_at::float8 as "createdAt" from openbot_access_events where id > ${after ?? ""} order by id limit ${limit + 1}`
					return page(
						yield* Schema.decodeUnknownEffect(Schema.Array(Model.Event))(rows),
						limit,
					)
				}),
			),
	}
})
export class Access extends Context.Service<Access, Service>()(
	"@openbot-build/openbot/access/Access",
) {}
export const layer = Layer.effect(Access, make)
