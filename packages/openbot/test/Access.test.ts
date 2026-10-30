import { Array as Arr } from "effect"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Authorization } from "@openbot-build/domain"
import * as Model from "@openbot-build/domain/Access"
import { Context, Effect, Layer, Option, Redacted, Ref } from "effect"
import * as Access from "../src/access/Access.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import { Settings } from "../src/settings/Settings.ts"
import type { PlatformDocument } from "../src/settings/Documents.ts"
import * as OrganizationPostgres from "../src/organization/OrganizationPostgres.ts"
import { Organization } from "../src/organization/Organization.ts"
import { AuditLog } from "../src/audit/AuditLog.ts"
import * as PostgresTest from "./PostgresTest.ts"

const identity: Access.Identity = {
	providerId: "oidc",
	issuer: "https://id.example.com",
	subject: "first",
	email: "first@example.com",
	emailVerified: true,
	groups: undefined,
}
const fixture = Effect.gen(function* () {
	const database = yield* PostgresTest.start
	const databaseLayer = DatabasePostgres.layer({
		databaseUrl: Redacted.make(database.url),
	})
	yield* DatabasePostgres.migrate.pipe(Effect.provide(databaseLayer))
	// The migration runner can run again without changing rows or policy.
	yield* DatabasePostgres.migrate.pipe(Effect.provide(databaseLayer))
	const policy = yield* Ref.make<Model.Registration>(Model.defaults)
	const base: PlatformDocument = {
		publicOrigin: "https://openbot.example.com",
		authSecret: "unused",
		identityProvider: {
			issuer: identity.issuer,
			clientId: "test",
			clientSecret: null,
			clientSecretHint: null,
		},
		organizationCreation: "platform_admins",
		ceiling: Authorization.emptyPolicy,
		appRestrictions: [],
	}
	const settings = Layer.mock(Settings, {
		platform: Ref.get(policy).pipe(
			Effect.map((registration) =>
				Option.some({
					document: { ...base, registration },
					version: 1,
					updatedAt: 0,
				}),
			),
		),
	})
	const services = yield* Layer.build(
		Layer.merge(Access.layer, OrganizationPostgres.layer).pipe(
			Layer.provide(settings),
			Layer.provide(Layer.mock(AuditLog, {})),
			Layer.provideMerge(databaseLayer),
		),
	)
	const access = Context.get(services, Access.Access)
	const organization = Context.get(services, Organization)
	const sql = Context.get(services, PgClient.PgClient)
	yield* sql`insert into openbot_organizations (id,name,status,created_at) values ('org_one','One','active',0),('org_two','Two','active',0)`
	const user = (id: string, email = id + "@example.com", provider = "oidc") =>
		Effect.gen(function* () {
			yield* sql`insert into openbot_auth_user (id,name,email,email_verified) values (${id},${id},${email},true)`
			yield* sql`insert into openbot_auth_account (id,account_id,provider_id,user_id,updated_at) values (${id},${id},${provider},${id},now())`
		})
	const invite = (
		id: string,
		email: string,
		target = "organization",
		expires = 9999999999999,
	) =>
		sql`insert into openbot_invitations (id,organization_id,target,email,roles,status,invited_by,created_at,expires_at) values (${id},'org_one',${target},${email},'["member"]','pending','admin',0,${expires})`
	return { access, organization, sql, policy, user, invite }
})
const denied = <A>(
	effect: Effect.Effect<
		A,
		Model.AccessDenied | Model.AccessConflict | Model.AccessUnavailable
	>,
	reason: Model.AccessDenied["reason"],
) =>
	Effect.gen(function* () {
		const result = yield* Effect.result(effect)
		assert.strictEqual(result._tag, "Failure")
		if (result._tag === "Failure") {
			assert.strictEqual(result.failure._tag, "AccessDenied")
			if (result.failure._tag === "AccessDenied")
				assert.strictEqual(result.failure.reason, reason)
		}
	})

it.live(
	"new accounts need an invite, a grant or the setup identity; old accounts can sign in",
	() =>
		Effect.gen(function* () {
			const { access, sql, user, invite } = yield* fixture
			yield* denied(access.check(identity), "closed")
			yield* user("first")
			yield* access.check(identity)
			yield* denied(
				access.check({ ...identity, subject: "other-provider" }),
				"closed",
			)
			yield* sql`insert into openbot_platform_admins (email,user_id,added_at) values ('admin@example.com',null,0)`
			yield* access.check({
				...identity,
				subject: "admin",
				email: "admin@example.com",
			})
			yield* denied(
				access.check({
					...identity,
					subject: "admin",
					email: "admin@example.com",
					emailVerified: false,
				}),
				"identity",
			)
			yield* access.grant("new@example.com", "oidc", "admin")
			yield* access.check({
				...identity,
				subject: "new",
				email: "new@example.com",
			})
			yield* invite("invite", "guest@example.com")
			yield* access.check({
				...identity,
				subject: "guest",
				email: "guest@example.com",
				invitation: "invite",
			})
			yield* denied(
				access.check({ ...identity, invitation: "missing" }),
				"invitation",
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"each source has closed, direct and approval modes, with one request per stable identity",
	() =>
		Effect.gen(function* () {
			const { access, policy, sql, invite } = yield* fixture
			yield* invite("valid", identity.email)
			for (const source of ["selfService", "invitations", "sso"] as const) {
				const person = {
					...identity,
					subject: source,
					...(source === "invitations" ? { invitation: "valid" } : {}),
				}
				for (const mode of ["closed", "approval", "allow"] as const) {
					yield* Ref.set(policy, {
						...Model.defaults,
						[source]: mode,
						provider: { ...Model.providerDefaults, trusted: source === "sso" },
					})
					if (mode === "closed") yield* denied(access.check(person), "closed")
					else if (mode === "approval") {
						yield* Effect.all(
							[
								denied(access.check(person), "pending"),
								denied(access.check(person), "pending"),
							],
							{ concurrency: 2 },
						)
						const requests = Arr.filter(
							(yield* access.requests(undefined, 100)).items,
							(r) => r.source === source,
						)
						assert.strictEqual(requests.length, 1)
						const request = requests[0]!
						const decisions = yield* Effect.all(
							[
								access
									.decide(request.id, request.version, "approved", "admin")
									.pipe(Effect.result),
								access
									.decide(request.id, request.version, "rejected", "admin")
									.pipe(Effect.result),
							],
							{ concurrency: 2 },
						)
						assert.strictEqual(
							Arr.filter(decisions, (r) => r._tag === "Success").length,
							1,
						)
						yield* access.decide(request.id, 2, "rejected", "admin")
						yield* denied(access.check(person), "rejected")
						yield* access.decide(request.id, 3, "approved", "admin")
						yield* access.check(person)
						yield* Ref.update(policy, (p) => ({ ...p, [source]: "closed" }))
						yield* denied(access.check(person), "closed")
					} else yield* access.check(person)
				}
			}
			assert.strictEqual(
				(yield* sql`select id from openbot_auth_user`).length,
				0,
			)
			assert.strictEqual(
				(yield* sql`select id from openbot_auth_session`).length,
				0,
			)
			assert.strictEqual(
				(yield* sql`select user_id from openbot_members`).length,
				0,
			)
			assert.ok((yield* access.audit(undefined, 100)).items.length >= 9)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"invite errors never fall back and domains match the whole verified domain",
	() =>
		Effect.gen(function* () {
			const { access, policy, sql, invite } = yield* fixture
			yield* Ref.set(policy, {
				...Model.defaults,
				selfService: "allow",
				allowedEmailDomains: ["example.com"],
			})
			yield* invite("expired", identity.email, "organization", 1)
			yield* invite("bot", identity.email, "bot")
			yield* invite("wrong", "other@example.com")
			for (const invitation of ["missing", "expired", "bot", "wrong"])
				yield* denied(access.check({ ...identity, invitation }), "invitation")
			yield* denied(
				access.check({ ...identity, email: "first@sub.example.com" }),
				"domain",
			)
			yield* denied(
				access.check({ ...identity, emailVerified: false }),
				"identity",
			)
			yield* invite("outside", "guest@outside.com")
			const guest = {
				...identity,
				email: "guest@outside.com",
				invitation: "outside",
			}
			yield* denied(access.check(guest), "domain")
			yield* Ref.update(policy, (p) => ({
				...p,
				allowExternalInvitations: true,
			}))
			yield* access.check(guest)
			yield* sql`update openbot_invitations set status='revoked' where id='outside'`
			yield* denied(access.check(guest), "invitation")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"group roles change on sign-in, preserve hand grants and cannot restore a suspended member",
	() =>
		Effect.gen(function* () {
			const { access, organization, policy, sql, user } = yield* fixture
			yield* user("first")
			const provider: Model.ProviderAccess = {
				...Model.providerDefaults,
				trusted: true,
				groupsClaim: "groups",
				requiredGroups: ["staff"],
				mappings: [
					{ group: "staff", organizationId: "org_one", roles: ["member"] },
					{
						group: "editors",
						organizationId: "org_two",
						roles: ["administrator"],
					},
				],
			}
			yield* Ref.set<Model.Registration>(policy, {
				...Model.defaults,
				sso: "allow",
				provider,
			})
			yield* denied(access.check(identity), "groups")
			yield* denied(access.check({ ...identity, groups: "staff" }), "groups")
			yield* denied(access.check({ ...identity, groups: ["Staff"] }), "groups")
			yield* access.check({ ...identity, groups: ["staff"] })
			yield* access.sync("first", { ...identity, groups: ["staff", "editors"] })
			assert.strictEqual((yield* organization.memberships("first")).length, 2)
			yield* sql`update openbot_members set roles='["auditor"]' where organization_id='org_one' and user_id='first'`
			yield* access.sync("first", { ...identity, groups: ["staff"] })
			const member = Option.getOrThrow(
				yield* organization.member("org_one", "first"),
			)
			assert.deepStrictEqual(member.manualRoles, ["auditor"])
			assert.deepStrictEqual(member.roles, ["auditor", "member"])
			assert.ok(
				Option.isNone(yield* organization.activeMember("org_two", "first")),
			)
			yield* sql`update openbot_members set status='suspended' where organization_id='org_one' and user_id='first'`
			yield* access.sync("first", { ...identity, groups: ["staff"] })
			assert.ok(
				Option.isNone(yield* organization.activeMember("org_one", "first")),
			)
			const bad = yield* access
				.validateProvider({
					...provider,
					mappings: [
						{
							group: "staff",
							organizationId: "org_one",
							roles: ["super_administrator"],
						},
					],
				})
				.pipe(Effect.result)
			assert.strictEqual(bad._tag, "Failure")
			assert.strictEqual(
				(yield* access
					.validateProvider(provider, "org_one")
					.pipe(Effect.result))._tag,
				"Failure",
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)

it.live(
	"account suspension removes sessions and keys, keeps roles and protects the last active admin",
	() =>
		Effect.gen(function* () {
			const { access, sql, user } = yield* fixture
			yield* user("first")
			yield* user("second")
			yield* sql`insert into openbot_platform_admins (email,user_id,added_at) values ('first@example.com','first',0),('second@example.com','second',0)`
			yield* sql`insert into openbot_auth_session (id,token,expires_at,user_id,updated_at) values ('session','secret',now()+interval '1 day','first',now())`
			yield* sql`insert into openbot_tokens (id,organization_id,user_id,name,prefix,hash,policy,created_at) values ('00000000-0000-0000-0000-000000000001','org_one','first','test','test','hash','{}',0)`
			yield* access.updateUser("first", "suspended", "second")
			yield* denied(access.check(identity), "suspended")
			assert.strictEqual(
				(yield* sql`select id from openbot_auth_session`).length,
				0,
			)
			assert.strictEqual((yield* sql`select id from openbot_tokens`).length, 0)
			assert.strictEqual(
				(yield* access
					.updateUser("second", "suspended", "first")
					.pipe(Effect.result))._tag,
				"Failure",
			)
			yield* access.updateUser("first", "active", "second")
			yield* access.check(identity)
			assert.strictEqual(
				(yield* sql`select id from openbot_auth_session`).length,
				0,
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)
