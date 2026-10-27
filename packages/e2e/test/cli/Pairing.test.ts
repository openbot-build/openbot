import { assert, layer } from "@effect/vitest"
import { ComputersApi, UserTokensApi } from "@openbot-build/api"
import { BrowserHost, Caller, Wait } from "@openbot-build/openbot/testing"
import { finished } from "../connect-computers/Commands.ts"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
	String as Str,
} from "effect"
import {
	commands,
	makeFiles,
	readSaved,
	run,
	SavedConfig,
	start,
} from "./Process.ts"

const publicOrigin = "https://cli.example.com"

// A login shell may add text from its logout file. A plain shell keeps the
// command output fixed while the connector still runs its normal shell path.
const shell = (command: string) =>
	"exec bash --noprofile --norc -c '" +
	Str.replaceAll("'", "'\\''")(command) +
	"'"

const pairingCode = (process: Effect.Success<ReturnType<typeof start>>) =>
	Wait.until(
		"the command shows a pairing code",
		process.stdout.pipe(
			Effect.map((text) =>
				Str.match(/The pairing code is ([A-Z2-9]{4}-[A-Z2-9]{4})\./)(text).pipe(
					Option.flatMap(Arr.get(1)),
				),
			),
		),
	)

layer(Layer.merge(commands, BrowserHost.layerPlatform), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"a built computer pairs, does work, and pairs again with a new token",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const alice = yield* host.login("cli-owner")
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const keyed = Caller.withToken(address)
				const { secret } = yield* Caller.read(
					UserTokensApi.CreatedToken,
					account(alice.session, "/v1/user/tokens", "POST", {
						name: "Computer work",
					}),
					201,
				)
				const files = yield* makeFiles
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path

				const pair = Effect.fn("pair")(function* () {
					const pairing = yield* start(files, [
						"computer",
						"pair",
						"--url",
						address,
					])
					const code = yield* pairingCode(pairing)
					const pairingPath = "/v1/computer-pairings/" + code
					const shown = yield* Caller.read(
						ComputersApi.ComputerPairing,
						keyed(secret, pairingPath),
					)
					assert.strictEqual(shown.code, code)
					assert.strictEqual(shown.os, process.platform)
					assert.strictEqual(shown.desktop, false)
					assert.strictEqual(
						(yield* keyed("obut_wrong", pairingPath + "/approve", "POST", {}))
							.status,
						401,
					)
					const computer = yield* Caller.read(
						ComputersApi.Computer,
						keyed(secret, pairingPath + "/approve", "POST", {
							name: "Test machine",
						}),
						201,
					)
					assert.strictEqual(
						(yield* keyed(secret, pairingPath + "/approve", "POST", {})).status,
						404,
					)
					const result = yield* pairing.done.pipe(Effect.timeout("15 seconds"))
					assert.strictEqual(result.code, 0)
					assert.strictEqual(result.stderr, "")
					assert.include(result.stdout, `It is the Computer ${computer.id}.`)
					assert.include(result.stdout, "openbot computer connect")
					const config = yield* readSaved(files)
					assert.strictEqual(config.url, address)
					assert.match(config.machineId, /^[a-f0-9]{32}$/)
					assert.isAbove(config.token.length, 32)
					assert.notInclude(result.stdout, config.token)
					assert.strictEqual(
						(yield* fs.stat(files.configFile)).mode & 0o777,
						0o600,
					)
					assert.deepStrictEqual(
						yield* fs.readDirectory(path.dirname(files.configFile)),
						["computer.json"],
					)
					return { computer, config }
				})

				const first = yield* pair()
				assert.strictEqual(first.computer.state, "offline")
				const computerPath = "/v1/computers/" + first.computer.id
				const state = Caller.read(
					ComputersApi.Computer,
					keyed(secret, computerPath),
				)
				const connected = () =>
					Wait.untilTrue(
						"the built computer connects",
						state,
						(computer) => computer.state === "running",
					)
				const computer = yield* start(files, ["computer", "connect"])
				yield* connected()
				yield* Wait.untilTrue(
					"the command shows that it connected",
					computer.stdout,
					Str.includes("Connected. Bots can use this machine now."),
				)
				const output = yield* Caller.read(
					ComputersApi.SessionOutput,
					keyed(secret, computerPath + "/sessions", "POST", {
						command: shell("printf 'from the machine\\n'"),
						cwd: files.folder,
					}),
				)
				assert.strictEqual(output.output, "from the machine\n")
				assert.strictEqual(output.exitCode, 0)
				assert.strictEqual(output.running, false)
				assert.strictEqual(output.session, null)

				const waiting = yield* Caller.read(
					ComputersApi.SessionOutput,
					keyed(secret, computerPath + "/sessions", "POST", {
						command: shell('read -r line; printf "<%s>\\n" "$line"'),
						cwd: files.folder,
						yieldTimeMs: 250,
					}),
				)
				assert.strictEqual(waiting.running, true)
				assert.isNotNull(waiting.session)
				const ended = yield* Caller.read(
					ComputersApi.SessionOutput,
					keyed(
						secret,
						computerPath + "/sessions/" + waiting.session + "/input",
						"POST",
						{
							chars: "two words\n",
						},
					),
				)
				assert.strictEqual(ended.output, "<two words>\n")
				assert.strictEqual(ended.exitCode, 0)
				assert.strictEqual(ended.running, false)

				const failed = yield* Caller.read(
					ComputersApi.SessionOutput,
					keyed(secret, computerPath + "/sessions", "POST", {
						command: shell("printf 'failed command\\n'; exit 7"),
						cwd: files.folder,
					}),
				)
				assert.strictEqual(failed.exitCode, 7)
				assert.strictEqual(failed.output, "failed command\n")
				const large = yield* Caller.read(
					ComputersApi.SessionOutput,
					keyed(secret, computerPath + "/sessions", "POST", {
						command: shell("printf '%04096d' 0"),
						cwd: files.folder,
						maxOutputBytes: 64,
					}),
				)
				assert.strictEqual(large.exitCode, 0)
				assert.strictEqual(large.truncated, true)
				assert.strictEqual(large.output, Str.repeat(64)("0"))

				const file = path.join(files.folder, "work", "note.txt")
				assert.strictEqual(
					(yield* keyed(secret, computerPath + "/files", "PUT", {
						path: file,
						encoding: "utf8",
						content: "The machine wrote this file.\n",
					})).status,
					204,
				)
				assert.strictEqual(
					yield* fs.readFileString(file),
					"The machine wrote this file.\n",
				)
				const read = yield* Caller.read(
					ComputersApi.FileContent,
					keyed(
						secret,
						computerPath + "/files?path=" + encodeURIComponent(file),
					),
				)
				assert.strictEqual(read.content, "The machine wrote this file.\n")

				const second = yield* pair()
				assert.strictEqual(second.computer.id, first.computer.id)
				assert.strictEqual(second.config.machineId, first.config.machineId)
				assert.notStrictEqual(second.config.token, first.config.token)
				assert.strictEqual(
					(yield* Caller.read(
						Schema.Array(ComputersApi.Computer),
						keyed(secret, "/v1/computers"),
					)).length,
					1,
				)
				const revoked = yield* computer.done.pipe(Effect.timeout("15 seconds"))
				assert.strictEqual(revoked.code, 1)
				assert.include(
					revoked.stderr,
					"OpenBot refused the token of this machine.",
				)
				assert.notInclude(revoked.stdout + revoked.stderr, first.config.token)

				const staleFiles = yield* makeFiles
				yield* fs.writeFileString(
					staleFiles.configFile,
					yield* Schema.encodeEffect(SavedConfig)(first.config),
				)
				const stale = yield* run(staleFiles, ["computer", "connect"])
				assert.strictEqual(stale.code, 1)
				assert.include(
					stale.stderr,
					"OpenBot refused the token of this machine.",
				)
				assert.notInclude(stale.stdout + stale.stderr, first.config.token)

				const current = yield* start(files, ["computer", "connect"])
				yield* connected()
				yield* Wait.untilTrue(
					"the new token connects the machine",
					current.stdout,
					Str.includes("Connected. Bots can use this machine now."),
				)
				yield* finished(
					keyed,
					secret,
					keyed(secret, computerPath, "DELETE", {
						commandKey: `remove-built-machine:${first.computer.id}`,
					}),
				)
				const removed = yield* current.done.pipe(Effect.timeout("15 seconds"))
				assert.strictEqual(removed.code, 1)
				assert.include(
					removed.stderr,
					"OpenBot refused the token of this machine.",
				)
				assert.notInclude(removed.stdout + removed.stderr, second.config.token)
				assert.strictEqual((yield* keyed(secret, computerPath)).status, 404)
			}),
		{ timeout: 120_000 },
	)

	it.effect(
		"a denied pairing ends the built command and saves no token",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				const alice = yield* host.login("cli-denied")
				const address = yield* host.address
				const send = Caller.withCookie({ address, publicOrigin })
				const files = yield* makeFiles
				const fs = yield* FileSystem.FileSystem
				const pairing = yield* start(files, [
					"computer",
					"pair",
					"--url",
					address,
				])
				const code = yield* pairingCode(pairing)
				assert.strictEqual(
					(yield* send(
						alice.session,
						"/v1/computer-pairings/" + code + "/deny",
						"POST",
					)).status,
					204,
				)
				const result = yield* pairing.done.pipe(Effect.timeout("15 seconds"))
				assert.strictEqual(result.code, 1)
				assert.include(result.stderr, "OpenBot ended this pairing.")
				assert.include(result.stderr, "openbot computer pair")
				assert.notInclude(result.stdout, "The token is saved")
				assert.strictEqual(yield* fs.exists(files.configFile), false)
				assert.deepStrictEqual(
					yield* Caller.read(
						Schema.Array(ComputersApi.Computer),
						send(alice.session, "/v1/computers"),
					),
					[],
				)
			}),
		{ timeout: 60_000 },
	)
})
