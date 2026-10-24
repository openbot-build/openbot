import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, assert, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as Config from "../src/Config.ts"

const folder = mkdtempSync(join(tmpdir(), "openbot-computer-config-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

it("the config file is in XDG_CONFIG_HOME when it is set", () => {
	assert.strictEqual(
		Config.path({ XDG_CONFIG_HOME: "/xdg" }),
		join("/xdg", "openbot", "computer.json"),
	)
	assert.match(
		Config.path({ XDG_CONFIG_HOME: "" }),
		/\.config[/\\]openbot[/\\]computer\.json$/,
	)
})

it.effect("a missing config file reads as none", () =>
	Effect.gen(function* () {
		const config = yield* Config.read(join(folder, "none.json"))
		assert.ok(Option.isNone(config))
	}),
)

it.effect("the config is saved so that only the owner can read it", () =>
	Effect.gen(function* () {
		const file = join(folder, "nested", "openbot", "computer.json")
		const config = {
			url: "https://openbot.example.com",
			token: "secret-token",
			machineId: Config.makeMachineId(),
		}
		yield* Config.write(file, config)
		assert.strictEqual(statSync(file).mode & 0o777, 0o600)
		const read = yield* Config.read(file)
		assert.deepStrictEqual(read, Option.some(config))

		// Writing again keeps the mode.
		yield* Config.write(file, { ...config, token: "new-token" })
		assert.strictEqual(statSync(file).mode & 0o777, 0o600)
	}),
)

it.effect("a broken config file gives a clear error", () =>
	Effect.gen(function* () {
		const file = join(folder, "broken.json")
		writeFileSync(file, "{ not json")
		const error = yield* Effect.flip(Config.read(file))
		assert.match(error.message, /is not a valid config/)
	}),
)

it("a machine ID is long and random", () => {
	const first = Config.makeMachineId()
	assert.ok(first.length >= 16)
	assert.notStrictEqual(first, Config.makeMachineId())
})

it.effect("an OpenBot address must be an http or https origin", () =>
	Effect.gen(function* () {
		assert.strictEqual(
			yield* Config.parseOrigin("https://openbot.example.com/path"),
			"https://openbot.example.com",
		)
		const error = yield* Effect.flip(Config.parseOrigin("ftp://example.com"))
		assert.match(error.message, /is not an OpenBot address/)
	}),
)
