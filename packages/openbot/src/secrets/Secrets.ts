// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no API for AES-GCM ciphers.
import { createCipheriv, createDecipheriv } from "node:crypto"
import {
	Array as Arr,
	Context,
	Crypto,
	Effect,
	HashMap,
	Layer,
	Option,
	pipe,
	Redacted,
	Schema,
	String as Str,
} from "effect"

export class SecretStorageError extends Schema.TaggedError<
	SecretStorageError,
	{ readonly brand: unique symbol }
>()("SecretStorageError", {
	cause: Schema.optional(Schema.Defect()),
	message: Schema.optional(Schema.String),
}) {}
/** `OPENBOT_SECRET_KEYS` is missing or has the wrong form. */
export class SecretKeysInvalid extends Schema.TaggedError<
	SecretKeysInvalid,
	{ readonly brand: unique symbol }
>()("SecretKeysInvalid", { message: Schema.String }) {}

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

/** The ID of one key, such as `k2`. */
const KeyId = Schema.String.check(Schema.isPattern(/^[a-z0-9_-]{1,32}$/))
const isKeyId = Schema.is(KeyId)

/** One entry of the key list: `<id>:<64 hexadecimal characters>`. */
const decodeEntry = Schema.decodeUnknownOption(
	Schema.TemplateLiteralParser([
		KeyId,
		":",
		Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/)),
	]),
)

/**
 * Reads a key list like `k2:<hex>,k1:<hex>`. Each key is 32 bytes as 64 hexadecimal characters.
 * The first key encrypts. Every key can decrypt, so instances can change keys one at a time.
 */
export const parseKeys = (
	value: string,
): Effect.Effect<
	{
		readonly current: { readonly id: string; readonly key: Buffer }
		readonly keys: HashMap.HashMap<string, Buffer>
	},
	SecretKeysInvalid
> =>
	Effect.gen(function* () {
		const entries = pipe(
			Str.split(value, ","),
			Arr.map(Str.trim),
			Arr.filter(Str.isNonEmpty),
		)
		const decoded = yield* Effect.forEach(entries, (entry) =>
			Option.match(decodeEntry(entry), {
				onNone: () =>
					Effect.fail(
						SecretKeysInvalid.make({
							message:
								"Each entry of OPENBOT_SECRET_KEYS must be <id>:<64 hexadecimal characters>.",
						}),
					),
				onSome: ([id, , hex]) =>
					Effect.succeed({ id, key: Buffer.from(hex, "hex") }),
			}),
		)
		const keys = yield* Effect.reduce(
			decoded,
			() => HashMap.empty<string, Buffer>(),
			(keys, { id, key }) =>
				HashMap.has(keys, id)
					? Effect.fail(
							SecretKeysInvalid.make({
								message: `The key ID ${id} appears twice in OPENBOT_SECRET_KEYS.`,
							}),
						)
					: Effect.succeed(HashMap.set(keys, id, key)),
		)
		// A HashMap has no order, so the first key comes from the list.
		const current = yield* Arr.match(decoded, {
			onEmpty: () =>
				Effect.fail(
					SecretKeysInvalid.make({
						message: "OPENBOT_SECRET_KEYS must name at least one key.",
					}),
				),
			onNonEmpty: (all) => Effect.succeed(Arr.headNonEmpty(all)),
		})
		return { current, keys }
	})

/** A sealed value is `<key id>.<base64 of nonce, tag and cipher text>`. */
export const make = (secret: Redacted.Redacted<string>) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto
		const { current, keys } = yield* parseKeys(Redacted.value(secret))
		return Secrets.of({
			seal: (value, binding) =>
				crypto.randomBytes(12).pipe(
					Effect.orDie,
					Effect.flatMap((nonce) =>
						Effect.try({
							try: () => {
								const cipher = createCipheriv("aes-256-gcm", current.key, nonce)
								cipher.setAAD(Buffer.from(binding))
								const body = Buffer.concat([
									cipher.update(value, "utf8"),
									cipher.final(),
								])
								return (
									current.id +
									"." +
									Buffer.concat([nonce, cipher.getAuthTag(), body]).toString(
										"base64",
									)
								)
							},
							catch: (cause) => SecretStorageError.make({ cause }),
						}),
					),
				),
			open: (value, binding) => {
				const dot = Str.indexOf(".")(value)
				if (Option.isNone(dot))
					return Effect.fail(
						SecretStorageError.make({
							message: "The sealed value has no key ID.",
						}),
					)
				const id = Str.slice(0, dot.value)(value)
				const key = HashMap.get(keys, id)
				// The message names the ID only when it has the form of a key ID, so
				// text from a value that was never sealed does not go to the log.
				if (Option.isNone(key))
					return Effect.fail(
						SecretStorageError.make({
							message: isKeyId(id)
								? `The key ID ${id} of a stored secret is not in OPENBOT_SECRET_KEYS.`
								: "The sealed value has no valid key ID.",
						}),
					)
				const body = Str.slice(dot.value + 1)(value)
				return Effect.try({
					try: () => {
						const bytes = Buffer.from(body, "base64")
						const cipher = createDecipheriv(
							"aes-256-gcm",
							key.value,
							bytes.subarray(0, 12),
						)
						cipher.setAAD(Buffer.from(binding))
						cipher.setAuthTag(bytes.subarray(12, 28))
						return Buffer.concat([
							cipher.update(bytes.subarray(28)),
							cipher.final(),
						]).toString("utf8")
					},
					catch: (cause) => SecretStorageError.make({ cause }),
				})
			},
		})
	})

/** The keys come from the instance configuration. They never leave this Layer. */
export const layer = (secret: Redacted.Redacted<string>) =>
	Layer.effect(Secrets, make(secret))

/** The last characters of a secret, so people can tell keys apart without seeing them. */
export const hint = (value: string) =>
	value.length < 12 ? null : "…" + Str.slice(-4)(value)
