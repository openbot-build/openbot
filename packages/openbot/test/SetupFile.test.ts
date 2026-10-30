import { assert, it } from "@effect/vitest"
import { Effect, Option, Redacted, Schema, String as Str } from "effect"
import { decode } from "../src/platform/SetupFile.ts"

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const base = {
	publicOrigin: "https://api.example.com",
	adminEmails: ["admin@example.com"],
}

it.effect("setup reads shared settings and hides secrets", () =>
	Effect.gen(function* () {
		const input = yield* decode(
			yield* encode({
				...base,
				identityProvider: {
					issuer: "https://id.example.com",
					clientId: "openbot",
					clientSecret: "test client secret",
				},
				fileStorage: {
					endpoint: "https://s3.example.com",
					publicEndpoint: null,
					region: "us-east-1",
					bucket: "files",
					accessKeyId: "test-key",
					secretAccessKey: "test storage secret",
					forcePathStyle: true,
				},
			}),
		)
		assert.strictEqual(input.adminProvider, "oidc")
		assert.isTrue(Option.isSome(input.identityProvider))
		assert.isTrue(Option.isSome(input.fileStorage))
		if (Option.isSome(input.identityProvider)) {
			assert.strictEqual(
				Redacted.value(
					Option.getOrThrow(input.identityProvider.value.clientSecret),
				),
				"test client secret",
			)
		}
		if (Option.isSome(input.fileStorage)) {
			assert.strictEqual(
				Redacted.value(input.fileStorage.value.secretAccessKey!),
				"test storage secret",
			)
		}
		assert.isFalse(Str.includes("test storage secret")(yield* encode(input)))
	}),
)

it.effect(
	"setup accepts email sign-in without an OIDC provider or storage",
	() =>
		Effect.gen(function* () {
			const input = yield* decode(
				yield* encode({ ...base, adminProvider: "email" }),
			)
			assert.strictEqual(input.adminProvider, "email")
			assert.isTrue(Option.isNone(input.identityProvider))
			assert.isTrue(Option.isNone(input.fileStorage))
		}),
)

it.effect(
	"setup rejects missing fields and unknown fields without showing secrets",
	() =>
		Effect.gen(function* () {
			for (const input of [
				{ ...base, adminEmails: [] },
				{ ...base, publicOrigin: "bad secret value" },
				{
					...base,
					identityProvider: {
						issuer: "https://id.example.com",
						clientSecret: "bad secret value",
					},
				},
				{ ...base, fileStorage: { secretAccessKey: "bad secret value" } },
				{ ...base, unknown: "bad secret value" },
			]) {
				const error = yield* decode(yield* encode(input)).pipe(Effect.flip)
				assert.strictEqual(error._tag, "SetupInvalid")
				assert.isFalse(Str.includes("bad secret value")(String(error)))
			}
			const error = yield* decode("bad secret value").pipe(Effect.flip)
			assert.strictEqual(error._tag, "SetupInvalid")
		}),
)
