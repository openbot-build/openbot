import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

export class SecretStorageError extends Schema.TaggedError<SecretStorageError>()(
	"SecretStorageError",
	{},
) {}
/** `OPENBOT_SECRET_KEYS` is missing or has the wrong form. */
export class SecretKeysInvalid extends Schema.TaggedError<SecretKeysInvalid>()(
	"SecretKeysInvalid",
	{ message: Schema.String },
) {}

/**
 * Encrypts the secrets that OpenBot keeps in the database, such as App secrets,
 * model provider keys and SSO client secrets.
 * The `binding` is the place of the secret, such as a table and a row ID.
 * A secret only opens with the same binding, so nobody can move it to another row.
 */
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
>()("@openbot-build/openbot/secrets/Secrets") {}

const KeyId = /^[a-z0-9_-]{1,32}$/
const KeyHex = /^[a-fA-F0-9]{64}$/

/**
 * Reads a key list like `k2:<hex>,k1:<hex>`. Each key is 32 bytes as 64 hexadecimal characters.
 * The first key encrypts. Every key can decrypt, so instances can change keys one at a time.
 */
export const parseKeys = (
	value: string,
): Effect.Effect<
	{
		readonly current: string
		readonly keys: ReadonlyMap<string, Buffer>
	},
	SecretKeysInvalid
> =>
	Effect.gen(function* () {
		const keys = new Map<string, Buffer>()
		const entries = value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "")
		for (const entry of entries) {
			const [id, hex, ...rest] = entry.split(":")
			if (
				id === undefined ||
				hex === undefined ||
				rest.length > 0 ||
				!KeyId.test(id) ||
				!KeyHex.test(hex)
			)
				return yield* SecretKeysInvalid.make({
					message:
						"Each entry of OPENBOT_SECRET_KEYS must be <id>:<64 hexadecimal characters>.",
				})
			if (keys.has(id))
				return yield* SecretKeysInvalid.make({
					message: `The key ID ${id} appears twice in OPENBOT_SECRET_KEYS.`,
				})
			keys.set(id, Buffer.from(hex, "hex"))
		}
		const current = entries[0]?.split(":")[0]
		if (current === undefined)
			return yield* SecretKeysInvalid.make({
				message: "OPENBOT_SECRET_KEYS must name at least one key.",
			})
		return { current, keys }
	})

/** A sealed value is `<key id>.<base64 of nonce, tag and cipher text>`. */
export const make = (secret: Redacted.Redacted<string>) =>
	Effect.map(parseKeys(Redacted.value(secret)), ({ current, keys }) =>
		Secrets.of({
			seal: (value, binding) =>
				Effect.try({
					try: () => {
						// `parseKeys` checked that the current key exists.
						const key = keys.get(current)!
						const nonce = randomBytes(12)
						const cipher = createCipheriv("aes-256-gcm", key, nonce)
						cipher.setAAD(Buffer.from(binding))
						const body = Buffer.concat([
							cipher.update(value, "utf8"),
							cipher.final(),
						])
						return (
							current +
							"." +
							Buffer.concat([nonce, cipher.getAuthTag(), body]).toString(
								"base64",
							)
						)
					},
					catch: () => SecretStorageError.make({}),
				}),
			open: (value, binding) =>
				Effect.try({
					try: () => {
						const dot = value.indexOf(".")
						const key = keys.get(value.slice(0, dot))
						if (dot < 0 || key === undefined)
							throw new Error("The key of this secret is not configured")
						const bytes = Buffer.from(value.slice(dot + 1), "base64")
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
		}),
	)

/** The keys come from the instance configuration. They never leave this Layer. */
export const layer = (secret: Redacted.Redacted<string>) =>
	Layer.effect(Secrets, make(secret))

/** The last characters of a secret, so people can tell keys apart without seeing them. */
export const hint = (value: string) =>
	value.length < 12 ? null : "…" + value.slice(-4)
