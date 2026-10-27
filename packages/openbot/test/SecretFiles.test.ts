import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	Config,
	ConfigProvider,
	Effect,
	FileSystem,
	Layer,
	Path,
	Redacted,
} from "effect"
import * as SecretFiles from "../src/configuration/SecretFiles.ts"

layer(NodeServices.layer)((it) => {
	it.effect(
		"settings come from secret files when the environment does not set them",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const folder = yield* fs.makeTempDirectoryScoped({
					prefix: "openbot-secrets-",
				})
				yield* fs.writeFileString(
					path.join(folder, "OPENBOT_SECRET_KEYS"),
					"from-file\n",
				)
				yield* fs.writeFileString(
					path.join(folder, "OPENBOT_DATABASE_URL"),
					"postgres://file",
				)
				yield* fs.writeFileString(
					path.join(folder, "OPENBOT_SETUP_OIDC_CLIENT_SECRET"),
					"",
				)
				const load = Config.all({
					secret: Config.Redacted("OPENBOT_SECRET_KEYS"),
					databaseUrl: Config.Redacted("OPENBOT_DATABASE_URL"),
					clientSecret: Config.Redacted(
						"OPENBOT_SETUP_OIDC_CLIENT_SECRET",
					).pipe(Config.withDefault(undefined)),
					missing: Config.String("OPENBOT_NOT_SET").pipe(
						Config.withDefault("default"),
					),
				})
				const environment = ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						OPENBOT_DATABASE_URL: "postgres://env",
					}),
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
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const parent = yield* fs.makeTempDirectoryScoped({
				prefix: "openbot-secrets-",
			})
			yield* Effect.gen(function* () {
				const value = yield* Config.String("OPENBOT_SECRET_KEYS").pipe(
					Config.withDefault("unset"),
				)
				assert.strictEqual(value, "unset")
			}).pipe(
				Effect.provide(
					SecretFiles.layer(path.join(parent, "no-such-folder")).pipe(
						Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
					),
				),
			)
		}),
	)
})
