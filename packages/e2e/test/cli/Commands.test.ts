import { assert, layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, Schema, String as Str } from "effect"
import {
	Commands,
	commands,
	type Files,
	makeFiles,
	run,
	SavedConfig,
} from "./Process.ts"

const token = "test-token-do-not-print"
const saved = {
	url: "https://openbot.example.invalid",
	machineId: "test-machine",
	token,
}

const writeConfig = Effect.fn("writeConfig")(function* (
	files: Files,
	value = saved,
) {
	const fs = yield* FileSystem.FileSystem
	const text = yield* Schema.encodeEffect(SavedConfig)(value)
	yield* fs.writeFileString(files.configFile, text, { mode: 0o600 })
	return text
})

// These tests run built programs, so they use the real clock.
layer(commands, { excludeTestServices: true })((it) => {
	it.effect("help finds the installed computer command", () =>
		Effect.gen(function* () {
			const files = yield* makeFiles
			yield* Effect.forEach([[], ["help"], ["--help"], ["-h"]], (args) =>
				Effect.gen(function* () {
					const result = yield* run(files, args)
					assert.strictEqual(result.code, 0)
					assert.match(result.stdout, /^Usage: openbot <command>/)
					assert.match(result.stdout, /^ {2}computer$/m)
					assert.strictEqual(result.stderr, "")
				}),
			)
		}),
	)

	it.effect("computer help and version work through both commands", () =>
		Effect.gen(function* () {
			const files = yield* makeFiles
			const { computerVersion } = yield* Commands
			const direct = yield* run(files, ["--help"], "openbot-computer")
			assert.strictEqual(direct.code, 0)
			assert.strictEqual(direct.stderr, "")
			for (const command of ["pair", "connect", "status"]) {
				assert.include(direct.stdout, command)
			}
			for (const args of [
				["help", "computer"],
				["computer", "--help"],
			]) {
				const result = yield* run(files, args)
				assert.deepStrictEqual(result, direct)
			}
			for (const command of ["openbot", "openbot-computer"] as const) {
				const result = yield* run(
					files,
					command === "openbot" ? ["computer", "--version"] : ["--version"],
					command,
				)
				assert.deepStrictEqual(result, {
					code: 0,
					stdout: `openbot-computer v${computerVersion}\n`,
					stderr: "",
				})
			}
		}),
	)

	it.effect("each computer command gives help before reading config", () =>
		Effect.gen(function* () {
			const files = yield* makeFiles
			const fs = yield* FileSystem.FileSystem
			yield* fs.writeFileString(files.configFile, "{ broken")
			for (const command of ["pair", "connect", "status"]) {
				const result = yield* run(files, ["computer", command, "--help"])
				assert.strictEqual(result.code, 0)
				assert.include(result.stdout, `openbot-computer ${command}`)
				assert.strictEqual(result.stderr, "")
			}
		}),
	)

	it.effect("unknown names and paths cannot run a command", () =>
		Effect.gen(function* () {
			const files = yield* makeFiles
			for (const name of ["e2e-no-command", "../computer", "/computer"]) {
				const result = yield* run(files, [name])
				assert.strictEqual(result.code, 1)
				assert.strictEqual(result.stdout, "")
				assert.include(result.stderr, `'${name}' is not a command`)
				assert.include(result.stderr, "openbot help")
			}
		}),
	)

	it.effect("an unknown computer command gives a clear error", () =>
		Effect.gen(function* () {
			const files = yield* makeFiles
			const result = yield* run(files, ["computer", "e2e-no-command"])
			assert.strictEqual(result.code, 1)
			assert.include(result.stderr, "e2e-no-command")
			assert.notInclude(result.stderr, "ERR_MODULE_NOT_FOUND")
		}),
	)

	it.effect("pair needs an address and rejects bad addresses", () =>
		Effect.gen(function* () {
			const files = yield* makeFiles
			const fs = yield* FileSystem.FileSystem
			const missing = yield* run(files, ["computer", "pair"])
			assert.strictEqual(missing.code, 1)
			assert.include(missing.stderr, "Missing required flag: --url")
			for (const url of ["not-an-address", "ftp://example.invalid", ""]) {
				const result = yield* run(files, ["computer", "pair", "--url", url])
				assert.strictEqual(result.code, 1)
				assert.include(result.stderr, "is not an OpenBot address")
				assert.strictEqual(result.stdout, "")
			}
			assert.isFalse(yield* fs.exists(files.configFile))
		}),
	)

	it.effect(
		"status and connect give the next step on an unpaired machine",
		() =>
			Effect.gen(function* () {
				const files = yield* makeFiles
				const fs = yield* FileSystem.FileSystem
				for (const command of ["status", "connect"]) {
					const result = yield* run(files, ["computer", command])
					assert.strictEqual(result.code, 1)
					assert.strictEqual(result.stdout, "")
					assert.include(result.stderr, "This machine is not paired.")
					assert.include(result.stderr, "openbot computer pair --url")
				}
				assert.isFalse(yield* fs.exists(files.configFile))
			}),
	)

	it.effect("status reads the saved machine and never prints its token", () =>
		Effect.gen(function* () {
			const files = yield* makeFiles
			const fs = yield* FileSystem.FileSystem
			const before = yield* writeConfig(files)
			for (const args of [
				["computer", "status"],
				["computer", "status", "--log-level", "all"],
			]) {
				const result = yield* run(files, args)
				assert.strictEqual(result.code, 0)
				assert.strictEqual(
					result.stdout,
					Arr.join(
						[
							`OpenBot: ${saved.url}`,
							`Machine ID: ${saved.machineId}`,
							`Config file: ${files.configFile}`,
							"",
						],
						"\n",
					),
				)
				assert.strictEqual(result.stderr, "")
				assert.notInclude(result.stdout + result.stderr, token)
			}
			assert.strictEqual(yield* fs.readFileString(files.configFile), before)
		}),
	)

	it.effect("a large token stays out of status output", () =>
		Effect.gen(function* () {
			const files = yield* makeFiles
			const largeToken = Str.repeat(16_384)(token)
			yield* writeConfig(files, { ...saved, token: largeToken })
			const result = yield* run(files, ["computer", "status"])
			assert.strictEqual(result.code, 0)
			assert.include(result.stdout, `Machine ID: ${saved.machineId}`)
			assert.isBelow(result.stdout.length, 1_024)
			assert.notInclude(result.stdout + result.stderr, token)
			assert.strictEqual(result.stderr, "")
		}),
	)

	it.effect(
		"bad saved data gives a repair step without printing the data",
		() =>
			Effect.gen(function* () {
				const files = yield* makeFiles
				const fs = yield* FileSystem.FileSystem
				for (const data of [
					`{"token":"${token}",`,
					`{"token":"${token}","url":12,"machineId":"test-machine"}`,
					"{}",
					"",
				]) {
					yield* fs.writeFileString(files.configFile, data)
					for (const command of ["status", "connect"]) {
						const result = yield* run(files, ["computer", command])
						assert.strictEqual(result.code, 1)
						assert.strictEqual(result.stdout, "")
						assert.include(
							result.stderr,
							`${files.configFile} is not a valid config`,
						)
						assert.include(result.stderr, "openbot computer pair")
						assert.notInclude(result.stderr, token)
					}
					assert.strictEqual(yield* fs.readFileString(files.configFile), data)
				}
			}),
	)

	it.effect("a folder in place of the config file gives a read error", () =>
		Effect.gen(function* () {
			const files = yield* makeFiles
			const fs = yield* FileSystem.FileSystem
			yield* fs.makeDirectory(files.configFile)
			const result = yield* run(files, ["computer", "status"])
			assert.strictEqual(result.code, 1)
			assert.strictEqual(result.stdout, "")
			assert.include(result.stderr, `Could not read ${files.configFile}`)
			assert.notInclude(result.stderr, "This machine is not paired")
		}),
	)
})
