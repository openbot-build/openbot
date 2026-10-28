import { assert, layer } from "@effect/vitest"
import { Array as Arr, Effect, Option } from "effect"
import { Organization } from "../src/organization/Organization.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://app.example.com"
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"public member signup is opt-in, uses verified primary OIDC identities, and never restores removed members",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
				})
				const owner = yield* host.login("alice")
				const other = yield* host.login("other-owner")
				const ssoAccount = yield* host.login("sso-only", undefined, {
					organization: false,
				})
				const before = yield* host.login("before", undefined, {
					organization: false,
				})
				assert.deepStrictEqual(before.memberships, [])
				yield* host.run(
					Effect.gen(function* () {
						const settings = yield* Settings
						const current = Option.getOrThrow(yield* settings.platform)
						yield* settings.updatePlatform(current.version, (document) =>
							Effect.succeed({
								...document,
								memberSignupOrganizationId: owner.identity.organizationId,
							}),
						)
					}),
				)
				// Real login goes through the configured primary OIDC provider, with no test-created organization.
				const joined = yield* host.login("bob", undefined, {
					organization: false,
				})
				assert.strictEqual(joined.memberships.length, 1)
				assert.strictEqual(
					joined.identity.organizationId,
					owner.identity.organizationId,
				)
				assert.deepStrictEqual(joined.memberships[0]?.roles, ["member"])
				const again = yield* host.login("bob", undefined, {
					organization: false,
				})
				assert.strictEqual(again.identity.userId, joined.identity.userId)
				assert.strictEqual(again.memberships.length, 1)
				yield* host.run(
					Effect.gen(function* () {
						const organization = yield* Organization
						for (const [id, verified, trusted] of [
							["unverified", false, true],
							["not-primary", true, false],
						] as const) {
							assert.deepStrictEqual(
								yield* organization.admit(
									{ id, email: id + "@example.net", emailVerified: verified },
									Option.none(),
									{ platformSignIn: trusted },
								),
								[],
							)
						}
						const external = yield* organization.admit(
							{
								id: other.identity.userId,
								email: "owner@another.net",
								emailVerified: true,
							},
							Option.none(),
							{ platformSignIn: true },
						)
						assert.deepStrictEqual(
							Arr.map(external, (member) => member.organizationId),
							[other.identity.organizationId],
						)
						// Even a trusted primary flag cannot cross the explicit organization SSO boundary.
						const sso = yield* organization.admit(
							{
								id: ssoAccount.identity.userId,
								email: "sso@another.net",
								emailVerified: true,
							},
							Option.some(other.identity.organizationId),
							{ platformSignIn: true },
						)
						assert.deepStrictEqual(
							Arr.map(sso, (member) => member.organizationId),
							[other.identity.organizationId],
						)
						const concurrent = yield* Effect.all(
							Arr.makeBy(8, () =>
								organization.admit(
									{
										id: before.identity.userId,
										email: "before@example.com",
										emailVerified: true,
									},
									Option.none(),
									{ platformSignIn: true },
								),
							),
							{ concurrency: "unbounded" },
						)
						assert.ok(
							Arr.every(
								concurrent,
								(memberships) =>
									memberships.length === 1 &&
									memberships[0]?.organizationId ===
										owner.identity.organizationId,
							),
						)
						yield* organization.removeMember(
							owner.identity.organizationId,
							joined.identity.userId,
						)
					}),
				)
				const removed = yield* host.login("bob", undefined, {
					organization: false,
				})
				assert.ok(
					Arr.every(
						removed.memberships,
						(member) => member.status !== "active",
					),
				)
				yield* host.run(
					Effect.gen(function* () {
						const organization = yield* Organization
						yield* organization.setStatus(
							owner.identity.organizationId,
							"suspended",
						)
						assert.deepStrictEqual(
							yield* organization.admit(
								{
									id: "while-suspended",
									email: "new@example.net",
									emailVerified: true,
								},
								Option.none(),
								{ platformSignIn: true },
							),
							[],
						)
					}),
				)
			}),
		{ timeout: 60000 },
	)
})
