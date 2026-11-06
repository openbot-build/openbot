import * as TestDatabase from "@openbot-build/server-database/Testing"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import {
	Effect,
	Layer,
	Option,
	Redacted,
	Result,
	Schedule,
	String as Str,
} from "effect"
import * as Setup from "@openbot-build/plugin-platform/Setup"
import * as PlatformAdminsPostgres from "@openbot-build/plugin-platform/PlatformAdminsPostgres"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as ErrorRecords from "@openbot-build/server-kernel/Records"
import * as Secrets from "@openbot-build/server-kernel/Secrets"
import * as SettingsPostgres from "@openbot-build/server-kernel/SettingsPostgres"

const publicOrigin = "https://api.example.com"

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	it.effect(
		"every instance sees a settings change at once, and setup runs only once",
		() =>
			Effect.gen(function* () {
				const database = yield* TestDatabase.migrated
				/**
				 * Starts one OpenBot instance on the shared database. A new memo map
				 * builds every layer again, as in a new process.
				 */
				const instance = Effect.gen(function* () {
					return yield* Layer.buildWithMemoMap(
						PlatformAdminsPostgres.layer.pipe(
							Layer.provideMerge(SettingsPostgres.layer),
							Layer.provideMerge(ErrorRecords.layer),
							Layer.provideMerge(
								Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
							),
							Layer.provideMerge(
								PgClient.layer({ url: Redacted.make(database.url) }),
							),
							// Setup makes a new sign-in secret with the SecureRandom service.
							Layer.provideMerge(
								Layer.merge(NodeServices.layer, NodeCrypto.layer),
							),
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
