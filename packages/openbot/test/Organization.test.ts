import assert from "node:assert/strict"
import { test } from "node:test"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"

const publicOrigin = "https://api.example.com"
const member = (userId: string) =>
	"/v1/organization/members/" + encodeURIComponent(userId)

test(
	"The first account owns the organization, and others join only from allowed domains",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			organization: { allowedEmailDomains: [] },
		})
		try {
			const account = withCookie({ address: host.address, publicOrigin })
			const alice = await host.login("alice")
			const organization = await (
				await account(alice.session, "/v1/organization")
			).json()
			assert.equal(organization.id, alice.identity.organizationId)
			assert.deepEqual(organization.allowedEmailDomains, [])
			const self = await (
				await account(alice.session, member(alice.identity.userId))
			).json()
			assert.deepEqual(self.roles, ["super_administrator"])

			// Bob has a verified email, but his domain is not allowed yet.
			await assert.rejects(host.login("bob"))

			const allowed = await account(
				alice.session,
				"/v1/organization",
				"PATCH",
				{
					allowedEmailDomains: ["example.com"],
				},
			)
			assert.equal(allowed.status, 200, await allowed.clone().text())
			const bob = await host.login("bob")
			assert.equal(bob.identity.organizationId, alice.identity.organizationId)
			const joined = await (
				await account(alice.session, member(bob.identity.userId))
			).json()
			assert.deepEqual(joined.roles, ["member"])
			assert.equal(joined.status, "active")
		} finally {
			await host.close()
		}
	},
)

test(
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
			assert.equal((await account(bob.session, "/v1/organization")).status, 200)
			const change = await account(bob.session, "/v1/organization", "PATCH", {
				name: "Mine",
			})
			assert.equal(change.status, 403)
			assert.deepEqual(await change.json(), {
				_tag: "PermissionDenied",
				permission: "organization.write",
				resource: "openbot.org." + alice.identity.organizationId,
			})
			assert.equal(
				(await account(bob.session, "/v1/organization/members")).status,
				403,
			)
			assert.equal(
				(await account(bob.session, "/v1/organization/audit_logs")).status,
				403,
			)

			// Alice makes Bob an Administrator. He can manage members now.
			assert.equal(
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
			assert.equal(listed.items.length, 2)
			assert.notEqual(listed.next, null)
			const rest = await (
				await account(
					bob.session,
					"/v1/organization/members?limit=2&after=" +
						encodeURIComponent(listed.next),
				)
			).json()
			assert.equal(rest.items.length, 1)
			assert.equal(rest.next, null)

			// An Administrator cannot touch a Super Administrator or make one.
			for (const [target, roles] of [
				[alice.identity.userId, ["member"]],
				[carol.identity.userId, ["super_administrator"]],
			] as const) {
				const attempt = await account(bob.session, member(target), "PATCH", {
					roles,
				})
				assert.equal(attempt.status, 403)
			}
			assert.equal(
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
			assert.equal(allow.status, 403)
			const defaults = await account(bob.session, "/v1/organization", "PATCH", {
				defaultRoles: ["super_administrator"],
			})
			assert.equal(defaults.status, 403)

			// The organization keeps at least one active Super Administrator.
			const last = await account(
				alice.session,
				member(alice.identity.userId),
				"PATCH",
				{ status: "suspended" },
			)
			assert.equal(last.status, 409)
			assert.equal((await last.json())._tag, "LastSuperAdministrator")

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
			assert.equal(deny.status, 200, await deny.clone().text())
			const created = await (
				await account(carol.session, "/v1/sessions", "POST", { title: "Hi" })
			).json()
			const run = await account(
				carol.session,
				"/v1/sessions/" + encodeURIComponent(created.session.id) + "/turns",
				"POST",
				{ expected: created.session.revision, input: "Hello" },
			)
			assert.equal(run.status, 403)
			assert.equal((await run.json()).permission, "responses.run")

			// A suspended member is out, with the cookie and with every token.
			const token = await (
				await account(carol.session, "/v1/user/tokens", "POST", {
					name: "Carol bot",
				})
			).json()
			assert.equal((await keyed(token.secret, "/v1/sessions")).status, 200)
			assert.equal(
				(
					await account(bob.session, member(carol.identity.userId), "PATCH", {
						status: "suspended",
					})
				).status,
				200,
			)
			const suspended = await account(carol.session, "/v1/sessions")
			assert.equal(suspended.status, 403)
			assert.equal((await suspended.json())._tag, "MembershipRequired")
			// A token has no cookie to fall back on, so it gets the plain sign-in error.
			assert.equal((await keyed(token.secret, "/v1/sessions")).status, 401)

			// Removing a member also revokes their tokens.
			assert.equal(
				(await account(bob.session, member(carol.identity.userId), "DELETE"))
					.status,
				204,
			)
			assert.equal(
				(await account(bob.session, member(carol.identity.userId))).status,
				404,
			)
			assert.equal((await keyed(token.secret, "/v1/sessions")).status, 401)

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
			assert.equal(byBob.items.length, 1)
			assert.equal(byBob.items[0].actor.userId, bob.identity.userId)

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
			assert.deepEqual(
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
