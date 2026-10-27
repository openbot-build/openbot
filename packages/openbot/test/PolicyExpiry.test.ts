import { assert, layer } from "@effect/vitest"
import { Authorization, TokenId } from "@openbot-build/domain"
import { Clock, DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Tokens } from "../src/auth/Tokens.ts"
import * as Load from "../src/authorization/Load.ts"
import { PlatformAdmins } from "../src/platform/PlatformAdmins.ts"
import * as Fixture from "./OrganizationFixture.ts"

const services = Layer.mergeAll(
	Fixture.layerEveryoneAdministrator,
	Fixture.layerBuiltinRoles,
	Fixture.layerDefaultSettings,
	Layer.mock(PlatformAdmins, { check: () => Effect.succeed(false) }),
)
layer(services)((it) => {
	it.effect("a saved actor loses its token policy at the expiry time", () =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const actor = {
				kind: "user_token",
				organizationId: "org",
				userId: "user",
				tokenId: TokenId.make("token"),
			} as const
			const check = Load.policyOf(actor, { platform: false }).pipe(
				Effect.provide(
					Layer.mock(Tokens, {
						find: () =>
							Effect.succeedSome({
								id: actor.tokenId,
								name: "test",
								prefix: "obut_test",
								policy: Authorization.emptyPolicy,
								createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
								expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1000)),
								lastUsedAt: null,
							}),
					}),
				),
			)
			assert.notStrictEqual(yield* check, Authorization.emptyPolicy)
			yield* TestClock.adjust("1 second")
			assert.strictEqual(yield* check, Authorization.emptyPolicy)
		}),
	)
})
