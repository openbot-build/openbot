import { assert, layer } from "@effect/vitest"
import {
	AuthApi,
	Authorization,
	OrganizationApi,
	Roles,
	Settings,
	SsoApi,
	UserTokensApi,
} from "@openbot-build/api"
import { Array as Arr, Effect, Layer, Ref, Schema, String as Str } from "effect"
import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	type HttpMethod,
} from "effect/http"
import { DomainControl } from "../src/apps/DomainControl.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Policies from "./Policies.ts"

const publicOrigin = "https://api.example.com"
const member = (userId: string) =>
	"/v1/organization/members/" + encodeURIComponent(userId)

const Organizations = Schema.Struct({
	items: Schema.Array(OrganizationApi.Organization),
})
const Members = Schema.Struct({
	items: Schema.Array(OrganizationApi.Member),
	next: Schema.NullOr(Schema.String),
})
const AuditLogs = Schema.Struct({
	items: Schema.Array(OrganizationApi.AuditLogEntry),
	next: Schema.NullOr(Schema.String),
})
const Invitations = Schema.Struct({
	items: Schema.Array(OrganizationApi.Invitation),
})
const Failure = Schema.Struct({ _tag: Schema.String })

/**
 * Reads the JSON body of an answer in the wire shape of a schema. It checks
 * the status, or that the status is 2xx when none is given.
 */
const json = <S extends Schema.Constraint, E, R>(
	schema: S,
	call: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
	status?: number,
) => Effect.flatMap(call, Caller.json(Schema.toEncoded(schema), status))

/** Reads the tag of an error answer. */
const tagOf = (response: HttpClientResponse.HttpClientResponse) =>
	Effect.map(
		HttpClientResponse.schemaBodyJson(Failure)(response),
		(failure) => failure._tag,
	)

/** Reads the JSON body of an answer, as JSON with no schema. */
const body = (call: Caller.Call) =>
	Effect.flatMap(call, (response) => response.json)

// The host is a real server with real time.
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"An account makes its own organization, and others join after a domain is verified",
		() =>
			Effect.gen(function* () {
				const records = yield* Ref.make<ReadonlyArray<string>>([])
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					domainControl: Layer.succeed(DomainControl, {
						tokens: () => Ref.get(records),
					}),
				})
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("alice")
				const organization = yield* json(
					OrganizationApi.Organization,
					account(alice.session, "/v1/organization"),
				)
				assert.strictEqual(organization.id, alice.identity.organizationId)
				assert.strictEqual(organization.status, "active")
				const self = yield* json(
					OrganizationApi.Member,
					account(alice.session, member(alice.identity.userId)),
				)
				assert.deepStrictEqual(self.roles, ["super_administrator"])

				// Bob has a verified email in the same domain, but nobody verified the domain.
				const bob = yield* host.login("bob")
				assert.notStrictEqual(
					bob.identity.organizationId,
					alice.identity.organizationId,
				)

				// A domain does nothing until its TXT record proves control.
				const added = yield* json(
					SsoApi.Domain,
					account(alice.session, "/v1/organization/domains", "POST", {
						domain: "example.com",
					}),
				)
				assert.strictEqual(
					added.recordName,
					"_openbot-verification.example.com",
				)
				assert.strictEqual(added.verifiedAt, null)
				const early = yield* account(
					alice.session,
					"/v1/organization/domains/example.com/verify",
					"POST",
				)
				assert.strictEqual(early.status, 409)
				assert.strictEqual(yield* tagOf(early), "DomainNotVerified")
				yield* Ref.set(records, [added.recordValue])
				const verified = yield* account(
					alice.session,
					"/v1/organization/domains/example.com/verify",
					"POST",
				)
				assert.strictEqual(verified.status, 200, yield* verified.text)

				// Bob cannot take the domain for his own organization now. He names it,
				// because he now also belongs to Alice's organization.
				const inOwn = (
					path: string,
					method?: HttpMethod.HttpMethod,
					payload?: unknown,
				) =>
					account(bob.session, path, method, payload).pipe(
						Effect.updateService(
							HttpClient.HttpClient,
							HttpClient.mapRequest(
								HttpClientRequest.setHeader(
									AuthApi.OrganizationHeader,
									bob.identity.organizationId,
								),
							),
						),
					)
				yield* inOwn("/v1/organization/domains", "POST", {
					domain: "example.com",
				})
				const taken = yield* inOwn(
					"/v1/organization/domains/example.com/verify",
					"POST",
				)
				assert.strictEqual(yield* tagOf(taken), "DomainTaken")

				// Carol signs in for the first time and joins Alice's organization.
				const carol = yield* host.login("carol")
				assert.strictEqual(
					carol.identity.organizationId,
					alice.identity.organizationId,
				)
				const joined = yield* json(
					OrganizationApi.Member,
					account(alice.session, member(carol.identity.userId)),
				)
				assert.deepStrictEqual(joined.roles, ["member"])

				// Bob joins too. With two organizations, a cookie request must name one.
				const ambiguous = yield* account(bob.session, "/v1/organization")
				assert.strictEqual(ambiguous.status, 400)
				assert.strictEqual(yield* tagOf(ambiguous), "OrganizationRequired")
				const chosen = yield* json(
					OrganizationApi.Organization,
					HttpClient.get(address + "/v1/organization", {
						headers: {
							cookie: Caller.sessionCookie(bob.session),
							"openbot-organization": alice.identity.organizationId,
						},
					}),
				)
				assert.strictEqual(chosen.id, alice.identity.organizationId)
				const listed = yield* json(
					Organizations,
					account(bob.session, "/v1/organizations"),
				)
				assert.strictEqual(listed.items.length, 2)
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"Settings and custom roles change through the API, and roles never give more than their writer has",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const account = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const settings = yield* json(
					Settings.OrganizationSettings,
					account(alice.session, "/v1/organization/settings"),
				)
				assert.strictEqual(settings.joinByDomain, true)
				assert.deepStrictEqual(settings.defaultRoles, ["member"])

				// A change must name the version that it read.
				const stale = yield* account(
					alice.session,
					"/v1/organization/settings",
					"PATCH",
					{ expectedVersion: settings.version + 5, botMemory: false },
				)
				assert.strictEqual(stale.status, 409)
				const changed = yield* json(
					Settings.OrganizationSettings,
					account(alice.session, "/v1/organization/settings", "PATCH", {
						expectedVersion: settings.version,
						botMemory: false,
					}),
				)
				assert.strictEqual(changed.botMemory, false)
				assert.strictEqual(changed.version, settings.version + 1)
				const unknownRole = yield* account(
					alice.session,
					"/v1/organization/settings",
					"PATCH",
					{
						expectedVersion: changed.version,
						defaultRoles: ["role_" + Str.repeat(32)("0")],
					},
				)
				assert.strictEqual(yield* tagOf(unknownRole), "SettingsInvalid")

				// A custom role that only reads the audit log.
				const role = yield* json(
					Roles.Role,
					account(alice.session, "/v1/organization/roles", "POST", {
						name: "Log reader",
						description: "Reads the audit log.",
						policy: yield* Policies.json(function* (_) {
							yield* _.allow(
								"read",
								Authorization.AuditLog,
								Policies.inOrganization,
							)
						}),
					}),
					200,
				)
				assert.strictEqual(role.builtin, false)
				assert.strictEqual(
					(yield* account(bob.session, "/v1/organization/audit_logs")).status,
					403,
				)
				assert.strictEqual(
					(yield* account(alice.session, member(bob.identity.userId), "PATCH", {
						roles: ["member", role.id],
					})).status,
					200,
				)
				assert.strictEqual(
					(yield* account(bob.session, "/v1/organization/audit_logs")).status,
					200,
				)
				// The role is in use, so it cannot go.
				const inUse = yield* account(
					alice.session,
					"/v1/organization/roles/" + role.id,
					"DELETE",
				)
				assert.strictEqual(yield* tagOf(inUse), "RoleInUse")
				const builtin = yield* account(
					alice.session,
					"/v1/organization/roles/member",
					"PATCH",
					{ name: "Changed" },
				)
				assert.strictEqual(yield* tagOf(builtin), "RoleReadOnly")

				// Bob becomes an Administrator. He can write roles, but not one with more than he has.
				yield* account(alice.session, member(bob.identity.userId), "PATCH", {
					roles: ["administrator"],
				})
				const escalation = yield* account(
					bob.session,
					"/v1/organization/roles",
					"POST",
					{
						name: "Everything",
						description: "Too much.",
						policy: yield* Policies.json(function* (_) {
							yield* _.allow(
								"read",
								Authorization.Chat,
								Policies.inOrganization,
							)
						}),
					},
				)
				assert.strictEqual(escalation.status, 403)
				assert.deepInclude(yield* escalation.json, {
					_tag: "Forbidden",
					action: "read",
					kind: "Chat",
				})
				// He can give what he has himself: his own Chats.
				const ownChats = yield* account(
					bob.session,
					"/v1/organization/roles",
					"POST",
					{
						name: "Own Chats",
						description: "Enough.",
						policy: yield* Policies.json(function* (_) {
							yield* _.allow("read", Authorization.Chat, Policies.own)
						}),
					},
				)
				assert.strictEqual(ownChats.status, 200, yield* ownChats.text)
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"Roles decide who can manage the organization, and Super Administrators stay protected",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const keyed = Caller.withToken(address)
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const carol = yield* host.login("carol")

				// A member can read the organization, but not change it or read its members.
				assert.strictEqual(
					(yield* account(bob.session, "/v1/organization")).status,
					200,
				)
				const change = yield* account(
					bob.session,
					"/v1/organization",
					"PATCH",
					{
						name: "Mine",
					},
				)
				assert.strictEqual(change.status, 403)
				assert.deepStrictEqual(yield* change.json, {
					_tag: "Forbidden",
					action: "write",
					kind: "Organization",
				})
				assert.strictEqual(
					(yield* account(bob.session, "/v1/organization/members")).status,
					403,
				)
				assert.strictEqual(
					(yield* account(bob.session, "/v1/organization/audit_logs")).status,
					403,
				)

				// Alice makes Bob an Administrator. He can manage members now.
				assert.strictEqual(
					(yield* account(alice.session, member(bob.identity.userId), "PATCH", {
						roles: ["administrator"],
					})).status,
					200,
				)
				const listed = yield* json(
					Members,
					account(bob.session, "/v1/organization/members?limit=2"),
				)
				assert.strictEqual(listed.items.length, 2)
				assert.notStrictEqual(listed.next, null)
				const rest = yield* json(
					Members,
					account(
						bob.session,
						"/v1/organization/members?limit=2&after=" +
							encodeURIComponent(listed.next ?? ""),
					),
				)
				assert.strictEqual(rest.items.length, 1)
				assert.strictEqual(rest.next, null)

				// An Administrator cannot touch a Super Administrator or make one.
				for (const [target, roles] of [
					[alice.identity.userId, ["member"]],
					[carol.identity.userId, ["super_administrator"]],
				] as const) {
					const attempt = yield* account(bob.session, member(target), "PATCH", {
						roles,
					})
					assert.strictEqual(attempt.status, 403)
				}
				assert.strictEqual(
					(yield* account(bob.session, member(alice.identity.userId), "DELETE"))
						.status,
					403,
				)

				// An Administrator cannot give more than a role gives, in any other way.
				const allow = yield* account(
					bob.session,
					member(carol.identity.userId),
					"PATCH",
					{
						policy: yield* Policies.json(function* (_) {
							yield* _.allow(
								"write",
								Authorization.Member,
								Policies.inOrganization,
							)
						}),
					},
				)
				assert.strictEqual(allow.status, 403)
				const { version } = yield* json(
					Settings.OrganizationSettings,
					account(bob.session, "/v1/organization/settings"),
				)
				const defaults = yield* account(
					bob.session,
					"/v1/organization/settings",
					"PATCH",
					{ expectedVersion: version, defaultRoles: ["super_administrator"] },
				)
				assert.strictEqual(defaults.status, 403)

				// The organization keeps at least one active Super Administrator.
				const last = yield* account(
					alice.session,
					member(alice.identity.userId),
					"PATCH",
					{ status: "suspended" },
				)
				assert.strictEqual(last.status, 409)
				assert.strictEqual(yield* tagOf(last), "LastSuperAdministrator")

				// An Administrator can take an act away with a deny rule.
				const deny = yield* account(
					bob.session,
					member(carol.identity.userId),
					"PATCH",
					{
						policy: yield* Policies.json(function* (_) {
							yield* _.deny("run", Authorization.Chat, Policies.inOrganization)
						}),
					},
				)
				assert.strictEqual(deny.status, 200, yield* deny.text)
				const carolBot = yield* host.defaultBot(carol.session)
				const run = yield* account(
					carol.session,
					"/v1/bots/" + encodeURIComponent(carolBot) + "/messages",
					"POST",
					{ input: "Hello" },
				)
				assert.strictEqual(run.status, 403)
				assert.deepInclude(yield* run.json, { action: "run", kind: "Chat" })

				// A suspended member is out, with the cookie and with every token.
				const token = yield* json(
					UserTokensApi.CreatedToken,
					account(carol.session, "/v1/user/tokens", "POST", {
						name: "Carol bot",
					}),
				)
				assert.strictEqual(
					(yield* keyed(token.secret, "/v1/chats")).status,
					200,
				)
				assert.strictEqual(
					(yield* account(bob.session, member(carol.identity.userId), "PATCH", {
						status: "suspended",
					})).status,
					200,
				)
				const suspended = yield* account(carol.session, "/v1/chats")
				assert.strictEqual(suspended.status, 403)
				assert.strictEqual(yield* tagOf(suspended), "MembershipRequired")
				// A token has no cookie to fall back on, so it gets the plain sign-in error.
				assert.strictEqual(
					(yield* keyed(token.secret, "/v1/chats")).status,
					401,
				)

				// Removing a member also revokes their tokens.
				assert.strictEqual(
					(yield* account(bob.session, member(carol.identity.userId), "DELETE"))
						.status,
					204,
				)
				assert.strictEqual(
					(yield* account(bob.session, member(carol.identity.userId))).status,
					404,
				)
				assert.strictEqual(
					(yield* keyed(token.secret, "/v1/chats")).status,
					401,
				)

				const audit = yield* json(
					AuditLogs,
					account(alice.session, "/v1/organization/audit_logs?limit=100"),
				)
				const actions = Arr.map(audit.items, (entry) => entry.action)
				for (const action of [
					"member.joined",
					"member.updated",
					"member.removed",
					"token.created",
				] as const)
					assert.ok(Arr.contains(actions, action), action)
				const byBob = yield* json(
					AuditLogs,
					account(
						alice.session,
						"/v1/organization/audit_logs?action=member.removed&actor=" +
							encodeURIComponent(bob.identity.userId),
					),
				)
				assert.strictEqual(byBob.items.length, 1)
				assert.strictEqual(byBob.items[0]?.actor.userId, bob.identity.userId)

				const resources = yield* json(
					Schema.Array(Authorization.ResourceInfo),
					account(alice.session, "/v1/organization/resources"),
				)
				const chat = yield* Effect.fromOption(
					Arr.findFirst(resources, (resource) => resource.kind === "Chat"),
				)
				assert.ok(Arr.some(chat.actions, (action) => action.name === "run"))
				assert.deepStrictEqual(chat.path, [
					"org",
					"{organizationId}",
					"user",
					"{ownerUserId}",
					"chat",
					"{id}",
				])
				const roles = yield* json(
					Schema.Array(Roles.Role),
					account(alice.session, "/v1/organization/roles"),
				)
				assert.deepStrictEqual(
					Arr.map(roles, (role) => role.id),
					[
						"super_administrator",
						"administrator",
						"administrator_read_only",
						"member",
						"auditor",
					],
				)
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"A new account has no organization, joins by invitation, and can leave",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
				})
				const account = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const alice = yield* host.login("inv-alice")
				const bob = yield* host.login("inv-bob", undefined, {
					organization: false,
				})
				const carol = yield* host.login("inv-carol", undefined, {
					organization: false,
				})

				// OpenBot makes no organization at sign-in.
				assert.deepStrictEqual(bob.memberships, [])
				assert.deepStrictEqual(
					yield* body(account(bob.session, "/v1/organizations")),
					{ items: [] },
				)
				assert.strictEqual(
					(yield* account(bob.session, "/v1/organization")).status,
					403,
				)

				const invite = (email: string, roles?: ReadonlyArray<string>) =>
					account(alice.session, "/v1/organization/invitations", "POST", {
						email,
						...(roles === undefined ? {} : { roles }),
					})
				const invitation = yield* json(
					OrganizationApi.Invitation,
					invite("Inv-Bob@example.com", ["member"]),
					201,
				)
				assert.strictEqual(invitation.email, "inv-bob@example.com")
				assert.strictEqual(invitation.status, "pending")
				assert.deepStrictEqual(invitation.roles, ["member"])
				assert.strictEqual((yield* invite("inv-bob@example.com")).status, 400)
				assert.strictEqual(
					(yield* invite("inv-dave@example.com", [
						"role_" + Str.repeat(32)("0"),
					])).status,
					404,
				)

				// Only the person with the email sees and answers the invitation.
				const mine = yield* json(
					Invitations,
					account(bob.session, "/v1/invitations"),
				)
				assert.deepStrictEqual(
					Arr.map(mine.items, (item) => item.id),
					[invitation.id],
				)
				assert.strictEqual(
					(yield* account(
						carol.session,
						"/v1/invitations/" + invitation.id + "/accept",
						"POST",
					)).status,
					404,
				)
				const accepted = yield* json(
					OrganizationApi.Organization,
					account(
						bob.session,
						"/v1/invitations/" + invitation.id + "/accept",
						"POST",
					),
					200,
				)
				assert.strictEqual(accepted.id, alice.identity.organizationId)
				const joined = yield* json(
					Organizations,
					account(bob.session, "/v1/organizations"),
				)
				assert.deepStrictEqual(
					Arr.map(joined.items, (item) => item.id),
					[alice.identity.organizationId],
				)
				const bobMember = yield* json(
					OrganizationApi.Member,
					account(alice.session, member(bob.identity.userId)),
				)
				assert.deepStrictEqual(bobMember.roles, ["member"])
				assert.strictEqual(
					(yield* account(
						bob.session,
						"/v1/invitations/" + invitation.id + "/accept",
						"POST",
					)).status,
					400,
				)
				// A member already has this email.
				assert.strictEqual((yield* invite("inv-bob@example.com")).status, 400)

				// Carol declines. Then she cannot accept.
				const forCarol = yield* json(
					OrganizationApi.Invitation,
					invite("inv-carol@example.com"),
				)
				const declined = yield* json(
					OrganizationApi.Invitation,
					account(
						carol.session,
						"/v1/invitations/" + forCarol.id + "/decline",
						"POST",
					),
					200,
				)
				assert.strictEqual(declined.status, "declined")
				assert.strictEqual(
					(yield* account(
						carol.session,
						"/v1/invitations/" + forCarol.id + "/accept",
						"POST",
					)).status,
					400,
				)

				// A revoked invitation cannot be answered.
				const forDave = yield* json(
					OrganizationApi.Invitation,
					invite("inv-dave@example.com"),
				)
				assert.strictEqual(
					(yield* account(
						alice.session,
						"/v1/organization/invitations/" + forDave.id,
						"DELETE",
					)).status,
					204,
				)
				const listed = yield* json(
					Invitations,
					account(alice.session, "/v1/organization/invitations"),
				)
				assert.deepStrictEqual(
					Arr.map(listed.items, (item) => [item.email, item.status]),
					[
						["inv-dave@example.com", "revoked"],
						["inv-carol@example.com", "declined"],
						["inv-bob@example.com", "accepted"],
					],
				)

				// Bob leaves. The last Super Administrator cannot leave.
				const leave = (session: typeof alice.session) =>
					account(
						session,
						"/v1/organizations/" +
							alice.identity.organizationId +
							"/membership",
						"DELETE",
					)
				assert.strictEqual((yield* leave(bob.session)).status, 204)
				assert.deepStrictEqual(
					yield* body(account(bob.session, "/v1/organizations")),
					{ items: [] },
				)
				assert.strictEqual((yield* leave(alice.session)).status, 409)
				const left = yield* json(
					AuditLogs,
					account(
						alice.session,
						"/v1/organization/audit_logs?action=member.left",
					),
				)
				assert.strictEqual(left.items.length, 1)
			}),
		{ timeout: 60000 },
	)
})
