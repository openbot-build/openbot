import { assert, it } from "@effect/vitest"
import { Authorization } from "@openbot-build/api"
import { Effect, RcMap, Ref } from "effect"
import type { PlatformDocument } from "../src/settings/Documents.ts"
import * as Platform from "../src/settings/Platform.ts"

const document: PlatformDocument = {
	publicOrigin: "https://api.example.com",
	authSecret: "sealed-secret",
	identityProvider: {
		issuer: "https://id.example.com",
		clientId: "client",
		clientSecret: "sealed-client-secret",
		clientSecretHint: "cret",
	},
	organizationCreation: "anyone",
	ceiling: Authorization.emptyPolicy,
	appRestrictions: [],
}

// The sign-in service keeps its Better Auth instances in a map with these keys.
it.effect(
	"equal sign-in settings share one instance, and a new origin, secret or provider gets its own",
	() =>
		Effect.gen(function* () {
			const builds = yield* Ref.make(0)
			const instances = yield* RcMap.make({
				lookup: (key: Platform.SignInSettings) =>
					Effect.as(
						Ref.update(builds, (count) => count + 1),
						key.publicOrigin,
					),
				idleTimeToLive: "1 minute",
			})
			const use = (settings: PlatformDocument) =>
				Effect.scoped(RcMap.get(instances, Platform.signInKey(settings)))

			yield* use(document)
			// A copy of the same settings, and a change to other settings, use the same instance.
			yield* use({ ...document })
			yield* use({ ...document, organizationCreation: "platform_admins" })
			assert.strictEqual(yield* Ref.get(builds), 1)

			assert.strictEqual(
				yield* use({ ...document, publicOrigin: "https://next.example.com" }),
				"https://next.example.com",
			)
			yield* use({ ...document, authSecret: "another-sealed-secret" })
			yield* use({ ...document, identityProvider: null })
			assert.strictEqual(yield* Ref.get(builds), 4)
		}),
)
