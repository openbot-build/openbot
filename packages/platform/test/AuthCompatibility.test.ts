import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Option, Redacted } from "effect"
import { Pool } from "pg"
import { Organization } from "../src/organization/Organization.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as BrowserRoutes from "../src/auth/BrowserRoutes.ts"

const publicOrigin = "https://client.example.com"
test("browser aliases reject unsafe destinations, duplicate callbacks and cross-origin logout", async () => {
	let calls = 0
	const handler = BrowserRoutes.handler(
		{ publicOrigin, providerId: "kai", callbackPath: "/auth/callback" },
		{
			handler: async (request) => {
				calls++
				assert.equal(new URL(request.url).pathname, "/auth/callback/kai")
				return new Response(null, {
					status: 302,
					headers: { location: publicOrigin + "/sessions/existing" },
				})
			},
			signIn: async (target, headers) => {
				calls++
				assert.equal(target, "/sessions/existing")
				assert.equal(headers.get("cookie"), "__Host-e-login=state")
				return new Response(null, {
					headers: { location: "https://id.example.com/authorize" },
				})
			},
			signOut: async () => {
				calls++
				return new Response(null, { status: 200 })
			},
		},
	)
	for (const target of [
		"//other.example",
		"/auth/login",
		"https://other.example",
	])
		assert.equal(
			(
				await handler(
					new Request(
						publicOrigin + "/auth/login?returnTo=" + encodeURIComponent(target),
					),
				)
			).status,
			400,
		)
	assert.equal(
		(
			await handler(
				new Request(publicOrigin + "/auth/callback?state=a&state=b"),
			)
		).status,
		400,
	)
	assert.equal(
		(
			await handler(
				new Request(publicOrigin + "/auth/logout", {
					method: "POST",
					headers: { origin: "https://other.example" },
				}),
			)
		).status,
		403,
	)
	assert.equal(calls, 0)
	assert.equal(
		(
			await handler(
				new Request(publicOrigin + "/auth/login?returnTo=/sessions/existing", {
					headers: { cookie: "__Host-e-login=state" },
				}),
			)
		).status,
		303,
	)
	assert.equal(
		(
			await handler(
				new Request(publicOrigin + "/auth/callback?code=valid&state=valid"),
			)
		).status,
		303,
	)
	assert.equal(
		(
			await handler(
				new Request(publicOrigin + "/auth/logout", {
					method: "POST",
					headers: { origin: publicOrigin },
				}),
			)
		).status,
		204,
	)
	assert.equal(calls, 3)
})

test(
	"existing cookie and OIDC provider names work through session validation and logout",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			authCompatibility: {
				providerId: "kai",
				callbackPath: "/auth/callback",
				sessionCookie: "__Host-e-session",
				loginCookie: "__Host-e-login",
			},
			organization: {
				ownerEmails: ["alice@example.com"],
				allowFirstLoginAdmin: false,
			},
		})
		try {
			const login = await fetch(
				host.address + "/auth/login?returnTo=/sessions/existing",
				{ redirect: "manual" },
			)
			assert.equal(login.status, 303)
			assert.ok(
				login.headers
					.getSetCookie()
					.some((cookie) => cookie.startsWith("__Host-e-login=")),
			)
			assert.equal(
				new URL(login.headers.get("location")!).searchParams.get(
					"redirect_uri",
				),
				publicOrigin + "/auth/callback",
			)
			const alice = await host.login("alice", "/sessions/existing")
			const cookie =
				"__Host-e-session=" + encodeURIComponent(Redacted.value(alice.session))
			const headers = { cookie, origin: publicOrigin }
			const session = await fetch(
				host.address + "/auth/session?refresh=false",
				{ headers },
			)
			assert.equal(session.status, 200)
			assert.equal(
				(await session.json()).identity.userId,
				alice.identity.userId,
			)
			assert.equal(session.headers.getSetCookie().length, 0)
			assert.equal(
				(await fetch(host.address + "/v1/sessions", { headers })).status,
				200,
			)
			assert.equal(
				(
					await fetch(host.address + "/auth/session", {
						headers: {
							cookie:
								"__Host-openbot-session=" +
								encodeURIComponent(Redacted.value(alice.session)),
						},
					})
				).status,
				401,
			)
			assert.equal(
				(
					await fetch(host.address + "/auth/session", {
						headers: { "x-user-id": alice.identity.userId },
					})
				).status,
				401,
			)
			await assert.rejects(host.login("bob"))
			const logout = await fetch(host.address + "/auth/logout", {
				method: "POST",
				headers,
			})
			assert.equal(logout.status, 204)
			assert.ok(
				logout.headers
					.getSetCookie()
					.some(
						(value) =>
							value.startsWith("__Host-e-session=") && /Max-Age=0/.test(value),
					),
			)
			assert.equal(
				(await fetch(host.address + "/auth/session", { headers })).status,
				401,
			)
		} finally {
			await host.close()
		}
	},
)

test(
	"explicit bootstrap disables first-login ownership",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			organization: {
				allowFirstLoginAdmin: false,
				ownerUserIds: ["KnownOwner"],
				memberUserIds: ["KnownMember"],
			},
		})
		try {
			await assert.rejects(host.login("unknown"))
		} finally {
			await host.close()
		}
	},
)

test(
	"bootstrap user IDs preserve case and assign only their configured roles",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			organization: {
				allowFirstLoginAdmin: false,
				ownerUserIds: ["KnownOwner"],
				memberUserIds: ["KnownMember"],
			},
		})
		const pool = new Pool({ connectionString: host.databaseUrl })
		try {
			for (const id of ["KnownOwner", "KnownMember", "knownowner"])
				await pool.query(
					"INSERT INTO openbot_auth_user (id,name,email,email_verified,created_at,updated_at) VALUES ($1,$1,$2,false,now(),now())",
					[id, id + "@bootstrap.example"],
				)
			const admit = (id: string) =>
				host.runtime.runPromise(
					Effect.flatMap(Organization, (organization) =>
						organization.admit({ id }),
					),
				)
			await assert.rejects(admit("knownowner"))
			const owner = await admit("KnownOwner")
			await admit("KnownMember")
			for (const [id, roles] of [
				["KnownOwner", ["super_administrator"]],
				["KnownMember", ["member"]],
			] as const) {
				const member = await host.runtime.runPromise(
					Effect.flatMap(Organization, (organization) =>
						organization.member(owner.organizationId, id),
					),
				)
				assert.deepEqual(Option.getOrThrow(member).roles, roles)
			}
		} finally {
			await pool.end()
			await host.close()
		}
	},
)
