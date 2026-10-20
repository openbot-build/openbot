import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

export class SecretStorageError extends Schema.TaggedError<SecretStorageError>()(
	"SecretStorageError",
	{},
) {}
export class AppConfigurationError extends Schema.TaggedError<AppConfigurationError>()(
	"AppConfigurationError",
	{ message: Schema.String },
) {}
export class Secrets extends Context.Service<
	Secrets,
	{
		readonly seal: (
			value: string,
			binding: string,
		) => Effect.Effect<string, SecretStorageError>
		readonly open: (
			value: string,
			binding: string,
		) => Effect.Effect<string, SecretStorageError>
	}
>()("@openbot-build/platform/apps/Secrets") {}

/** The deployment key is stable and set up separately. It never leaves this Layer. */
export const layer = (secret: Redacted.Redacted<string>) =>
	Layer.effect(
		Secrets,
		Effect.gen(function* () {
			const encoded = Redacted.value(secret)
			if (!/^[a-fA-F0-9]{64}$/.test(encoded))
				return yield* AppConfigurationError.make({
					message:
						"OPENBOT_APP_ENCRYPTION_KEY must contain a stable 32-byte hexadecimal key.",
				})
			const key = Buffer.from(encoded, "hex")
			return Secrets.of({
				seal: (value, binding) =>
					Effect.try({
						try: () => {
							const nonce = randomBytes(12)
							const cipher = createCipheriv("aes-256-gcm", key, nonce)
							cipher.setAAD(Buffer.from(binding))
							const body = Buffer.concat([
								cipher.update(value, "utf8"),
								cipher.final(),
							])
							return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString(
								"base64",
							)
						},
						catch: () => SecretStorageError.make({}),
					}),
				open: (value, binding) =>
					Effect.try({
						try: () => {
							const bytes = Buffer.from(value, "base64")
							const cipher = createDecipheriv(
								"aes-256-gcm",
								key,
								bytes.subarray(0, 12),
							)
							cipher.setAAD(Buffer.from(binding))
							cipher.setAuthTag(bytes.subarray(12, 28))
							return Buffer.concat([
								cipher.update(bytes.subarray(28)),
								cipher.final(),
							]).toString("utf8")
						},
						catch: () => SecretStorageError.make({}),
					}),
			})
		}),
	)
