import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { DomainControl } from "../src/apps/DomainControl.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie } from "./Caller.ts"

const publicOrigin = "https://api.example.com"

it(
	"SSO connections use only verified domains, hide their secrets and keep their domains",
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
			const connection = {
				name: "Company",
				issuer: "https://sso.example.com",
				clientId: "openbot",
				clientSecret: "sso-secret-0123456789",
				domains: ["example.com"],
				enforce: false,
			}
			const unverified = await account(
				alice.session,
				"/v1/organization/sso_connections",
				"POST",
				connection,
			)
			assert.strictEqual(unverified.status, 400)
			assert.strictEqual((await unverified.json())._tag, "SsoConnectionInvalid")

			const domain = await (
				await account(alice.session, "/v1/organization/domains", "POST", {
					domain: "example.com",
				})
			).json()
			records = [domain.recordValue]
			await account(
				alice.session,
				"/v1/organization/domains/example.com/verify",
				"POST",
			)
			const created = await account(
				alice.session,
				"/v1/organization/sso_connections",
				"POST",
				connection,
			)
			assert.strictEqual(created.status, 200, await created.clone().text())
			const value = await created.json()
			assert.deepStrictEqual(value.clientSecret, { set: true, hint: "…6789" })
			assert.strictEqual(JSON.stringify(value).includes("sso-secret"), false)
			assert.strictEqual(
				value.redirectUri,
				publicOrigin + "/auth/callback/" + value.id,
			)

			const inUse = await account(
				alice.session,
				"/v1/organization/domains/example.com",
				"DELETE",
			)
			assert.strictEqual((await inUse.json())._tag, "DomainInUse")
			const stale = await account(
				alice.session,
				"/v1/organization/sso_connections/" + value.id,
				"PATCH",
				{ expectedVersion: value.version + 1, enforce: false },
			)
			assert.strictEqual((await stale.json())._tag, "SsoConnectionConflict")

			// Without an email, sign-in goes to the provider of the platform.
			const start = await fetch(host.address + "/auth/sign-in", {
				method: "POST",
				headers: { origin: publicOrigin, "content-type": "application/json" },
				body: JSON.stringify({ returnTo: "/" }),
			})
			assert.strictEqual(start.status, 200, await start.clone().text())
			assert.strictEqual(
				new URL((await start.json()).url).origin,
				"https://id.example.com",
			)

			// When the connection enforces SSO, an account of that domain that signed in
			// through the platform provider loses access. Every instance learns it soon.
			const enforced = await account(
				alice.session,
				"/v1/organization/sso_connections/" + value.id,
				"PATCH",
				{ expectedVersion: value.version, enforce: true },
			)
			assert.strictEqual(enforced.status, 200, await enforced.clone().text())
			let status = 200
			for (let attempt = 0; status === 200 && attempt < 100; attempt++) {
				status = (await account(alice.session, "/v1/organization")).status
				if (status === 200)
					await new Promise((resolve) => setTimeout(resolve, 50))
			}
			assert.strictEqual(status, 401)
		} finally {
			await host.close()
		}
	},
)
