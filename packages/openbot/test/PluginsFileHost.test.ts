import { assert, layer } from "@effect/vitest"
import { Plugin as GraftPlugin } from "@graftland/graft"
import { FailureApi, OpenBotApi } from "@openbot-build/api"
import { Host } from "../src/index.ts"
import {
	Array as Arr,
	ConfigProvider,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	Redacted,
	References,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http"
import { OpenApi } from "effect/http-api"
import * as Assembly from "../src/app/Assembly.ts"
import * as Composition from "../src/app/Composition.ts"
import { provide } from "../src/app/HostServices.ts"
import * as PluginsFile from "../src/app/PluginsFile.ts"
import * as Preset from "../src/app/Preset.ts"
import * as PresetPlugins from "../src/app/PresetPlugins.ts"
import * as TestHost from "./TestHost.ts"

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
			PluginsFile.canonical({
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

/** Waits on the real clock until every fork of the host is active. */
const allActive = Effect.gen(function* () {
	const composition = yield* Composition.Composition
	while (true) {
		const trees = yield* Stream.runHead(composition.forks)
		const forks = Composition.flatten(Option.getOrElse(trees, () => []))
		if (
			Arr.isReadonlyArrayNonEmpty(forks) &&
			Arr.every(forks, (fork) => fork.state._tag === "Active")
		)
			return forks
		yield* Effect.sleep("100 millis")
	}
}).pipe(Effect.timeout("60 seconds"))

// The database is a real server, so these tests use the real clock.
layer(TestHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "240 seconds",
})((it) => {
	it.effect(
		"a plugins file turns triggers off, and runtime edits never write it",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const file = yield* writeFile(triggersOff)
				const before = yield* fs.readFile(file)
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const logs = capture()
				const context = yield* Layer.build(
					TestHost.layer({ ...options, pluginsFile: file }),
				).pipe(Effect.provide(logs.layer))
				yield* Effect.gen(function* () {
					const composition = yield* Composition.Composition
					const entries = yield* composition.loader.entries
					assert.deepStrictEqual(
						Arr.map(entries, (entry) => entry.id),
						[...Preset.ids],
					)
					assert.deepStrictEqual(
						Arr.filter(entries, (entry) => entry.disabled === true),
						Arr.map(["triggers", ...Preset.offByDefault], (id) => ({
							id,
							name: Preset.nameOf(id),
							disabled: true,
						})),
					)
					const forks = yield* allActive
					assert.isFalse(
						Arr.some(forks, (fork) =>
							Str.startsWith(Preset.nameOf("triggers"))(fork.name),
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
					assert.include(read[0], yield* PluginsFile.manifestHash(entries))

					const refused = yield* composition.loader
						.update("auth", { disabled: true })
						.pipe(Effect.flip)
					assert.deepStrictEqual(
						refused._tag === "StoreError" ? refused.cause : refused,
						PresetPlugins.RequiredPluginMissing.make({ ids: ["auth"] }),
					)
					yield* composition.loader.update("triggers", { disabled: false })
					yield* composition.loader.ready
					yield* allActive
					const get = yield* client
					const on = yield* get("/v1/triggers")
					assert.isUndefined(on.headers[FailureApi.featureHeader])
				}).pipe(Effect.provideContext(context))
				assert.deepStrictEqual(yield* fs.readFile(file), before)
			}).pipe(Effect.scoped),
	)

	it.effect("a bad plugins file stops the start with a clear line", () =>
		Effect.gen(function* () {
			const options = yield* TestHost.makeSettings
			yield* TestHost.migrate(options)
			const logs = capture()
			const file = yield* writeFile("- id: auth\n  disabled: true\n")
			const invalid = yield* Layer.build(
				TestHost.layer({ ...options, pluginsFile: file }),
			).pipe(Effect.provide(logs.layer), Effect.scoped, Effect.flip)
			assert.deepStrictEqual(
				invalid,
				PluginsFile.PluginsFileInvalid.make({
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
				TestHost.layer({ ...options, pluginsFile: `${file}.missing` }),
			).pipe(Effect.provide(logs.layer), Effect.scoped, Effect.flip)
			assert.strictEqual(missing._tag, "PluginsFileUnreadable")
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
		"a value of !env goes to the plugin and never into a log line",
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
					`- id: probe\n  name: "${name}"\n  config:\n    token: !env OPENBOT_TEST_PLUGIN_TOKEN\n`,
				)
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const logs = capture()
				const context = yield* Layer.build(
					TestHost.layer({
						...options,
						pluginsFile: file,
						plugins: { [name]: probe },
					}),
				).pipe(
					Effect.provide(
						Layer.merge(
							logs.layer,
							ConfigProvider.layer(
								ConfigProvider.fromUnknown({
									OPENBOT_TEST_PLUGIN_TOKEN: secret,
								}),
							),
						),
					),
				)
				assert.strictEqual(yield* Deferred.await(got), secret)
				const entries = yield* Effect.flatMap(
					Composition.Composition,
					(composition) => composition.loader.entries,
				).pipe(Effect.provideContext(context))
				assert.deepStrictEqual(
					Arr.last(PluginsFile.show(entries)),
					Option.some({
						id: "probe",
						name,
						disabled: false,
						config: { token: { env: "OPENBOT_TEST_PLUGIN_TOKEN" } },
					}),
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
		"the server of the program starts with a plugin turned off, and Host.layer does not",
		() =>
			Effect.gen(function* () {
				const file = yield* writeFile(triggersOff)
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				const settings = {
					...options,
					pluginsFile: file,
					auth: {
						mode: "development" as const,
						publicOrigin: "https://localhost:8443",
						secret: Redacted.make(
							"PluginsFileHostSecretMustRemainStable1234567",
						),
					},
				}
				yield* Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(
							provide<never, never>(settings)(Assembly.layerProgram(settings)),
						)
						yield* expectTriggersOff.pipe(Effect.provideContext(context))
					}),
				)
				// Host.layer gives every service of the plugins, so it needs every plugin.
				const exit = yield* Layer.build(Host.layer(settings)).pipe(
					Effect.scoped,
					Effect.exit,
				)
				assert.isTrue(Exit.isFailure(exit))
				assert.include(String(exit), "CaptureMissing")
			}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
	)
})
