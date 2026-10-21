// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Config, ConfigProvider, Effect, Layer, Redacted } from "effect"
import * as SecretFiles from "../src/configuration/SecretFiles.ts"

test("settings come from secret files when the environment does not set them", async () => {
	const folder = await mkdtemp(join(tmpdir(), "openbot-secrets-"))
	try {
		await writeFile(join(folder, "BETTER_AUTH_SECRET"), "from-file\n")
		await writeFile(join(folder, "OPENBOT_DATABASE_URL"), "postgres://file")
		await writeFile(join(folder, "OPENBOT_OIDC_CLIENT_SECRET"), "")
		const load = Config.all({
			secret: Config.Redacted("BETTER_AUTH_SECRET"),
			databaseUrl: Config.Redacted("OPENBOT_DATABASE_URL"),
			clientSecret: Config.Redacted("OPENBOT_OIDC_CLIENT_SECRET").pipe(
				Config.withDefault(undefined),
			),
			missing: Config.String("OPENBOT_MODEL_API_KEY").pipe(
				Config.withDefault("default"),
			),
		})
		const environment = ConfigProvider.layer(
			ConfigProvider.fromUnknown({ OPENBOT_DATABASE_URL: "postgres://env" }),
		)
		await Effect.runPromise(
			Effect.gen(function* () {
				const settings = yield* load
				assert.equal(Redacted.value(settings.secret), "from-file")
				assert.equal(Redacted.value(settings.databaseUrl), "postgres://env")
				assert.equal(settings.clientSecret, undefined)
				assert.equal(settings.missing, "default")
			}).pipe(
				Effect.provide(
					SecretFiles.layer(folder).pipe(Layer.provide(environment)),
				),
			),
		)
	} finally {
		await rm(folder, { recursive: true, force: true })
	}
})

test("a missing secrets folder leaves settings unset", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const value = yield* Config.String("BETTER_AUTH_SECRET").pipe(
				Config.withDefault("unset"),
			)
			assert.equal(value, "unset")
		}).pipe(
			Effect.provide(
				SecretFiles.layer(join(tmpdir(), "openbot-no-such-folder")).pipe(
					Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
				),
			),
		),
	)
})
