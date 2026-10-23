import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { Effect, Option } from "effect"
import * as Config from "../src/Config.ts"

const folder = mkdtempSync(join(tmpdir(), "openbot-computer-config-"))
after(() => rmSync(folder, { recursive: true, force: true }))

test("the config file is in XDG_CONFIG_HOME when it is set", () => {
	assert.equal(
		Config.path({ XDG_CONFIG_HOME: "/xdg" }),
		join("/xdg", "openbot", "computer.json"),
	)
	assert.match(
		Config.path({ XDG_CONFIG_HOME: "" }),
		/\.config[/\\]openbot[/\\]computer\.json$/,
	)
})

test("a missing config file reads as none", async () => {
	const config = await Effect.runPromise(Config.read(join(folder, "none.json")))
	assert.ok(Option.isNone(config))
})

test("the config is saved so that only the owner can read it", async () => {
	const file = join(folder, "nested", "openbot", "computer.json")
	const config = {
		url: "https://openbot.example.com",
		token: "secret-token",
		machineId: Config.makeMachineId(),
	}
	await Effect.runPromise(Config.write(file, config))
	assert.equal(statSync(file).mode & 0o777, 0o600)
	const read = await Effect.runPromise(Config.read(file))
	assert.deepEqual(read, Option.some(config))

	// Writing again keeps the mode.
	await Effect.runPromise(Config.write(file, { ...config, token: "new-token" }))
	assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("a broken config file gives a clear error", async () => {
	const file = join(folder, "broken.json")
	writeFileSync(file, "{ not json")
	const error = await Effect.runPromise(Effect.flip(Config.read(file)))
	assert.match(error.message, /is not a valid config/)
})

test("a machine ID is long and random", () => {
	const first = Config.makeMachineId()
	assert.ok(first.length >= 16)
	assert.notEqual(first, Config.makeMachineId())
})

test("an OpenBot address must be an http or https origin", async () => {
	assert.equal(
		await Effect.runPromise(
			Config.parseOrigin("https://openbot.example.com/path"),
		),
		"https://openbot.example.com",
	)
	const error = await Effect.runPromise(
		Effect.flip(Config.parseOrigin("ftp://example.com")),
	)
	assert.match(error.message, /is not an OpenBot address/)
})
