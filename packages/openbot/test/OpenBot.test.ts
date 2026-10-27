import { ConfigProvider, Effect, Redacted, Result, String as Str } from "effect"
import { assert, it } from "@effect/vitest"
import { NodeCrypto } from "@effect/platform-node"
import { EnvironmentConfiguration } from "@openbot-build/openbot"

import * as Secrets from "../src/secrets/Secrets.ts"

it.effect("an instance reads only its own settings and the secret keys", () =>
	Effect.gen(function* () {
		const load = (values: Record<string, string>) =>
			EnvironmentConfiguration.load.pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown(values),
				),
				Effect.result,
			)
		const required = {
			OPENBOT_DATABASE_URL: "postgres://localhost/db",
			OPENBOT_CLUSTER_SECRET: "test-cluster-secret-with-at-least-32-characters",
			OPENBOT_SECRET_KEYS:
				"k1:1111111111111111111111111111111111111111111111111111111111111111",
		}
		assert.strictEqual((yield* load({}))._tag, "Failure")
		assert.strictEqual(
			(yield* load({ ...required, OPENBOT_PORT: "invalid" }))._tag,
			"Failure",
		)
		const plain = yield* load(required)
		assert.ok(Result.isSuccess(plain))
		assert.strictEqual(plain.success.port, 3000)
	}),
)

it.layer(NodeCrypto.layer)((it) => {
	it.effect("secret keys change one at a time and old secrets still open", () =>
		Effect.gen(function* () {
			const oldKey = "k1:" + Str.repeat(32)("11")
			const newKey = "k2:" + Str.repeat(32)("22")
			const sealed = yield* Effect.flatMap(
				Secrets.make(Redacted.make(oldKey)),
				(secrets) => secrets.seal("provider key", "place"),
			)
			const rotated = yield* Secrets.make(Redacted.make(newKey + "," + oldKey))
			assert.strictEqual(yield* rotated.open(sealed, "place"), "provider key")
			assert.ok(Str.startsWith("k2.")(yield* rotated.seal("next", "place")))
			// A secret only opens in its own place.
			assert.strictEqual(
				(yield* Effect.result(rotated.open(sealed, "other")))._tag,
				"Failure",
			)
			for (const invalid of [
				"",
				"k1:short",
				"k1:" + Str.repeat(32)("11") + ",k1:" + Str.repeat(32)("22"),
			])
				assert.strictEqual(
					(yield* Effect.result(Secrets.parseKeys(invalid)))._tag,
					"Failure",
				)
		}),
	)

	it.effect(
		"a secret whose key is gone fails, and the error names the key",
		() =>
			Effect.gen(function* () {
				const sealed = yield* Effect.flatMap(
					Secrets.make(Redacted.make("k1:" + Str.repeat(32)("11"))),
					(secrets) => secrets.seal("provider key", "place"),
				)
				const rotated = yield* Secrets.make(
					Redacted.make("k2:" + Str.repeat(32)("22")),
				)
				const gone = yield* Effect.flip(rotated.open(sealed, "place"))
				assert.strictEqual(gone._tag, "SecretStorageError")
				assert.strictEqual(
					gone.message,
					"The key ID k1 of a stored secret is not in OPENBOT_SECRET_KEYS.",
				)
				// Text that was never sealed does not go into the error.
				assert.strictEqual(
					(yield* Effect.flip(rotated.open("Some Text.abc", "place"))).message,
					"The sealed value has no valid key ID.",
				)
				assert.strictEqual(
					(yield* Effect.flip(rotated.open("some text", "place"))).message,
					"The sealed value has no key ID.",
				)
			}),
	)
})
