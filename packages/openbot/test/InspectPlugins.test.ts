import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	ConfigProvider,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Record as Rec,
	Result,
	Schema,
} from "effect"
import * as InspectPlugins from "../src/InspectPlugins.ts"
import * as PluginsFile from "../src/PluginsFile.ts"
import * as Preset from "../src/Preset.ts"

/** The ids of the preset plugins that are off until the plugins file turns them on. */
const offByDefault = Arr.filterMap(Preset.entries, (entry) =>
	entry.disabled === true ? Result.succeed(entry.id) : Result.failVoid,
)

/** Writes a plugins file in a new folder that goes away with the scope. */
const writeFile = (text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const file = path.join(yield* fs.makeTempDirectoryScoped(), "plugins.yml")
		yield* fs.writeFileString(file, text)
		return file
	})

const secret = "value-of-the-secret-9876"

// A value of an environment variable that must never show.
const withSecret = Layer.merge(
	Layer.merge(NodeServices.layer, NodeCrypto.layer),
	ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENBOT_TOKEN: secret })),
)

layer(withSecret)((it) => {
	it.effect("without a file, the report is the preset", () =>
		Effect.gen(function* () {
			const report = yield* InspectPlugins.report(Option.none())
			assert.strictEqual(report.file, null)
			assert.deepStrictEqual(
				Arr.map(report.entries, (entry) => entry.id),
				Rec.keys(Preset.plugins),
			)
			assert.isTrue(
				Arr.every(
					report.entries,
					(entry) =>
						entry.source === "preset" &&
						entry.disabled === Arr.contains(offByDefault, entry.id) &&
						entry.changed.length === 0,
				),
			)
			assert.strictEqual(
				report.manifestHash,
				yield* PluginsFile.manifestHash(Preset.entries),
			)
		}),
	)

	it.effect(
		"a file that turns triggers off shows the change and a new hash",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const file = yield* writeFile("- id: triggers\n  disabled: true\n")
					const report = yield* InspectPlugins.report(Option.some(file))
					const preset = yield* InspectPlugins.report(Option.none())
					assert.strictEqual(report.file, file)
					assert.deepStrictEqual(
						Arr.findFirst(report.entries, (entry) => entry.id === "triggers"),
						Option.some<InspectPlugins.ReportEntry>({
							id: "triggers",
							name: Preset.plugins["triggers"].name,
							disabled: true,
							source: "preset",
							changed: ["disabled"],
						}),
					)
					assert.notStrictEqual(report.manifestHash, preset.manifestHash)
					const text = InspectPlugins.render(report)
					assert.deepStrictEqual(
						yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
							text,
						),
						report,
					)
				}),
			),
	)

	it.effect("a file that turns a limit on shows the change and the limit", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const file = yield* writeFile(
					"- id: turn-limiter\n  disabled: false\n  config:\n    maxSteps: 40\n",
				)
				const report = yield* InspectPlugins.report(Option.some(file))
				assert.deepStrictEqual(
					Arr.findFirst(report.entries, (entry) => entry.id === "turn-limiter"),
					Option.some<InspectPlugins.ReportEntry>({
						id: "turn-limiter",
						name: Preset.plugins["turn-limiter"].name,
						disabled: false,
						config: { maxSteps: 40 },
						source: "preset",
						changed: ["disabled", "config"],
					}),
				)
			}),
		),
	)

	it.effect(
		"config on a preset plugin is refused, and no value of the file shows",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const file = yield* writeFile(
						`- id: models\n  config:\n    token: ${secret}\n`,
					)
					const error = yield* Effect.flip(
						InspectPlugins.report(Option.some(file)),
					)
					assert.strictEqual(error._tag, "PluginsFileInvalid")
					assert.include(
						error.message,
						"entry 1 (models): This plugin takes no config.",
					)
					assert.notInclude(error.message, secret)
					assert.notInclude(
						Arr.join(
							Arr.map(
								error._tag === "PluginsFileInvalid" ? error.problems : [],
								PluginsFile.describe,
							),
							" ",
						),
						secret,
					)
				}),
			),
	)

	it.effect("a bad file or a missing file fails", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const bad = yield* writeFile("- id: triggers\n  disabled: maybe\n")
				const invalid = yield* Effect.flip(
					InspectPlugins.report(Option.some(bad)),
				)
				assert.strictEqual(invalid._tag, "PluginsFileInvalid")
				const missing = yield* Effect.flip(
					InspectPlugins.report(Option.some(`${bad}.missing`)),
				)
				assert.strictEqual(missing._tag, "PluginsFileUnreadable")
				assert.include(missing.message, "(NotFound)")
			}),
		),
	)

	it.effect(
		"the shown config redacts strings and values that are not plain data",
		() =>
			Effect.sync(() => {
				const entries = [
					{
						id: "probe",
						name: "probe-plugin",
						config: {
							token: secret,
							other: new (class Other {})(),
						},
					},
				]
				const shown = PluginsFile.canonical(PluginsFile.show(entries))
				assert.include(shown, '"token":"<redacted>"')
				// A value that is not plain data is redacted too.
				assert.include(shown, '"other":"<redacted>"')
				assert.notInclude(shown, secret)
			}),
	)
})
