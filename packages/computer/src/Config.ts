import { homedir } from "node:os"
import {
	Crypto,
	Effect,
	Config as EffectConfig,
	FileSystem,
	Option,
	Path,
	type PlatformError,
	Predicate,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"

/** A failure that the person can read and act on. */
export class ComputerError extends Schema.TaggedError<
	ComputerError,
	{ readonly brand: unique symbol }
>()("ComputerError", {
	message: Schema.String,
	/** The failure below, such as a file system error. */
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * The text of a Node error, such as "getaddrinfo ENOTFOUND openbot.example.com".
 * It uses the deepest `cause`, because fetch puts the Node error below a "fetch failed" error.
 * When Node cannot connect over IPv4 and IPv6, the message is empty, so it uses the error code.
 */
export const errorText = (error: unknown): Option.Option<string> => {
	if (!(error instanceof Error)) return Option.none()
	return Option.orElse(errorText(error.cause), () =>
		error.message !== ""
			? Option.some(error.message)
			: "code" in error && typeof error.code === "string"
				? Option.some(error.code)
				: Option.none(),
	)
}

/** Makes an origin from what the person typed, or fails with a clear message. */
export const parseOrigin = (
	value: string,
): Effect.Effect<string, ComputerError> =>
	Effect.suspend(() => {
		const url = URL.canParse(value) ? new URL(value) : undefined
		return url !== undefined &&
			(url.protocol === "https:" || url.protocol === "http:") &&
			url.username === "" &&
			url.password === ""
			? Effect.succeed(url.origin)
			: Effect.fail(
					ComputerError.make({
						message: `'${value}' is not an OpenBot address. Use an address such as https://openbot.example.com.`,
					}),
				)
	})

/**
 * What `openbot computer pair` saves. The token is a secret, so only the owner can read the file.
 * In memory the token is `Redacted`, so a log or an error never shows it. The file keeps it as plain text.
 */
export const ComputerConfig = Schema.Struct({
	url: Schema.String,
	token: Schema.RedactedFromValue(Schema.String),
	machineId: Schema.String,
})
export type ComputerConfig = typeof ComputerConfig.Type

const ConfigJson = Schema.fromJsonString(ComputerConfig, { space: "\t" })

/** `$XDG_CONFIG_HOME/openbot/computer.json`, or `~/.config/openbot/computer.json`. */
export const pathIn = (
	configHome: Option.Option<string>,
	home: string,
): Effect.Effect<string, never, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		return path.join(
			Option.getOrElse(
				Option.filter(configHome, (base) => base !== ""),
				() => path.join(home, ".config"),
			),
			"openbot",
			"computer.json",
		)
	})

/** The path of the config file, from the `XDG_CONFIG_HOME` variable. */
export const path: Effect.Effect<string, ComputerError, Path.Path> = Effect.gen(
	function* () {
		const configHome = yield* EffectConfig.option(
			EffectConfig.String("XDG_CONFIG_HOME"),
		)
		return yield* pathIn(configHome, homedir())
	},
).pipe(
	Effect.mapError((error) =>
		ComputerError.make({
			message: `XDG_CONFIG_HOME cannot be read: ${error.message}`,
			cause: error,
		}),
	),
)

/**
 * The message of a file system failure gives only its kind, method and path, such as
 * "Unknown: FileSystem.writeFile (/x)". So this adds the text of the Node error below
 * it, which names the real reason, such as ENOSPC.
 */
export const platformErrorText = (
	error: PlatformError.PlatformError,
): string =>
	Predicate.isError(error.cause)
		? `${error.message}: ${error.cause.message}`
		: error.message

const cannot =
	(action: string, file: string) => (error: PlatformError.PlatformError) =>
		ComputerError.make({
			message: `Could not ${action} ${file}: ${platformErrorText(error)}`,
			cause: error,
		})

/** The saved config, or none when the file does not exist. */
export const read = (
	file: string,
): Effect.Effect<
	Option.Option<ComputerConfig>,
	ComputerError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(file).pipe(
			Effect.asSome,
			Effect.catchIf(
				(error) => error.reason._tag === "NotFound",
				() => Effect.succeedNone,
			),
			Effect.mapError(cannot("read", file)),
		)
		if (Option.isNone(text)) return Option.none()
		return yield* Schema.decodeEffect(ConfigJson)(text.value).pipe(
			Effect.asSome,
			Effect.mapError((error) =>
				ComputerError.make({
					message: `${file} is not a valid config. Run 'openbot computer pair' again.`,
					cause: error,
				}),
			),
		)
	})

/**
 * Saves the config so that only the owner can read and write it (mode 0600).
 * It writes a new file first and then moves it over the old one, so a crash never leaves half a file.
 */
export const write = (
	file: string,
	config: ComputerConfig,
): Effect.Effect<void, ComputerError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		// The config has the type of the schema, so a failure to encode it is a bug.
		const text = yield* Schema.encodeEffect(ConfigJson)(config).pipe(
			Effect.orDie,
		)
		const next = `${file}.${process.pid}.tmp`
		yield* fs.makeDirectory(path.dirname(file), {
			recursive: true,
			mode: 0o700,
		})
		yield* fs.writeFileString(next, `${text}\n`, { mode: 0o600 }).pipe(
			// The mode of a new file is changed by the umask, so set it again.
			Effect.andThen(fs.chmod(next, 0o600)),
			Effect.andThen(fs.rename(next, file)),
			// The new file holds the token. Do not leave it behind when a step fails.
			Effect.onError(() =>
				fs.remove(next, { force: true }).pipe(
					Effect.ignore({
						log: "Warn",
						message: `Could not remove ${next}. It holds the token. Remove it by hand.`,
					}),
				),
			),
			// The file is small, so an interrupt waits for the write to end.
			Effect.uninterruptible,
		)
	}).pipe(Effect.mapError(cannot("write", file)))

/** A new random machine ID: 32 hex characters. */
export const makeMachineId: Effect.Effect<string, never, Crypto.Crypto> =
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto
		// A machine with no secure random numbers cannot pair, so this is a defect.
		const bytes = yield* crypto.randomBytes(16).pipe(Effect.orDie)
		return Hex.encode(bytes)
	})
