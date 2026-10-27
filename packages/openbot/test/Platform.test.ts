import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	Effect,
	Layer,
	Option,
	Redacted,
	Result,
	Schedule,
	String as Str,
} from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Setup from "../src/platform/Setup.ts"
import * as PlatformAdminsPostgres from "../src/platform/PlatformAdminsPostgres.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as PostgresTest from "./PostgresTest.ts"
import { OpenBot } from "../src/index.ts"

const publicOrigin = "https://api.example.com"

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"every instance sees a settings change at once, and setup runs only once",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const options = {
					databaseUrl: Redacted.make(database.url),
					clusterSecret: Redacted.make(
						"test-cluster-secret-with-at-least-32-characters",
					),
					secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
				}
				// The migration has its own database pool. It closes after the migration.
				yield* DatabasePostgres.migrate.pipe(
					Effect.provide(
						DatabasePostgres.layer(options).pipe(
							Layer.provide(NodeServices.layer),
						),
					),
				)
				/**
				 * Starts one OpenBot instance on the shared database. A new memo map
				 * builds every layer again, as in a new process.
				 */
				const instance = Effect.gen(function* () {
					return yield* Layer.buildWithMemoMap(
						PlatformAdminsPostgres.layer.pipe(
							Layer.provideMerge(OpenBot.layerShared(options)),
							// Setup makes a new sign-in secret with the Crypto service.
							Layer.provideMerge(NodeServices.layer),
						),
						yield* Layer.makeMemoMap,
						yield* Effect.scope,
					)
				})
				const first = yield* instance
				const second = yield* instance
				const setup = (origin: string, force = false) =>
					Setup.run({
						publicOrigin: origin,
						identityProvider: Option.none(),
						adminEmails: ["root@example.com"],
						force,
						authSecret: Option.none(),
						fileStorage: Option.none(),
					}).pipe(Effect.result, Effect.provideContext(first))
				const created = yield* setup(publicOrigin)
				assert.ok(Result.isSuccess(created))
				assert.strictEqual(created.success, "created")
				const again = yield* setup(publicOrigin)
				assert.ok(Result.isSuccess(again))
				assert.strictEqual(again.success, "unchanged")
				const refused = yield* setup("https://other.example.com")
				assert.ok(Result.isFailure(refused))
				assert.strictEqual(refused.failure._tag, "SetupAlreadyDone")

				// The second instance reads the defaults and keeps them in its cache.
				const read = Effect.flatMap(Settings, (settings) =>
					settings.organization("org_shared"),
				).pipe(Effect.provideContext(second))
				assert.strictEqual((yield* read).document.botMemory, true)
				yield* Effect.flatMap(Settings, (settings) =>
					settings.updateOrganization("org_shared", 0, (document) =>
						Effect.succeed({ ...document, botMemory: false }),
					),
				).pipe(Effect.provideContext(first))
				// The notice reaches the second instance long before its cache expires.
				const seen = yield* read.pipe(
					Effect.repeat({
						until: (value) => value.version !== 0,
						schedule: Schedule.spaced("20 millis"),
						times: 100,
					}),
				)
				assert.strictEqual(seen.version, 1)
				assert.strictEqual(seen.document.botMemory, false)
				const conflict = yield* Effect.flatMap(Settings, (settings) =>
					settings.updateOrganization("org_shared", 0, (document) =>
						Effect.succeed(document),
					),
				).pipe(Effect.flip, Effect.provideContext(second))
				assert.strictEqual(conflict._tag, "SettingsConflict")
			}),
	)
})
