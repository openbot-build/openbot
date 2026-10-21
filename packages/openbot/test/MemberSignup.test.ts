import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { ConfigProvider, Effect } from "effect"
import { Pool } from "pg"
import * as EnvironmentConfiguration from "../src/configuration/EnvironmentConfiguration.ts"
import { Organization } from "../src/organization/Organization.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"

const publicOrigin = "https://signup.example.com"
const managed = {
	allowFirstLoginAdmin: false,
	ownerEmails: ["owner@example.com"],
	allowedEmailDomains: [],
}
const memberPath = (id: string) =>
	"/v1/organization/members/" + encodeURIComponent(id)

test("member signup is off by default and needs a valid explicit setting", async () => {
	const load = (extra: Record<string, string>) =>
		Effect.runPromise(
			EnvironmentConfiguration.load.pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({
						OPENBOT_DATABASE_URL: "postgres://localhost/signup",
						OPENBOT_APP_ENCRYPTION_KEY: "1".repeat(64),
						OPENBOT_PUBLIC_ORIGIN: publicOrigin,
						OPENBOT_OIDC_ISSUER: "https://id.example.com",
						OPENBOT_OIDC_CLIENT_ID: "signup-fixture",
						BETTER_AUTH_SECRET: "SignupFixtureSecretAtLeastThirtyTwoCharacters",
						...extra,
					}),
				),
			),
		)
	assert.equal((await load({})).organization?.allowMemberSignup, false)
	assert.equal(
		(await load({ OPENBOT_ALLOW_MEMBER_SIGNUP: "true" })).organization
			?.allowMemberSignup,
		true,
	)
	assert.equal(
		(await load({ OPENBOT_ALLOW_MEMBER_SIGNUP: "false" })).organization
			?.allowMemberSignup,
		false,
	)
	await assert.rejects(load({ OPENBOT_ALLOW_MEMBER_SIGNUP: "invalid" }))
})

test(
	"a new authenticated account cannot join without the signup setting",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			organization: managed,
		})
		try {
			await host.login("owner")
			await assert.rejects(host.login("new-account"))
		} finally {
			await host.close()
		}
	},
)

test(
	"signup grants only member access and never restores a suspended or removed account",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			organization: { ...managed, allowMemberSignup: true },
		})
		const pool = new Pool({ connectionString: host.databaseUrl })
		try {
			const request = withCookie({ address: host.address, publicOrigin })
			const keyed = withToken(host.address)
			assert.equal((await fetch(host.address + "/auth/session")).status, 401)
			await assert.rejects(host.login("before-owner"))
			assert.equal(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM openbot_organizations",
					)
				).rows[0].count,
				0,
			)
			assert.equal(
				(await pool.query("SELECT count(*)::int AS count FROM openbot_members"))
					.rows[0].count,
				0,
			)
			const owner = await host.login("owner")
			const defaults = await request(
				owner.session,
				"/v1/organization",
				"PATCH",
				{ defaultRoles: ["super_administrator"] },
			)
			assert.equal(defaults.status, 200, await defaults.text())
			const account = await host.login("new-account")
			assert.equal(
				account.identity.organizationId,
				owner.identity.organizationId,
			)
			assert.notEqual(account.identity.userId, owner.identity.userId)
			const joined = await (
				await request(owner.session, memberPath(account.identity.userId))
			).json()
			assert.deepEqual(joined.roles, ["member"])
			assert.deepEqual(joined.policies, [])
			assert.equal(joined.status, "active")
			assert.equal(
				(await request(account.session, "/auth/session")).status,
				200,
			)
			assert.equal(
				(
					await request(account.session, "/v1/sessions", "POST", {
						title: "My conversation",
					})
				).status,
				201,
			)
			assert.equal(
				(
					await request(account.session, "/v1/organization", "PATCH", {
						name: "Not allowed",
					})
				).status,
				403,
			)
			const token = await (
				await request(account.session, "/v1/user/tokens", "POST", {
					name: "Signup fixture",
				})
			).json()
			assert.equal((await keyed(token.secret, "/v1/sessions")).status, 200)
			const suspended = await request(
				owner.session,
				memberPath(account.identity.userId),
				"PATCH",
				{ status: "suspended" },
			)
			assert.equal(suspended.status, 200)
			assert.equal(
				(await request(account.session, "/auth/session")).status,
				403,
			)
			assert.equal((await keyed(token.secret, "/v1/sessions")).status, 401)
			await assert.rejects(host.login("new-account"))
			assert.equal(
				(
					await request(
						owner.session,
						memberPath(account.identity.userId),
						"DELETE",
					)
				).status,
				204,
			)
			await assert.rejects(host.login("new-account"))
			assert.equal(
				(await request(account.session, "/auth/session")).status,
				403,
			)
			const stored = await pool.query(
				"SELECT status,roles,policies FROM openbot_members WHERE user_id=$1",
				[account.identity.userId],
			)
			assert.deepEqual(stored.rows, [
				{ status: "removed", roles: "[]", policies: "[]" },
			])
		} finally {
			await pool.end()
			await host.close()
		}
	},
)

test(
	"signup checks for an active owner after taking the member lock",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			organization: { ...managed, allowMemberSignup: true },
		})
		const pool = new Pool({ connectionString: host.databaseUrl })
		const locked = await pool.connect()
		let pending: Promise<boolean> | undefined
		try {
			const owner = await host.login("owner")
			await locked.query("BEGIN")
			await locked.query(
				"SELECT pg_advisory_xact_lock(hashtextextended('openbot-members', 0))",
			)
			// Simulate a restored organization whose only owner is no longer active.
			await locked.query(
				"UPDATE openbot_members SET status='suspended' WHERE user_id=$1",
				[owner.identity.userId],
			)
			pending = host.login("waiting-account").then(
				() => true,
				() => false,
			)
			let waiting = false
			for (let i = 0; i < 200; i++) {
				const result = await pool.query(
					"SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%openbot-members%'",
				)
				if (result.rows.length > 0) {
					waiting = true
					break
				}
				await setTimeout(10)
			}
			assert.equal(waiting, true, "Signup must wait for the same member lock")
			await locked.query("COMMIT")
			assert.equal(await pending, false)
			await assert.rejects(host.login("another-account"))
			assert.deepEqual(
				(await pool.query("SELECT user_id,status FROM openbot_members")).rows,
				[{ user_id: owner.identity.userId, status: "suspended" }],
			)
		} finally {
			await locked.query("ROLLBACK")
			if (pending !== undefined) await pending
			locked.release()
			await pool.end()
			await host.close()
		}
	},
)

test(
	"concurrent admission uses account IDs and creates one ordinary membership",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			organization: {
				allowFirstLoginAdmin: false,
				allowMemberSignup: true,
				ownerUserIds: ["OwnerCase"],
				allowedEmailDomains: [],
			},
		})
		const pool = new Pool({ connectionString: host.databaseUrl })
		try {
			for (const id of ["OwnerCase", "OtherAccount"])
				await pool.query(
					"INSERT INTO openbot_auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,$1,$2,true,now(),now())",
					[id, id + "@identity.example"],
				)
			const admit = (id: string) =>
				host.runtime.runPromise(
					Effect.flatMap(Organization, (organization) =>
						organization.admit({
							id,
							email: "same-profile@example.com",
							emailVerified: true,
						}),
					),
				)
			const owner = await admit("OwnerCase")
			const results = await Promise.all([
				admit("OtherAccount"),
				admit("OtherAccount"),
			])
			assert.deepEqual(results.map((value) => value.joined).sort(), [
				false,
				true,
			])
			assert.ok(
				results.every((value) => value.organizationId === owner.organizationId),
			)
			const stored = await pool.query(
				"SELECT user_id,roles,policies FROM openbot_members ORDER BY user_id",
			)
			assert.deepEqual(stored.rows, [
				{ user_id: "OtherAccount", roles: '["member"]', policies: "[]" },
				{
					user_id: "OwnerCase",
					roles: '["super_administrator"]',
					policies: "[]",
				},
			])
			assert.equal(
				(
					await pool.query(
						"SELECT count(*)::int AS count FROM openbot_audit_logs WHERE actor_user_id=$1 AND action='member.joined'",
						["OtherAccount"],
					)
				).rows[0].count,
				1,
			)
		} finally {
			await pool.end()
			await host.close()
		}
	},
)
