import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option, Redacted, String as Str } from "effect"
import * as OpenBot from "../src/app/OpenBot.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PlatformAdminsPostgres from "../src/platform/PlatformAdminsPostgres.ts"
import * as Setup from "../src/platform/Setup.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as PostgresTest from "./PostgresTest.ts"

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	it.effect(
		"forced bootstrap preserves existing OAuth and signing configuration when only signup changes",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const options = {
					databaseUrl: Redacted.make(database.url),
					secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
				}
				yield* DatabasePostgres.migrate.pipe(
					Effect.provide(DatabasePostgres.layer(options)),
				)
				const context = yield* Layer.buildWithMemoMap(
					PlatformAdminsPostgres.layer.pipe(
						Layer.provideMerge(OpenBot.layerShared(options)),
						Layer.provideMerge(NodeServices.layer),
					),
					yield* Layer.makeMemoMap,
					yield* Effect.scope,
				)
				yield* Effect.gen(function* () {
					const settings = yield* Settings
					const base = {
						publicOrigin: "https://app.example.com",
						adminEmails: ["root@example.com"],
						authSecret: Option.some(
							Redacted.make("existing-signing-secret-32-characters"),
						),
						fileStorage: Option.none(),
						force: false,
					}
					assert.strictEqual(
						yield* Setup.run({
							...base,
							browserAuth: {
								sessionCookie: "__Host-old-session",
								loginCookie: "__Host-old-login",
								sessionTtlMs: 86400000,
							},
							identityProvider: Option.some({
								providerId: "primary",
								callbackPath: "/auth/callback",
								scopes: ["openid", "profile", "email", "offline_access"],
								issuer: "https://id.example.com",
								clientId: "existing",
								clientSecret: Option.some(
									Redacted.make("existing-provider-secret"),
								),
							}),
						}),
						"created",
					)
					const original = Option.getOrThrow(yield* settings.platform).document
					assert.strictEqual(
						yield* Setup.run({
							...base,
							force: true,
							authSecret: Option.none(),
							identityProvider: Option.none(),
							memberSignupOrganizationId: "org_public",
						}),
						"replaced",
					)
					const retained = Option.getOrThrow(yield* settings.platform).document
					assert.deepStrictEqual(
						retained.identityProvider,
						original.identityProvider,
					)
					assert.strictEqual(retained.authSecret, original.authSecret)
					assert.deepStrictEqual(retained.browserAuth, original.browserAuth)
					assert.strictEqual(retained.memberSignupOrganizationId, "org_public")
					// Re-specifying a public identity without a new secret does not clear its existing credential.
					yield* Setup.run({
						...base,
						force: true,
						authSecret: Option.none(),
						identityProvider: Option.some({
							issuer: "https://id.example.com",
							clientId: "existing",
							clientSecret: Option.none(),
						}),
					})
					assert.deepStrictEqual(
						Option.getOrThrow(yield* settings.platform).document
							.identityProvider,
						original.identityProvider,
					)
					// Changing the provider identity does not leak the previous provider credential.
					yield* Setup.run({
						...base,
						force: true,
						authSecret: Option.none(),
						identityProvider: Option.some({
							issuer: "https://different.example.com",
							clientId: "public",
							clientSecret: Option.none(),
						}),
					})
					assert.strictEqual(
						Option.getOrThrow(yield* settings.platform).document
							.identityProvider?.clientSecret,
						null,
					)
				}).pipe(Effect.provideContext(context))
			}),
		{ timeout: 60000 },
	)
})
