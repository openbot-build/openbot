import * as TestDatabase from "@openbot-build/server-database/Testing"
import { NodeServices, NodeCrypto } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Plugin as GraftPlugin } from "@graftland/graft"
import { FailureApi, OpenBotApi } from "@openbot-build/api"
import { Host, Preset } from "@openbot-build/openbot"
import {
	Array as Arr,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	Predicate,
	Record as Rec,
	Redacted,
	References,
	Result,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http"
import { OpenApi } from "effect/http-api"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as TestHost from "../src/TestHost.ts"

/** Writes a plugins file in a new folder that goes away with the scope. */
const writeFile = (text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const file = path.join(yield* fs.makeTempDirectoryScoped(), "plugins.yml")
		yield* fs.writeFileString(file, text)
		return file
	})

const triggersOff = "- id: triggers\n  disabled: true\n"

/** The part of the cause of a `PluginsFileInvalid` start failure that the test reads. */
const InvalidFile = Schema.Struct({
	file: Schema.String,
	problems: Schema.Array(
		Schema.Struct({
			entry: Schema.optionalKey(Schema.Int),
			id: Schema.optionalKey(Schema.String),
			reason: Schema.String,
		}),
	),
})

/**
 * A logger that keeps each line as JSON text: its message, its notes and its
 * cause. A logger runs outside of Effect, so it keeps the lines in a plain
 * variable.
 */
const capture = () => {
	let lines: ReadonlyArray<string> = []
	const logger = Logger.make((line) => {
		lines = [
			...lines,
			// A logger runs outside of Effect, so it encodes at once.
			JSON.stringify({
				message: line.message,
				annotations: line.fiber.getRef(References.CurrentLogAnnotations),
				cause: String(line.cause),
			}),
		]
	})
	return { layer: Logger.layer([logger]), lines: () => lines }
}

/** The address of the server and a GET on it. */
const client = Effect.gen(function* () {
	const address = HttpServer.formatAddress(
		(yield* HttpServer.HttpServer).address,
	)
	return (path: string) => HttpClient.get(address + path)
})

/** The text of the OpenAPI document, the same as the snapshot of the contract. */
const contract = JSON.stringify(OpenApi.fromApi(OpenBotApi))

/** Checks that the routes of triggers answer that the feature is off. */
const expectTriggersOff = Effect.gen(function* () {
	const get = yield* client
	const off = yield* get("/v1/triggers")
	assert.strictEqual(off.status, 503)
	assert.strictEqual(off.headers[FailureApi.featureHeader], "triggers")
	assert.deepStrictEqual(yield* off.json, {
		_tag: "FeatureUnavailable",
		feature: "triggers",
	})
	// The contract does not change when a plugin is off.
	assert.strictEqual(yield* (yield* get("/openapi.json")).text, contract)
})

/** The ids of the preset plugins that are off until the plugins file turns them on. */
const offByDefault = Arr.filterMap(Preset.entries, (entry) =>
	entry.disabled === true ? Result.succeed(entry.id) : Result.failVoid,
)

/** The ids of the preset, in the order of the table. */
const presetIds = Arr.map(Preset.entries, (entry) => entry.id)

/**
 * The ids of the preset plugins that need one of these plugins, with these
 * plugins, so a host can run without all of them. A plugin needs another one
 * when it injects a key that the other one publishes.
 */
const withDependents = (
	ids: ReadonlyArray<Preset.Id>,
): ReadonlyArray<string> => {
	const table = Rec.toEntries(Preset.plugins)
	const keysOf = (id: string) =>
		Arr.flatMap(table, ([other, plugin]) =>
			other === id
				? Arr.map(Feature.keys(plugin.plugin).publishes, (key) => key.key)
				: [],
		)
	const grow = (current: ReadonlyArray<string>): ReadonlyArray<string> => {
		const published = Arr.flatMap(current, keysOf)
		const next = Arr.dedupe([
			...current,
			...Arr.filterMap(table, ([id, plugin]) =>
				Arr.some(Feature.keys(plugin.plugin).inject, (key) =>
					Arr.contains(published, key.key),
				)
					? Result.succeed(id)
					: Result.failVoid,
			),
		])
		return next.length === current.length ? current : grow(next)
	}
	return grow(ids)
}

/** Waits on the real clock until every fork of the host is active. */
const allActive = (control: TestHost.Control) =>
	Effect.gen(function* () {
		while (true) {
			const trees = yield* Stream.runHead(control.forks)
			const forks = TestHost.flatten(Option.getOrElse(trees, () => []))
			if (
				Arr.isReadonlyArrayNonEmpty(forks) &&
				Arr.every(forks, (fork) => fork.state._tag === "Active")
			)
				return forks
			yield* Effect.sleep("100 millis")
		}
	}).pipe(Effect.timeout("60 seconds"))

// The database is a real server, so these tests use the real clock.
layer(
	Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
	{
		excludeTestServices: true,
		timeout: "240 seconds",
	},
)((it) => {
	it.effect(
		"a plugins file turns triggers off, and runtime edits never write it",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const file = yield* writeFile(triggersOff)
				const before = yield* fs.readFile(file)
				const database = yield* TestDatabase.migrated
				const logs = capture()
				const control = yield* TestHost.control
				const context = yield* Layer.build(
					TestHost.layer({ database, pluginsFile: file, probes: [control] }),
				).pipe(Effect.provide(logs.layer))
				yield* Effect.gen(function* () {
					const composition = yield* control.value
					const entries = yield* composition.loader.entries
					assert.deepStrictEqual(
						Arr.map(entries, (entry) => entry.id),
						[...presetIds, control.entry.id],
					)
					assert.deepStrictEqual(
						Arr.filter(entries, (entry) => entry.disabled === true),
						Arr.map(["triggers", ...offByDefault], (id) => ({
							id,
							name: `@openbot-build/plugin-${id}`,
							disabled: true,
						})),
					)
					const forks = yield* allActive(composition)
					assert.isFalse(
						Arr.some(forks, (fork) =>
							Str.startsWith(Preset.plugins.triggers.name)(fork.name),
						),
					)
					yield* expectTriggersOff
					const read = Arr.filter(logs.lines(), (line) =>
						Str.includes("OpenBot read the plugins file.")(line),
					)
					assert.strictEqual(read.length, 1)
					assert.include(
						read[0],
						'"off":["triggers","turn-limiter","time-limiter","token-limiter"]',
					)
					assert.include(read[0], '"manifestHash":"')

					const refused = yield* composition.loader
						.update("auth", { disabled: true })
						.pipe(Effect.flip)
					const cause = refused._tag === "StoreError" ? refused.cause : refused
					assert.isTrue(Predicate.isTagged(cause, "RequiredPluginMissing"))
					assert.deepStrictEqual(
						Predicate.hasProperty(cause, "ids") ? cause.ids : undefined,
						["auth"],
					)
					yield* composition.loader.update("triggers", { disabled: false })
					yield* composition.loader.ready
					yield* allActive(composition)
					const get = yield* client
					const on = yield* get("/v1/triggers")
					assert.isUndefined(on.headers[FailureApi.featureHeader])
				}).pipe(Effect.provideContext(context))
				assert.deepStrictEqual(yield* fs.readFile(file), before)
			}).pipe(Effect.scoped),
	)

	it.effect("a bad plugins file stops the start with a clear line", () =>
		Effect.gen(function* () {
			const database = yield* TestDatabase.migrated
			const logs = capture()
			const file = yield* writeFile("- id: auth\n  disabled: true\n")
			const invalid = yield* Layer.build(
				TestHost.layer({ database, pluginsFile: file }),
			).pipe(Effect.provide(logs.layer), Effect.scoped, Effect.flip)
			assert.strictEqual(
				invalid._tag === "StartFailed" ? invalid.reason : undefined,
				"PluginsFileInvalid",
			)
			assert.deepStrictEqual(
				invalid._tag === "StartFailed"
					? Schema.decodeUnknownOption(InvalidFile)(invalid.cause)
					: Option.none(),
				Option.some({
					file,
					problems: [
						{
							entry: 1,
							id: "auth",
							reason: "This plugin is needed, so it can not be turned off.",
						},
					],
				}),
			)
			assert.isTrue(
				Arr.some(
					logs.lines(),
					(line) =>
						Str.includes("The plugins file is not valid.")(line) &&
						Str.includes("This plugin is needed")(line),
				),
			)
			const missing = yield* Layer.build(
				TestHost.layer({ database, pluginsFile: `${file}.missing` }),
			).pipe(Effect.provide(logs.layer), Effect.scoped, Effect.flip)
			assert.strictEqual(
				missing._tag === "StartFailed" ? missing.reason : undefined,
				"PluginsFileUnreadable",
			)
			assert.isTrue(
				Arr.some(
					logs.lines(),
					(line) =>
						Str.includes("OpenBot could not read the plugins file.")(line) &&
						Str.includes('"reason":"NotFound"')(line),
				),
			)
		}).pipe(Effect.scoped),
	)

	it.effect(
		"the config of a new entry goes to the plugin and never into a log line",
		() =>
			Effect.gen(function* () {
				const secret = "value-of-the-token-5432"
				const name = "@openbot-build/test-probe"
				const got = yield* Deferred.make<string>()
				const probe = GraftPlugin.make({
					name,
					config: Schema.Struct({ token: Schema.String }),
					apply: (config) => Effect.asVoid(Deferred.succeed(got, config.token)),
				})
				const file = yield* writeFile(
					`- id: probe\n  name: "${name}"\n  config:\n    token: ${secret}\n`,
				)
				const database = yield* TestDatabase.migrated
				const logs = capture()
				const control = yield* TestHost.control
				yield* Layer.build(
					TestHost.layer({
						database,
						pluginsFile: file,
						plugins: { [name]: probe },
						probes: [control],
					}),
				).pipe(Effect.provide(logs.layer))
				assert.strictEqual(yield* Deferred.await(got), secret)
				const entries = yield* Effect.flatMap(
					control.value,
					(composition) => composition.loader.entries,
				)
				const added = Arr.findFirst(entries, (entry) => entry.id === "probe")
				assert.deepStrictEqual(
					Option.map(added, (entry): unknown => entry.config),
					Option.some({ token: secret }),
				)
				assert.isTrue(
					Arr.some(logs.lines(), (line) =>
						Str.includes('"added":["probe"]')(line),
					),
				)
				assert.isFalse(
					Arr.some(logs.lines(), (line) => Str.includes(secret)(line)),
				)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"Host.layer starts with a plugin turned off, and its routes answer that it is off",
		() =>
			Effect.gen(function* () {
				const file = yield* writeFile(triggersOff)
				const database = yield* TestDatabase.migrated
				const context = yield* Layer.build(
					Host.layer({
						databaseUrl: Redacted.make(database.url),
						secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
						clusterSecret: Redacted.make(
							"test-cluster-secret-with-at-least-32-characters",
						),
						host: "127.0.0.1",
						port: 0,
						pluginsFile: file,
						auth: {
							mode: "development" as const,
							publicOrigin: "https://localhost:8443",
							secret: Redacted.make(
								"PluginsFileHostSecretMustRemainStable1234567",
							),
						},
					}),
				)
				yield* expectTriggersOff.pipe(Effect.provideContext(context))
			}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
	)

	it.effect(
		"the host starts without bots and every plugin that needs bots",
		() =>
			Effect.gen(function* () {
				const off = withDependents(["bots"])
				// The set holds the plugins that inject a key of bots.
				assert.include(off, "chats")
				assert.isFalse(Arr.some(off, (id) => Arr.contains(Preset.required, id)))
				const file = yield* writeFile(
					Arr.join(
						Arr.map(off, (id) => `- id: ${id}\n  disabled: true\n`),
						"",
					),
				)
				const database = yield* TestDatabase.migrated
				const control = yield* TestHost.control
				const context = yield* Layer.build(
					TestHost.layer({ database, pluginsFile: file, probes: [control] }),
				)
				const composition = yield* control.value
				const forks = yield* allActive(composition)
				assert.isFalse(
					Arr.some(forks, (fork) =>
						Arr.some(off, (id) =>
							Str.startsWith(`@openbot-build/plugin-${id}`)(fork.name),
						),
					),
				)
				const get = yield* client.pipe(Effect.provideContext(context))
				const bots = yield* get("/v1/bots")
				assert.strictEqual(bots.status, 503)
				assert.strictEqual(bots.headers[FailureApi.featureHeader], "bots")
			}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
	)
})
