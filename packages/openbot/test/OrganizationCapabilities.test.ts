import { assert, layer } from "@effect/vitest"
import {
	AuthApi,
	Authorization,
	OrganizationApi,
	Settings,
	UserTokensApi,
} from "@openbot-build/api"
import { Array as Arr, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Policies from "./Policies.ts"

const publicOrigin = "https://capabilities.example.com"
const path = "/v1/organization/capabilities"
const member = (userId: string) =>
	"/v1/organization/members/" + encodeURIComponent(userId)
const read = (call: Caller.Call) =>
	Caller.read(OrganizationApi.OrganizationCapabilities, call, 200)
const actions = (
	result: OrganizationApi.OrganizationCapabilities,
	kind: string,
) =>
	Arr.flatMap(result.resources, (item) =>
		item.kind === kind ? item.actions : [],
	)

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Members can read their own actions, including when they cannot read the organization",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const address = yield* host.address
				const call = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const all = yield* read(call(alice.session, path))
				assert.strictEqual(all.resources.length, 8)
				assert.deepStrictEqual(actions(all, "Organization"), ["read", "write"])
				assert.deepStrictEqual(actions(all, "Role"), ["write"])
				assert.deepStrictEqual(actions(all, "Usage"), ["read"])
				const initial = yield* read(call(bob.session, path))
				assert.deepStrictEqual(actions(initial, "Organization"), ["read"])
				assert.deepStrictEqual(actions(initial, "Member"), [])
				assert.deepStrictEqual(actions(initial, "ModelProvider"), [])

				assert.strictEqual(
					(yield* call(alice.session, member(bob.identity.userId), "PATCH", {
						roles: ["administrator_read_only"],
						policy: yield* Policies.json(function* (_) {
							yield* _.deny(
								"read",
								Authorization.Organization,
								Policies.inOrganization,
							)
						}),
					})).status,
					200,
				)
				const limited = yield* read(call(bob.session, path))
				assert.deepStrictEqual(actions(limited, "Organization"), [])
				assert.deepStrictEqual(actions(limited, "Member"), ["read"])
				assert.deepStrictEqual(actions(limited, "ModelProvider"), ["read"])
				assert.deepStrictEqual(actions(limited, "Role"), [])
				assert.strictEqual(
					(yield* call(bob.session, "/v1/organization")).status,
					403,
				)
				assert.strictEqual((yield* HttpClient.get(address + path)).status, 401)
				assert.strictEqual(
					(yield* HttpClient.execute(
						HttpClientRequest.get(address + path, {
							headers: {
								cookie: Caller.sessionCookie(bob.session),
								origin: publicOrigin,
								[AuthApi.OrganizationHeader]: "another-organization",
							},
						}),
					)).status,
					403,
				)
				assert.strictEqual(
					(yield* call(alice.session, member(bob.identity.userId), "PATCH", {
						status: "suspended",
					})).status,
					200,
				)
				assert.strictEqual((yield* call(bob.session, path)).status, 403)
			}),
	)

	it.effect("The result follows token limits and the platform ceiling", () =>
		Effect.gen(function* () {
			const host = yield* BrowserHost.start({
				publicOrigin,
				platformAdmins: ["alice@example.com"],
			})
			const address = yield* host.address
			const call = Caller.withCookie({ address, publicOrigin })
			const keyed = Caller.withToken(address)
			const alice = yield* host.login("alice")
			const bob = yield* host.login("bob")
			assert.strictEqual(
				(yield* call(alice.session, member(bob.identity.userId), "PATCH", {
					roles: ["administrator"],
				})).status,
				200,
			)
			const token = yield* Caller.read(
				UserTokensApi.CreatedToken,
				call(bob.session, "/v1/user/tokens", "POST", {
					name: "Organization reader",
					policy: yield* Policies.json(function* (_) {
						yield* _.allow(
							"read",
							Authorization.Organization,
							Policies.inOrganization,
						)
						yield* _.allow(
							["read", "write"],
							Authorization.Member,
							Policies.inOrganization,
						)
					}),
				}),
				201,
			)
			const initial = yield* read(keyed(token.secret, path))
			assert.deepStrictEqual(actions(initial, "Organization"), ["read"])
			assert.deepStrictEqual(actions(initial, "Member"), ["read", "write"])
			assert.deepStrictEqual(actions(initial, "Role"), [])
			assert.deepStrictEqual(actions(initial, "ModelProvider"), [])
			const settings = yield* Caller.read(
				Settings.PlatformSettings,
				call(alice.session, "/v1/platform/settings"),
				200,
			)
			assert.strictEqual(
				(yield* call(alice.session, "/v1/platform/settings", "PATCH", {
					expectedVersion: settings.version,
					ceiling: yield* Policies.json(function* (_) {
						yield* _.deny(
							"write",
							Authorization.Member,
							Policies.inOrganization,
						)
					}),
				})).status,
				200,
			)
			assert.deepStrictEqual(
				actions(yield* read(keyed(token.secret, path)), "Member"),
				["read"],
			)
			assert.deepStrictEqual(
				actions(yield* read(call(alice.session, path)), "Member"),
				["read"],
			)
			assert.strictEqual(
				(yield* keyed(token.secret, member(bob.identity.userId), "PATCH", {
					roles: ["member"],
				})).status,
				403,
			)
		}),
	)
})
