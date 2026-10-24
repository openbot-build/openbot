// @effect-diagnostics strictEffectProvide:off
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Config, ConfigProvider, Effect, Layer, Redacted } from "effect"
import * as SecretFiles from "../src/configuration/SecretFiles.ts"

it.effect(
	"settings come from secret files when the environment does not set them",
	() =>
		Effect.gen(function* () {
			const folder = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), "openbot-secrets-"))),
				(folder) =>
					Effect.promise(() => rm(folder, { recursive: true, force: true })),
			)
			yield* Effect.promise(async () => {
				await writeFile(join(folder, "OPENBOT_SECRET_KEYS"), "from-file\n")
				await writeFile(join(folder, "OPENBOT_DATABASE_URL"), "postgres://file")
				await writeFile(join(folder, "OPENBOT_SETUP_OIDC_CLIENT_SECRET"), "")
			})
			const load = Config.all({
				secret: Config.Redacted("OPENBOT_SECRET_KEYS"),
				databaseUrl: Config.Redacted("OPENBOT_DATABASE_URL"),
				clientSecret: Config.Redacted("OPENBOT_SETUP_OIDC_CLIENT_SECRET").pipe(
					Config.withDefault(undefined),
				),
				missing: Config.String("OPENBOT_TLS_CERT").pipe(
					Config.withDefault("default"),
				),
			})
			const environment = ConfigProvider.layer(
				ConfigProvider.fromUnknown({ OPENBOT_DATABASE_URL: "postgres://env" }),
			)
			yield* Effect.gen(function* () {
				const settings = yield* load
				assert.strictEqual(Redacted.value(settings.secret), "from-file")
				assert.strictEqual(
					Redacted.value(settings.databaseUrl),
					"postgres://env",
				)
				assert.strictEqual(settings.clientSecret, undefined)
				assert.strictEqual(settings.missing, "default")
			}).pipe(
				Effect.provide(
					SecretFiles.layer(folder).pipe(Layer.provide(environment)),
				),
			)
		}),
)

it.effect("a missing secrets folder leaves settings unset", () =>
	Effect.gen(function* () {
		const value = yield* Config.String("OPENBOT_SECRET_KEYS").pipe(
			Config.withDefault("unset"),
		)
		assert.strictEqual(value, "unset")
	}).pipe(
		Effect.provide(
			SecretFiles.layer(join(tmpdir(), "openbot-no-such-folder")).pipe(
				Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
			),
		),
	),
)
