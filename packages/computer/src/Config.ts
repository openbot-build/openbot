// These functions take all their inputs at once. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
	Effect,
	Config as EffectConfig,
	FileSystem,
	Option,
	type PlatformError,
	Schema,
} from "effect"

/** A failure that the person can read and act on. */
export class ComputerError extends Schema.TaggedError<ComputerError>()(
	"ComputerError",
	{ message: Schema.String },
) {}

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

/** What `openbot computer pair` saves. The token is a secret, so only the owner can read the file. */
export const ComputerConfig = Schema.Struct({
	url: Schema.String,
	token: Schema.String,
	machineId: Schema.String,
})
export type ComputerConfig = typeof ComputerConfig.Type

const ConfigJson = Schema.fromJsonString(ComputerConfig)

/** `$XDG_CONFIG_HOME/openbot/computer.json`, or `~/.config/openbot/computer.json`. */
export const pathIn = (
	configHome: Option.Option<string>,
	home: string,
): string =>
	join(
		Option.getOrElse(
			Option.filter(configHome, (base) => base !== ""),
			() => join(home, ".config"),
		),
		"openbot",
		"computer.json",
	)

/** The path of the config file, from the `XDG_CONFIG_HOME` variable. */
export const path: Effect.Effect<string, ComputerError> = Effect.gen(
	function* () {
		const configHome = yield* EffectConfig.option(
			EffectConfig.String("XDG_CONFIG_HOME"),
		)
		return pathIn(configHome, homedir())
	},
).pipe(
	Effect.mapError((error) =>
		ComputerError.make({
			message: `XDG_CONFIG_HOME cannot be read: ${error.message}`,
		}),
	),
)

const cannot =
	(action: string, file: string) => (error: PlatformError.PlatformError) =>
		ComputerError.make({
			message: `Could not ${action} ${file}: ${error.message}`,
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
			Effect.mapError(() =>
				ComputerError.make({
					message: `${file} is not a valid config. Run 'openbot computer pair' again.`,
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
): Effect.Effect<void, ComputerError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const next = `${file}.${process.pid}.tmp`
		yield* fs.makeDirectory(dirname(file), { recursive: true, mode: 0o700 })
		yield* fs.writeFileString(next, `${JSON.stringify(config, null, "\t")}\n`, {
			mode: 0o600,
		})
		// The mode of a new file is changed by the umask, so set it again.
		yield* fs.chmod(next, 0o600)
		yield* fs.rename(next, file)
	}).pipe(Effect.mapError(cannot("write", file)))

/** A new random machine ID: 32 hex characters. */
export const makeMachineId = (): string => randomBytes(16).toString("hex")
