import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { Effect, Option, Schema } from "effect"
import { Pool } from "pg"
import { Settings as Api } from "@openbot-build/api"
import { Settings } from "../src/settings/Settings.ts"
import { Organization } from "../src/organization/Organization.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"

const publicOrigin = "https://signup.example.com"
type Host = Awaited<ReturnType<typeof BrowserHost.start>>
const memberPath = (id: string) =>
	"/v1/organization/members/" + encodeURIComponent(id)
const configure = (host: Host, organizationId: string | null) =>
	host.runtime.runPromise(
		Effect.gen(function* () {
			const settings = yield* Settings
			const current = Option.getOrThrow(yield* settings.platform)
			yield* settings.updatePlatform(current.version, (document) =>
				Effect.succeed({
					...document,
					organizationCreation: "platform_admins",
					memberSignupOrganizationId: organizationId,
				}),
			)
		}),
	)

test("member signup needs an explicit organization setting", async () => {
	const decode = Schema.decodeUnknownOption(Api.UpdatePlatformSettingsRequest)
	assert.ok(
		Option.isSome(
			decode({ expectedVersion: 1, memberSignupOrganizationId: null }),
		),
	)
	assert.ok(
		Option.isSome(
			decode({
				expectedVersion: 1,
				memberSignupOrganizationId: "org_explicit",
			}),
		),
	)
	assert.ok(
		Option.isNone(
			decode({ expectedVersion: 1, memberSignupOrganizationId: "" }),
		),
	)
	assert.ok(
		Option.isNone(
			decode({ expectedVersion: 1, memberSignupOrganizationId: true }),
		),
	)
})

test(
	"native signup defaults to off and an uninitialized target never creates a personal organization",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, sharedDomain: false })
		const pool = new Pool({ connectionString: host.databaseUrl })
		try {
			await configure(host, null)
			await assert.rejects(host.login("disabled"))
			await configure(host, "org_missing")
			await assert.rejects(host.login("uninitialized"))
			assert.deepEqual(
				(await pool.query("SELECT id FROM openbot_organizations")).rows,
				[],
			)
			assert.deepEqual(
				(await pool.query("SELECT user_id FROM openbot_members")).rows,
				[],
			)
			await pool.query(
				"INSERT INTO openbot_organizations(id,name,status,created_at) VALUES('org_missing','No owner','active',0)",
			)
			await assert.rejects(host.login("without-owner"))
			assert.deepEqual(
				(await pool.query("SELECT user_id FROM openbot_members")).rows,
				[],
			)
		} finally {
			await pool.end()
			await host.close()
		}
	},
)

test(
	"signup grants only member access and never restores a suspended or removed account",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, sharedDomain: false })
		const pool = new Pool({ connectionString: host.databaseUrl })
		try {
			const request = withCookie({ address: host.address, publicOrigin })
			const keyed = withToken(host.address)
			const owner = await host.login("owner")
			await configure(host, owner.identity.organizationId)
			await host.runtime.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings
					const current = yield* settings.organization(
						owner.identity.organizationId,
					)
					yield* settings.updateOrganization(
						owner.identity.organizationId,
						current.version,
						(document) =>
							Effect.succeed({
								...document,
								defaultRoles: ["super_administrator"],
							}),
					)
				}),
			)
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
			assert.equal(
				(
					await request(
						owner.session,
						memberPath(account.identity.userId),
						"PATCH",
						{ status: "suspended" },
					)
				).status,
				200,
			)
			// Native auth describes memberships; business access is denied immediately.
			assert.equal(
				(await request(account.session, "/auth/session")).status,
				200,
			)
			assert.equal((await request(account.session, "/v1/sessions")).status, 403)
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
			assert.equal((await request(account.session, "/v1/sessions")).status, 403)
			assert.deepEqual(
				(
					await pool.query(
						"SELECT status,roles,policies FROM openbot_members WHERE user_id=$1",
						[account.identity.userId],
					)
				).rows,
				[{ status: "removed", roles: "[]", policies: "[]" }],
			)
		} finally {
			await pool.end()
			await host.close()
		}
	},
)

test(
	"signup checks for an active owner after taking the same member lock",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, sharedDomain: false })
		const pool = new Pool({ connectionString: host.databaseUrl })
		const locked = await pool.connect()
		let pending: Promise<boolean> | undefined
		try {
			const owner = await host.login("owner")
			await configure(host, owner.identity.organizationId)
			await locked.query("BEGIN")
			await locked.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
				["openbot-members:" + owner.identity.organizationId],
			)
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
					"SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'",
				)
				if (result.rows.length > 0) {
					waiting = true
					break
				}
				await setTimeout(10)
			}
			assert.equal(waiting, true, "Signup must wait for the member lock")
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
	"concurrent admission uses exact account IDs and creates one ordinary membership",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, sharedDomain: false })
		const pool = new Pool({ connectionString: host.databaseUrl })
		try {
			const owner = await host.login("owner")
			await configure(host, owner.identity.organizationId)
			await pool.query(
				"INSERT INTO openbot_auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,$1,$2,true,now(),now())",
				["OtherAccount", "other@identity.example"],
			)
			const admit = () =>
				host.runtime.runPromise(
					Effect.flatMap(Organization, (organization) =>
						organization.admit({
							id: "OtherAccount",
							email: "owner@example.com",
							emailVerified: true,
						}),
					),
				)
			const results = await Promise.all([admit(), admit()])
			assert.ok(
				results.every((memberships) =>
					memberships.some(
						(member) =>
							member.organizationId === owner.identity.organizationId &&
							member.roles.length === 1 &&
							member.roles[0] === "member",
					),
				),
			)
			assert.deepEqual(
				(
					await pool.query(
						"SELECT user_id,roles,policies FROM openbot_members WHERE user_id=$1",
						["OtherAccount"],
					)
				).rows,
				[{ user_id: "OtherAccount", roles: '["member"]', policies: "[]" }],
			)
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
