import assert from "node:assert/strict"
import { test } from "node:test"
import { AuthApi } from "@openbot-build/api"
import { Effect, Layer, Redacted } from "effect"
import { DomainControl } from "../src/apps/DomainControl.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"

const publicOrigin = "https://api.example.com"
const member = (userId: string) =>
	"/v1/organization/members/" + encodeURIComponent(userId)

test(
	"Each account gets its own organization, and others join after a domain is verified",
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
			assert.equal(organization.id, alice.identity.organizationId)
			assert.equal(organization.status, "active")
			const self = await (
				await account(alice.session, member(alice.identity.userId))
			).json()
			assert.deepEqual(self.roles, ["super_administrator"])

			// Bob has a verified email in the same domain, but nobody verified the domain.
			const bob = await host.login("bob")
			assert.notEqual(
				bob.identity.organizationId,
				alice.identity.organizationId,
			)

			// A domain does nothing until its TXT record proves control.
			const added = await (
				await account(alice.session, "/v1/organization/domains", "POST", {
					domain: "example.com",
				})
			).json()
			assert.equal(added.recordName, "_openbot-verification.example.com")
			assert.equal(added.verifiedAt, null)
			const early = await account(
				alice.session,
				"/v1/organization/domains/example.com/verify",
				"POST",
			)
			assert.equal(early.status, 409)
			assert.equal((await early.json())._tag, "DomainNotVerified")
			records = [added.recordValue]
			const verified = await account(
				alice.session,
				"/v1/organization/domains/example.com/verify",
				"POST",
			)
			assert.equal(verified.status, 200, await verified.clone().text())

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
			assert.equal((await taken.json())._tag, "DomainTaken")

			// Carol signs in for the first time and joins Alice's organization.
			const carol = await host.login("carol")
			assert.equal(carol.identity.organizationId, alice.identity.organizationId)
			const joined = await (
				await account(alice.session, member(carol.identity.userId))
			).json()
			assert.deepEqual(joined.roles, ["member"])

			// Bob joins too. With two organizations, a cookie request must name one.
			const ambiguous = await account(bob.session, "/v1/organization")
			assert.equal(ambiguous.status, 400)
			assert.equal((await ambiguous.json())._tag, "OrganizationRequired")
			const chosen = await fetch(host.address + "/v1/organization", {
				headers: {
					cookie:
						AuthApi.SessionCookie +
						"=" +
						encodeURIComponent(Redacted.value(bob.session)),
					"openbot-organization": alice.identity.organizationId,
				},
			})
			assert.equal((await chosen.json()).id, alice.identity.organizationId)
			const listed = await (
				await withCookie({ address: host.address, publicOrigin })(
					bob.session,
					"/v1/organizations",
				)
			).json()
			assert.equal(listed.items.length, 2)
		} finally {
			await host.close()
		}
	},
)

test(
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
			assert.equal(settings.joinByDomain, true)
			assert.deepEqual(settings.defaultRoles, ["member"])

			// A change must name the version that it read.
			const stale = await account(
				alice.session,
				"/v1/organization/settings",
				"PATCH",
				{ expectedVersion: settings.version + 5, agentMemory: false },
			)
			assert.equal(stale.status, 409)
			const changed = await (
				await account(alice.session, "/v1/organization/settings", "PATCH", {
					expectedVersion: settings.version,
					agentMemory: false,
				})
			).json()
			assert.equal(changed.agentMemory, false)
			assert.equal(changed.version, settings.version + 1)
			const unknownRole = await account(
				alice.session,
				"/v1/organization/settings",
				"PATCH",
				{
					expectedVersion: changed.version,
					defaultRoles: ["role_" + "0".repeat(32)],
				},
			)
			assert.equal((await unknownRole.json())._tag, "SettingsInvalid")

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
			assert.equal(created.status, 200, await created.clone().text())
			const role = await created.json()
			assert.equal(role.builtin, false)
			assert.equal(
				(await account(bob.session, "/v1/organization/audit_logs")).status,
				403,
			)
			assert.equal(
				(
					await account(alice.session, member(bob.identity.userId), "PATCH", {
						roles: ["member", role.id],
					})
				).status,
				200,
			)
			assert.equal(
				(await account(bob.session, "/v1/organization/audit_logs")).status,
				200,
			)
			// The role is in use, so it cannot go.
			const inUse = await account(
				alice.session,
				"/v1/organization/roles/" + role.id,
				"DELETE",
			)
			assert.equal((await inUse.json())._tag, "RoleInUse")
			const builtin = await account(
				alice.session,
				"/v1/organization/roles/member",
				"PATCH",
				{ name: "Changed" },
			)
			assert.equal((await builtin.json())._tag, "RoleReadOnly")

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
							permissionGroups: ["sessions.read"],
							resources: ["openbot.org.{org}"],
						},
					],
				},
			)
			assert.equal(escalation.status, 403)
			assert.equal((await escalation.json())._tag, "PermissionDenied")
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
			const { version } = await (
				await account(bob.session, "/v1/organization/settings")
			).json()
			const defaults = await account(
				bob.session,
				"/v1/organization/settings",
				"PATCH",
				{ expectedVersion: version, defaultRoles: ["super_administrator"] },
			)
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
			await host.defaultAgent(carol.session)
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
