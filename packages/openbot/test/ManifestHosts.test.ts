import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	References,
	String as Str,
} from "effect"
import { HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { SqlClient } from "effect/sql"
import * as InspectPlugins from "../src/app/InspectPlugins.ts"
import * as PluginsFile from "../src/app/PluginsFile.ts"
import * as TestHost from "./TestHost.ts"

const warning = "are not the same as on other runners"

/** Writes a plugins file in a new folder that goes away with the scope. */
const writeFile = (text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const file = path.join(yield* fs.makeTempDirectoryScoped(), "plugins.yml")
		yield* fs.writeFileString(file, text)
		return file
	})

/**
 * A logger that keeps each line as JSON text. A logger runs outside of
 * Effect, so it keeps the lines in a plain variable.
 */
const capture = () => {
	let lines: ReadonlyArray<string> = []
	const logger = Logger.make((line) => {
		lines = [
			...lines,
			PluginsFile.canonical({
				level: line.logLevel,
				message: line.message,
				annotations: line.fiber.getRef(References.CurrentLogAnnotations),
			}),
		]
	})
	return {
		layer: Logger.layer([logger]),
		warnings: () => Arr.filter(lines, (line) => Str.includes(warning)(line)),
	}
}

interface Row {
	readonly runner_address: string
	readonly manifest_hash: string
	readonly active_hash: string
	readonly plugins: ReadonlyArray<{
		readonly id: string
		readonly disabled: boolean
	}>
}

/** The address of a host, as its row names it. */
const addressOf = (context: Context.Context<HttpServer.HttpServer>) => {
	const address = Context.get(context, HttpServer.HttpServer).address
	return address._tag !== "UnixPathAddress"
		? `${NetAddress.formatHost(address)}:${address.port}`
		: ""
}

/** Waits on the real clock until the rows of both hosts are there. */
const rowsOf = (addresses: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		while (true) {
			const rows =
				yield* sql<Row>`select runner_address, manifest_hash, active_hash, plugins from openbot_execution_runners`
			const found = Arr.filter(rows, (row) =>
				Arr.contains(addresses, row.runner_address),
			)
			if (found.length === addresses.length) return found
			yield* Effect.sleep("100 millis")
		}
	}).pipe(Effect.timeout("30 seconds"))

const rowAt = (rows: ReadonlyArray<Row>, address: string) =>
	Option.getOrThrow(
		Arr.findFirst(rows, (row) => row.runner_address === address),
	)

// The database is a real server, so these tests use the real clock.
layer(TestHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "240 seconds",
})((it) => {
	it.effect(
		"a runner with other plugins warns and saves a record, and still starts",
		() =>
			Effect.gen(function* () {
				const file = yield* writeFile("- id: triggers\n  disabled: true\n")
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const first = yield* Layer.build(TestHost.layer(options))
				const logs = capture()
				// The second runner turns triggers off. Its start is not blocked.
				const second = yield* Layer.build(
					TestHost.layer({ ...options, pluginsFile: file }),
				).pipe(Effect.provide(logs.layer))
				const a = addressOf(first)
				const b = addressOf(second)
				assert.notStrictEqual(a, b)
				const rows = yield* rowsOf([a, b]).pipe(Effect.provideContext(second))
				assert.notStrictEqual(
					rowAt(rows, a).manifest_hash,
					rowAt(rows, b).manifest_hash,
				)
				assert.isTrue(
					Arr.some(
						rowAt(rows, b).plugins,
						(plugin) => plugin.id === "triggers" && plugin.disabled,
					),
				)
				// The hash in the row is the one that inspect prints for the same file.
				const report = yield* InspectPlugins.report(Option.some(file))
				assert.strictEqual(rowAt(rows, b).manifest_hash, report.manifestHash)

				// The first beat runs in its own fiber, so wait for its warning.
				while (logs.warnings().length === 0) yield* Effect.sleep("100 millis")
				const warnings = logs.warnings()
				assert.strictEqual(warnings.length, 1)
				const line = warnings[0] ?? ""
				assert.include(line, '"level":"Warn"')
				assert.include(line, `"runnerAddress":"${b}"`)
				assert.include(line, `"others":["${a}"]`)
				const errorId = Option.getOrThrow(
					Option.fromNullishOr(/"errorId":"([^"]+)"/.exec(line)?.[1]),
				)
				const records = yield* Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql<{
							readonly id: string
						}>`select id from openbot_execution_failures where id = ${errorId}`,
				).pipe(Effect.provideContext(second))
				assert.strictEqual(records.length, 1)
			}).pipe(Effect.timeout("200 seconds"), Effect.scoped),
		240_000,
	)

	it.effect(
		"runners with the same plugins write the same hashes and do not warn",
		() =>
			Effect.gen(function* () {
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const logs = capture()
				const first = yield* Layer.build(TestHost.layer(options)).pipe(
					Effect.provide(logs.layer),
				)
				const second = yield* Layer.build(TestHost.layer(options)).pipe(
					Effect.provide(logs.layer),
				)
				const a = addressOf(first)
				const b = addressOf(second)
				const rows = yield* rowsOf([a, b]).pipe(Effect.provideContext(second))
				assert.strictEqual(
					rowAt(rows, a).manifest_hash,
					rowAt(rows, b).manifest_hash,
				)
				assert.strictEqual(
					rowAt(rows, a).active_hash,
					rowAt(rows, b).active_hash,
				)
				// The preset alone gives the hash that inspect prints with no file.
				const report = yield* InspectPlugins.report(Option.none())
				assert.strictEqual(rowAt(rows, a).manifest_hash, report.manifestHash)
				assert.deepStrictEqual(logs.warnings(), [])
			}).pipe(Effect.timeout("200 seconds"), Effect.scoped),
		240_000,
	)
})
