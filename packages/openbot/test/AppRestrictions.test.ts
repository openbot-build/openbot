import { assert, it } from "@effect/vitest"
import { Settings as Api } from "@openbot-build/api"
import { AppIndex } from "@openbot-build/domain"
import { Effect, HashMap, Layer, Option, Ref } from "effect"
import * as Governance from "../src/apps/Governance.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"

it.effect(
	"App checks fail closed and each list keeps one restriction snapshot",
	() =>
		Effect.gen(function* () {
			const source = yield* Settings.pipe(
				Effect.provide(
					OrganizationFixture.layerSettings({
						publicOrigin: "https://openbot.test",
					}),
				),
			)
			const platform = Option.getOrThrow(yield* source.platform)
			const restriction: AppIndex.Restriction = {
				cardUrl: "https://example.test/card",
				reason: "App blocked",
				appealUrl: "https://openbot.test/appeal",
			}
			const document = yield* Ref.make(platform)
			const available = yield* Ref.make(false)
			const settings = Layer.succeed(Settings, {
				...source,
				platform: Effect.gen(function* () {
					if (!(yield* Ref.get(available)))
						return yield* Api.SettingsUnavailable.make({})
					return Option.some(yield* Ref.get(document))
				}),
			})
			yield* Effect.gen(function* () {
				const governance = yield* Governance.Governance
				assert.strictEqual(
					(yield* governance.check(restriction.cardUrl).pipe(Effect.flip))._tag,
					"ExperienceStorageUnavailable",
				)
				yield* Ref.set(available, true)
				yield* Ref.set(document, {
					...platform,
					document: { ...platform.document, appRestrictions: [restriction] },
				})
				const snapshot = yield* governance.snapshot
				assert.strictEqual(
					(yield* governance.check(restriction.cardUrl).pipe(Effect.flip))._tag,
					"AppRestricted",
				)
				yield* Ref.set(document, platform)
				yield* governance.check(restriction.cardUrl)
				assert.deepStrictEqual(
					Option.getOrThrow(HashMap.get(snapshot, restriction.cardUrl)),
					restriction,
				)
				assert.ok(Option.isNone(yield* governance.find(restriction.cardUrl)))
				yield* Ref.set(available, false)
				assert.strictEqual(
					(yield* governance.find(restriction.cardUrl).pipe(Effect.flip))._tag,
					"ExperienceStorageUnavailable",
				)
			}).pipe(Effect.provide(Governance.layer.pipe(Layer.provide(settings))))
		}),
)
