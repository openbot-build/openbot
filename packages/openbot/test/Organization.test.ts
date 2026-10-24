import { assert, it } from "@effect/vitest"
import { AuthApi } from "@openbot-build/api"
import { Effect, Layer, Redacted } from "effect"
import { DomainControl } from "../src/apps/DomainControl.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"

const publicOrigin = "https://api.example.com"
const member = (userId: string) =>
	"/v1/organization/members/" + encodeURIComponent(userId)

it(
	"An account makes its own organization, and others join after a domain is verified",
	{ timeout: 60000 },
	async () => {
		let records: ReadonlyArray<string> = []
		const host = await BrowserHost.start({
			publicOrigin,
			sharedDomain: false,
			domainControl: Layer.succeed(DomainControl, {
				tokens: () => Effect.sync(() => records),
			}),
		})
		try {
			const account = withCookie({ address: host.address, publicOrigin })
			const alice = await host.login("alice")
			const organization = await (
				await account(alice.session, "/v1/organization")
			).json()
			assert.strictEqual(organization.id, alice.identity.organizationId)
			assert.strictEqual(organization.status, "active")
			const self = await (
				await account(alice.session, member(alice.identity.userId))
			).json()
			assert.deepStrictEqual(self.roles, ["super_administrator"])

			// Bob has a verified email in the same domain, but nobody verified the domain.
			const bob = await host.login("bob")
			assert.notStrictEqual(
				bob.identity.organizationId,
				alice.identity.organizationId,
			)

			// A domain does nothing until its TXT record proves control.
			const added = await (
				await account(alice.session, "/v1/organization/domains", "POST", {
					domain: "example.com",
				})
			).json()
			assert.strictEqual(added.recordName, "_openbot-verification.example.com")
			assert.strictEqual(added.verifiedAt, null)
			const early = await account(
				alice.session,
				"/v1/organization/domains/example.com/verify",
				"POST",
			)
			assert.strictEqual(early.status, 409)
			assert.strictEqual((await early.json())._tag, "DomainNotVerified")
			records = [added.recordValue]
			const verified = await account(
				alice.session,
				"/v1/organization/domains/example.com/verify",
				"POST",
			)
			assert.strictEqual(verified.status, 200, await verified.clone().text())

			// Bob cannot take the domain for his own organization now. He names it,
			// because he now also belongs to Alice's organization.
			const inOwn = (path: string, method = "GET", payload?: unknown) =>
				fetch(host.address + path, {
					method,
					headers: {
						cookie:
							AuthApi.SessionCookie +
							"=" +
							encodeURIComponent(Redacted.value(bob.session)),
						origin: publicOrigin,
						[AuthApi.OrganizationHeader]: bob.identity.organizationId,
						...(payload === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				})
			await inOwn("/v1/organization/domains", "POST", { domain: "example.com" })
			const taken = await inOwn(
				"/v1/organization/domains/example.com/verify",
				"POST",
			)
			assert.strictEqual((await taken.json())._tag, "DomainTaken")

			// Carol signs in for the first time and joins Alice's organization.
			const carol = await host.login("carol")
			assert.strictEqual(
				carol.identity.organizationId,
				alice.identity.organizationId,
			)
			const joined = await (
				await account(alice.session, member(carol.identity.userId))
			).json()
			assert.deepStrictEqual(joined.roles, ["member"])

			// Bob joins too. With two organizations, a cookie request must name one.
			const ambiguous = await account(bob.session, "/v1/organization")
			assert.strictEqual(ambiguous.status, 400)
			assert.strictEqual((await ambiguous.json())._tag, "OrganizationRequired")
			const chosen = await fetch(host.address + "/v1/organization", {
				headers: {
					cookie:
						AuthApi.SessionCookie +
						"=" +
						encodeURIComponent(Redacted.value(bob.session)),
					"openbot-organization": alice.identity.organizationId,
				},
			})
			assert.strictEqual(
				(await chosen.json()).id,
				alice.identity.organizationId,
			)
			const listed = await (
				await withCookie({ address: host.address, publicOrigin })(
					bob.session,
					"/v1/organizations",
				)
			).json()
			assert.strictEqual(listed.items.length, 2)
		} finally {
			await host.close()
		}
	},
)

it(
	"Settings and custom roles change through the API, and roles never give more than their writer has",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin })
		try {
			const account = withCookie({ address: host.address, publicOrigin })
			const alice = await host.login("alice")
			const bob = await host.login("bob")
			const settings = await (
				await account(alice.session, "/v1/organization/settings")
			).json()
			assert.strictEqual(settings.joinByDomain, true)
			assert.deepStrictEqual(settings.defaultRoles, ["member"])

			// A change must name the version that it read.
			const stale = await account(
				alice.session,
				"/v1/organization/settings",
				"PATCH",
				{ expectedVersion: settings.version + 5, botMemory: false },
			)
			assert.strictEqual(stale.status, 409)
			const changed = await (
				await account(alice.session, "/v1/organization/settings", "PATCH", {
					expectedVersion: settings.version,
					botMemory: false,
				})
			).json()
			assert.strictEqual(changed.botMemory, false)
			assert.strictEqual(changed.version, settings.version + 1)
			const unknownRole = await account(
				alice.session,
				"/v1/organization/settings",
				"PATCH",
				{
					expectedVersion: changed.version,
					defaultRoles: ["role_" + "0".repeat(32)],
				},
			)
			assert.strictEqual((await unknownRole.json())._tag, "SettingsInvalid")

			// A custom role that only reads the audit log.
			const created = await account(
				alice.session,
				"/v1/organization/roles",
				"POST",
				{
					name: "Log reader",
					description: "Reads the audit log.",
					policies: [
						{
							effect: "allow",
							permissionGroups: ["audit_logs.read"],
							resources: ["openbot.org.{org}"],
						},
					],
				},
			)
			assert.strictEqual(created.status, 200, await created.clone().text())
			const role = await created.json()
			assert.strictEqual(role.builtin, false)
			assert.strictEqual(
				(await account(bob.session, "/v1/organization/audit_logs")).status,
				403,
			)
			assert.strictEqual(
				(
					await account(alice.session, member(bob.identity.userId), "PATCH", {
						roles: ["member", role.id],
					})
				).status,
				200,
			)
			assert.strictEqual(
				(await account(bob.session, "/v1/organization/audit_logs")).status,
				200,
			)
			// The role is in use, so it cannot go.
			const inUse = await account(
				alice.session,
				"/v1/organization/roles/" + role.id,
				"DELETE",
			)
			assert.strictEqual((await inUse.json())._tag, "RoleInUse")
			const builtin = await account(
				alice.session,
				"/v1/organization/roles/member",
				"PATCH",
				{ name: "Changed" },
			)
			assert.strictEqual((await builtin.json())._tag, "RoleReadOnly")

			// Bob becomes an Administrator. He can write roles, but not one with more than he has.
			await account(alice.session, member(bob.identity.userId), "PATCH", {
				roles: ["administrator"],
			})
			const escalation = await account(
				bob.session,
				"/v1/organization/roles",
				"POST",
				{
					name: "Everything",
					description: "Too much.",
					policies: [
						{
							effect: "allow",
							permissionGroups: ["chats.read"],
							resources: ["openbot.org.{org}"],
						},
					],
				},
			)
			assert.strictEqual(escalation.status, 403)
			assert.strictEqual((await escalation.json())._tag, "PermissionDenied")
		} finally {
			await host.close()
		}
	},
)

it(
	"Roles decide who can manage the organization, and Super Administrators stay protected",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin })
		try {
			const account = withCookie({ address: host.address, publicOrigin })
			const keyed = withToken(host.address)
			const alice = await host.login("alice")
			const bob = await host.login("bob")
			const carol = await host.login("carol")

			// A member can read the organization, but not change it or read its members.
			assert.strictEqual(
				(await account(bob.session, "/v1/organization")).status,
				200,
			)
			const change = await account(bob.session, "/v1/organization", "PATCH", {
				name: "Mine",
			})
			assert.strictEqual(change.status, 403)
			assert.deepStrictEqual(await change.json(), {
				_tag: "PermissionDenied",
				permission: "organization.write",
				resource: "openbot.org." + alice.identity.organizationId,
			})
			assert.strictEqual(
				(await account(bob.session, "/v1/organization/members")).status,
				403,
			)
			assert.strictEqual(
				(await account(bob.session, "/v1/organization/audit_logs")).status,
				403,
			)

			// Alice makes Bob an Administrator. He can manage members now.
			assert.strictEqual(
				(
					await account(alice.session, member(bob.identity.userId), "PATCH", {
						roles: ["administrator"],
					})
				).status,
				200,
			)
			const listed = await (
				await account(bob.session, "/v1/organization/members?limit=2")
			).json()
			assert.strictEqual(listed.items.length, 2)
			assert.notStrictEqual(listed.next, null)
			const rest = await (
				await account(
					bob.session,
					"/v1/organization/members?limit=2&after=" +
						encodeURIComponent(listed.next),
				)
			).json()
			assert.strictEqual(rest.items.length, 1)
			assert.strictEqual(rest.next, null)

			// An Administrator cannot touch a Super Administrator or make one.
			for (const [target, roles] of [
				[alice.identity.userId, ["member"]],
				[carol.identity.userId, ["super_administrator"]],
			] as const) {
				const attempt = await account(bob.session, member(target), "PATCH", {
					roles,
				})
				assert.strictEqual(attempt.status, 403)
			}
			assert.strictEqual(
				(await account(bob.session, member(alice.identity.userId), "DELETE"))
					.status,
				403,
			)

			// An Administrator cannot give more than a role gives, in any other way.
			const allow = await account(
				bob.session,
				member(carol.identity.userId),
				"PATCH",
				{
					policies: [
						{
							effect: "allow",
							permissionGroups: ["members.write"],
							resources: ["openbot.org.{org}"],
						},
					],
				},
			)
			assert.strictEqual(allow.status, 403)
			const { version } = await (
				await account(bob.session, "/v1/organization/settings")
			).json()
			const defaults = await account(
				bob.session,
				"/v1/organization/settings",
				"PATCH",
				{ expectedVersion: version, defaultRoles: ["super_administrator"] },
			)
			assert.strictEqual(defaults.status, 403)

			// The organization keeps at least one active Super Administrator.
			const last = await account(
				alice.session,
				member(alice.identity.userId),
				"PATCH",
				{ status: "suspended" },
			)
			assert.strictEqual(last.status, 409)
			assert.strictEqual((await last.json())._tag, "LastSuperAdministrator")

			// An Administrator can take a permission away with a deny policy.
			const deny = await account(
				bob.session,
				member(carol.identity.userId),
				"PATCH",
				{
					policies: [
						{
							effect: "deny",
							permissionGroups: ["responses.run"],
							resources: ["openbot.org.{org}"],
						},
					],
				},
			)
			assert.strictEqual(deny.status, 200, await deny.clone().text())
			const carolBot = await host.defaultBot(carol.session)
			const run = await account(
				carol.session,
				"/v1/bots/" + encodeURIComponent(carolBot) + "/messages",
				"POST",
				{ input: "Hello" },
			)
			assert.strictEqual(run.status, 403)
			assert.strictEqual((await run.json()).permission, "responses.run")

			// A suspended member is out, with the cookie and with every token.
			const token = await (
				await account(carol.session, "/v1/user/tokens", "POST", {
					name: "Carol bot",
				})
			).json()
			assert.strictEqual((await keyed(token.secret, "/v1/chats")).status, 200)
			assert.strictEqual(
				(
					await account(bob.session, member(carol.identity.userId), "PATCH", {
						status: "suspended",
					})
				).status,
				200,
			)
			const suspended = await account(carol.session, "/v1/chats")
			assert.strictEqual(suspended.status, 403)
			assert.strictEqual((await suspended.json())._tag, "MembershipRequired")
			// A token has no cookie to fall back on, so it gets the plain sign-in error.
			assert.strictEqual((await keyed(token.secret, "/v1/chats")).status, 401)

			// Removing a member also revokes their tokens.
			assert.strictEqual(
				(await account(bob.session, member(carol.identity.userId), "DELETE"))
					.status,
				204,
			)
			assert.strictEqual(
				(await account(bob.session, member(carol.identity.userId))).status,
				404,
			)
			assert.strictEqual((await keyed(token.secret, "/v1/chats")).status, 401)

			const audit = await (
				await account(alice.session, "/v1/organization/audit_logs?limit=100")
			).json()
			const actions = audit.items.map(
				(entry: { readonly action: string }) => entry.action,
			)
			for (const action of [
				"member.joined",
				"member.updated",
				"member.removed",
				"token.created",
			])
				assert.ok(actions.includes(action), action)
			const byBob = await (
				await account(
					alice.session,
					"/v1/organization/audit_logs?action=member.removed&actor=" +
						encodeURIComponent(bob.identity.userId),
				)
			).json()
			assert.strictEqual(byBob.items.length, 1)
			assert.strictEqual(byBob.items[0].actor.userId, bob.identity.userId)

			const groups = await (
				await account(alice.session, "/v1/organization/permission_groups")
			).json()
			assert.ok(
				groups.some(
					(group: { readonly id: string }) => group.id === "responses.run",
				),
			)
			const roles = await (
				await account(alice.session, "/v1/organization/roles")
			).json()
			assert.deepStrictEqual(
				roles.map((role: { readonly id: string }) => role.id),
				[
					"super_administrator",
					"administrator",
					"administrator_read_only",
					"member",
					"auditor",
				],
			)
		} finally {
			await host.close()
		}
	},
)

it(
	"A new account has no organization, joins by invitation, and can leave",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, sharedDomain: false })
		try {
			const account = withCookie({ address: host.address, publicOrigin })
			const alice = await host.login("inv-alice")
			const bob = await host.login("inv-bob", undefined, {
				organization: false,
			})
			const carol = await host.login("inv-carol", undefined, {
				organization: false,
			})

			// OpenBot makes no organization at sign-in.
			assert.deepStrictEqual(bob.memberships, [])
			assert.deepStrictEqual(
				await (await account(bob.session, "/v1/organizations")).json(),
				{ items: [] },
			)
			assert.strictEqual(
				(await account(bob.session, "/v1/organization")).status,
				403,
			)

			const invite = (email: string, roles?: ReadonlyArray<string>) =>
				account(alice.session, "/v1/organization/invitations", "POST", {
					email,
					...(roles === undefined ? {} : { roles }),
				})
			const made = await invite("Inv-Bob@example.com", ["member"])
			assert.strictEqual(made.status, 201, await made.clone().text())
			const invitation = await made.json()
			assert.strictEqual(invitation.email, "inv-bob@example.com")
			assert.strictEqual(invitation.status, "pending")
			assert.deepStrictEqual(invitation.roles, ["member"])
			assert.strictEqual((await invite("inv-bob@example.com")).status, 400)
			assert.strictEqual(
				(await invite("inv-dave@example.com", ["role_" + "0".repeat(32)]))
					.status,
				404,
			)

			// Only the person with the email sees and answers the invitation.
			const mine = await (await account(bob.session, "/v1/invitations")).json()
			assert.deepStrictEqual(
				mine.items.map((item: { readonly id: string }) => item.id),
				[invitation.id],
			)
			assert.strictEqual(
				(
					await account(
						carol.session,
						"/v1/invitations/" + invitation.id + "/accept",
						"POST",
					)
				).status,
				404,
			)
			const accepted = await account(
				bob.session,
				"/v1/invitations/" + invitation.id + "/accept",
				"POST",
			)
			assert.strictEqual(accepted.status, 200, await accepted.clone().text())
			assert.strictEqual(
				(await accepted.json()).id,
				alice.identity.organizationId,
			)
			const joined = await (
				await account(bob.session, "/v1/organizations")
			).json()
			assert.deepStrictEqual(
				joined.items.map((item: { readonly id: string }) => item.id),
				[alice.identity.organizationId],
			)
			const bobMember = await (
				await account(alice.session, member(bob.identity.userId))
			).json()
			assert.deepStrictEqual(bobMember.roles, ["member"])
			assert.strictEqual(
				(
					await account(
						bob.session,
						"/v1/invitations/" + invitation.id + "/accept",
						"POST",
					)
				).status,
				400,
			)
			// A member already has this email.
			assert.strictEqual((await invite("inv-bob@example.com")).status, 400)

			// Carol declines. Then she cannot accept.
			const forCarol = await (await invite("inv-carol@example.com")).json()
			const declined = await account(
				carol.session,
				"/v1/invitations/" + forCarol.id + "/decline",
				"POST",
			)
			assert.strictEqual(declined.status, 200, await declined.clone().text())
			assert.strictEqual((await declined.json()).status, "declined")
			assert.strictEqual(
				(
					await account(
						carol.session,
						"/v1/invitations/" + forCarol.id + "/accept",
						"POST",
					)
				).status,
				400,
			)

			// A revoked invitation cannot be answered.
			const forDave = await (await invite("inv-dave@example.com")).json()
			assert.strictEqual(
				(
					await account(
						alice.session,
						"/v1/organization/invitations/" + forDave.id,
						"DELETE",
					)
				).status,
				204,
			)
			const listed = await (
				await account(alice.session, "/v1/organization/invitations")
			).json()
			assert.deepStrictEqual(
				listed.items.map(
					(item: { readonly email: string; readonly status: string }) => [
						item.email,
						item.status,
					],
				),
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
					"/v1/organizations/" + alice.identity.organizationId + "/membership",
					"DELETE",
				)
			assert.strictEqual((await leave(bob.session)).status, 204)
			assert.deepStrictEqual(
				await (await account(bob.session, "/v1/organizations")).json(),
				{ items: [] },
			)
			assert.strictEqual((await leave(alice.session)).status, 409)
			const left = await (
				await account(
					alice.session,
					"/v1/organization/audit_logs?action=member.left",
				)
			).json()
			assert.strictEqual(left.items.length, 1)
		} finally {
			await host.close()
		}
	},
)
