import { BrowserHost, Caller, Outside } from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import { SsoApi } from "@openbot-build/api"
import { Effect, Ref, Schedule, Schema, String as Str } from "effect"
import {
	HttpClient,
	HttpClientRequest,
	type HttpClientResponse,
} from "effect/http"

const publicOrigin = "https://api.example.com"

const SignInStart = Schema.Struct({ url: Schema.String })

const decodeTagged = Schema.decodeUnknownEffect(
	Schema.Struct({ _tag: Schema.String }),
)

/** Gives the `_tag` of the JSON body of an answer. */
const tagOf = (response: HttpClientResponse.HttpClientResponse) =>
	Effect.map(Effect.flatMap(response.json, decodeTagged), (body) => body._tag)

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"SSO connections use only verified domains, hide their secrets and keep their domains",
		() =>
			Effect.gen(function* () {
				const records = yield* Ref.make<ReadonlyArray<string>>([])
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					domainControl: Outside.domainControl({
						tokens: () => Ref.get(records),
					}),
				})
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("alice")
				const connection = {
					name: "Company",
					issuer: "https://sso.example.com",
					clientId: "openbot",
					clientSecret: "sso-secret-0123456789",
					domains: ["example.com"],
					enforce: false,
				}
				const unverified = yield* account(
					alice.session,
					"/v1/organization/sso_connections",
					"POST",
					connection,
				)
				assert.strictEqual(unverified.status, 400)
				assert.strictEqual(yield* tagOf(unverified), "SsoConnectionInvalid")

				const domain = yield* Effect.flatMap(
					account(alice.session, "/v1/organization/domains", "POST", {
						domain: "example.com",
					}),
					Caller.json(SsoApi.Domain),
				)
				yield* Ref.set(records, [domain.recordValue])
				yield* account(
					alice.session,
					"/v1/organization/domains/example.com/verify",
					"POST",
				)
				const created = yield* account(
					alice.session,
					"/v1/organization/sso_connections",
					"POST",
					connection,
				)
				assert.strictEqual(created.status, 200, yield* created.text)
				const value = yield* Caller.json(SsoApi.SsoConnection)(created)
				assert.deepStrictEqual(value.clientSecret, {
					set: true,
					hint: "…6789",
				})
				assert.strictEqual(
					Str.includes("sso-secret")(yield* created.text),
					false,
				)
				assert.strictEqual(
					value.redirectUri,
					publicOrigin + "/auth/callback/" + value.id,
				)

				const inUse = yield* account(
					alice.session,
					"/v1/organization/domains/example.com",
					"DELETE",
				)
				assert.strictEqual(yield* tagOf(inUse), "DomainInUse")
				const stale = yield* account(
					alice.session,
					"/v1/organization/sso_connections/" + value.id,
					"PATCH",
					{ expectedVersion: value.version + 1, enforce: false },
				)
				assert.strictEqual(yield* tagOf(stale), "SsoConnectionConflict")

				// Without an email, sign-in goes to the provider of the platform.
				const start = yield* HttpClientRequest.post(address + "/auth/sign-in", {
					headers: { origin: publicOrigin },
				}).pipe(
					HttpClientRequest.bodyJson({ returnTo: "/" }),
					Effect.flatMap(HttpClient.execute),
				)
				assert.strictEqual(start.status, 200, yield* start.text)
				assert.strictEqual(
					new URL((yield* Caller.json(SignInStart)(start)).url).origin,
					"https://id.example.com",
				)

				// When the connection enforces SSO, an account of that domain that signed in
				// through the platform provider loses access. Every instance learns it soon.
				const enforced = yield* account(
					alice.session,
					"/v1/organization/sso_connections/" + value.id,
					"PATCH",
					{ expectedVersion: value.version, enforce: true },
				)
				assert.strictEqual(enforced.status, 200, yield* enforced.text)
				const status = yield* account(alice.session, "/v1/organization").pipe(
					Effect.map((response) => response.status),
					Effect.repeat({
						while: (status) => status === 200,
						schedule: Schedule.spaced("50 millis"),
						times: 99,
					}),
				)
				assert.strictEqual(status, 401)
			}),
		60000,
	)
})
