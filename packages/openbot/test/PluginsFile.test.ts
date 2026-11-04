import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Entry } from "@graftland/loader"
import { Array as Arr, ConfigProvider, Effect, Option, Result } from "effect"
import * as PluginsFile from "../src/app/PluginsFile.ts"
import * as Preset from "../src/app/Preset.ts"
import * as PresetPlugins from "../src/app/PresetPlugins.ts"

const known = PluginsFile.presetKnown

const parsed = (text: string) => Result.getOrThrow(PluginsFile.parse(text))

const problems = <A>(
	result: Result.Result<A, ReadonlyArray<PluginsFile.Problem>>,
) =>
	Result.isFailure(result)
		? result.failure
		: assert.fail("The result is not a failure.")

const merged = (text: string, with_: PluginsFile.Known = known) =>
	PluginsFile.merge(with_, parsed(text))

describe("parse", () => {
	it("turns !env into the name of a variable, not its value", () => {
		const [entry] = parsed(
			"- id: probe\n  config:\n    token: !env OPENBOT_TOKEN\n",
		)
		assert.deepStrictEqual(entry, {
			id: "probe",
			config: { token: new Entry.Env({ name: "OPENBOT_TOKEN" }) },
		})
	})

	it("gives the line and column of bad YAML, without the text of the line", () => {
		const found = problems(
			PluginsFile.parse(
				"- id: triggers\n  disabled: true\n token: secret-value-1234\n",
			),
		)
		assert.strictEqual(found.length >= 1, true)
		assert.match(
			found[0]!.reason,
			/^The YAML is not valid at line 3, column \d+ \(/,
		)
		assert.notInclude(JSON.stringify(found), "secret-value-1234")
	})

	it("takes an unknown tag as a problem", () => {
		const found = problems(
			PluginsFile.parse("- id: probe\n  config: !evn TOKEN\n"),
		)
		assert.match(found[0]!.reason, /^The YAML is not valid at line 2/)
	})

	it("needs a list, and gives no entries for an empty file", () => {
		assert.deepStrictEqual(problems(PluginsFile.parse("id: triggers\n")), [
			{ reason: "The file must be a list of entries." },
		])
		assert.deepStrictEqual(parsed(""), [])
		assert.deepStrictEqual(parsed("# Nothing to change.\n"), [])
		assert.deepStrictEqual(parsed("[]"), [])
	})

	it("needs the name of a variable after !env", () => {
		assert.deepStrictEqual(
			problems(PluginsFile.parse("- id: probe\n  config: !env not-a-name\n")),
			[{ reason: "!env needs the name of an environment variable." }],
		)
	})

	it("refuses an alias that points to itself", () => {
		assert.deepStrictEqual(
			problems(PluginsFile.parse("- &a\n  id: probe\n  config: [*a]\n")),
			[{ reason: "The file has an alias that points to itself." }],
		)
	})
})

describe("merge", () => {
	it("turns a preset plugin off and keeps the order of the preset", () => {
		const entries = Result.getOrThrow(
			merged(
				"- id: triggers\n  disabled: true\n- id: bots\n  disabled: false\n",
			),
		)
		assert.deepStrictEqual(
			Arr.map(entries, (entry) => entry.id),
			[...Preset.ids],
		)
		assert.deepStrictEqual(
			Arr.filter(entries, (entry) => entry.disabled !== undefined),
			[
				{ id: "bots", name: Preset.nameOf("bots"), disabled: false },
				{ id: "triggers", name: Preset.nameOf("triggers"), disabled: true },
			],
		)
	})

	it("gives every problem of the file at one time", () => {
		const found = problems(
			merged(
				Arr.join(
					[
						"- id: auth",
						"  disabled: true",
						"- id: sso",
						"  name: other",
						"- id: models",
						"  config: { limit: 3 }",
						"- id: files",
						"  group: true",
						"- id: files",
						"- id: chats",
						"  disabled: maybe",
						"- id: extra",
						"- id: outside",
						"  name: outside-plugin",
						"- id: second-bots",
						`  name: "${Preset.nameOf("bots")}"`,
						"- just text",
						"- name: no-id",
						"",
					],
					"\n",
				),
			),
		)
		assert.deepStrictEqual(found, [
			{
				entry: 4,
				id: "files",
				reason: 'The field "group" is not allowed here.',
			},
			{ entry: 6, id: "chats", reason: '"disabled" must be true or false.' },
			{ entry: 10, reason: "An entry must be a mapping with an id." },
			{ entry: 11, reason: "An entry needs an id." },
			{
				entry: 5,
				id: "files",
				reason: "The id comes more than once in the file.",
			},
			{ entry: 7, id: "extra", reason: "A new entry needs a name." },
			{
				entry: 2,
				id: "sso",
				reason: "The name of a preset plugin can not change.",
			},
			{ entry: 3, id: "models", reason: "This plugin takes no config." },
			{
				entry: 8,
				id: "outside",
				reason:
					"There is no plugin with this name in OpenBot. Only plugins that come with OpenBot can run.",
			},
			{
				entry: 9,
				id: "second-bots",
				reason: 'The plugin already runs as entry "bots". Change that entry.',
			},
			{
				entry: 1,
				id: "auth",
				reason: "This plugin is needed, so it can not be turned off.",
			},
		])
	})

	it("adds a new entry of a bundled plugin after the preset, with its config", () => {
		const extra = "@openbot-build/test-extra"
		const entries = Result.getOrThrow(
			merged(
				`- id: probe\n  name: "${extra}"\n  config:\n    token: !env OPENBOT_TOKEN\n    size: 3\n`,
				{ ...known, bundled: [...known.bundled, extra] },
			),
		)
		assert.strictEqual(entries.length, Preset.ids.length + 1)
		assert.deepStrictEqual(
			Arr.last(entries),
			Option.some({
				id: "probe",
				name: extra,
				config: { token: new Entry.Env({ name: "OPENBOT_TOKEN" }), size: 3 },
			}),
		)
	})

	it("is pure: the same input gives the same output and stays the same", () => {
		const overlay = Object.freeze([
			Object.freeze({ id: "triggers", disabled: true }),
		])
		const base = Object.freeze(
			Arr.map(known.base, (entry) => Object.freeze({ ...entry })),
		)
		const frozen: PluginsFile.Known = Object.freeze({ ...known, base })
		const before = structuredClone({ overlay, base })
		const first = PluginsFile.merge(frozen, overlay)
		const second = PluginsFile.merge(frozen, overlay)
		assert.deepStrictEqual(first, second)
		assert.deepStrictEqual({ overlay, base }, before)
	})
})

describe("manifest hash", () => {
	const hash = (entries: ReadonlyArray<Entry.Entry>) =>
		PluginsFile.manifestHash(entries).pipe(Effect.provide(NodeCrypto.layer))

	it.effect(
		"depends on the entries only, not on the order of keys or the values of !env",
		() =>
			Effect.gen(function* () {
				const entry = {
					id: "probe",
					name: "probe-plugin",
					config: { a: 1, token: new Entry.Env({ name: "TOKEN" }) },
				}
				const same = {
					config: { token: new Entry.Env({ name: "TOKEN" }), a: 1 },
					name: "probe-plugin",
					disabled: false,
					id: "probe",
				}
				const first = yield* hash([entry])
				assert.match(first, /^sha256:[0-9a-f]{64}$/)
				assert.strictEqual(yield* hash([same]), first)
				assert.notStrictEqual(
					yield* hash([{ ...entry, disabled: true }]),
					first,
				)
				assert.notStrictEqual(
					yield* hash([
						{
							...entry,
							config: { a: 1, token: new Entry.Env({ name: "OTHER" }) },
						},
					]),
					first,
				)
				const withValue = yield* hash([entry]).pipe(
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({ TOKEN: "value-1" }),
						),
					),
				)
				assert.strictEqual(withValue, first)
			}),
	)

	it("uses the entries of the preset as the default", () => {
		assert.deepStrictEqual(PresetPlugins.entries, PluginsFile.presetEntries)
	})
})

describe("show", () => {
	it("prints !env as its name and redacts every other string", () => {
		assert.deepStrictEqual(
			PluginsFile.show([
				{
					id: "probe",
					name: "probe-plugin",
					config: {
						token: new Entry.Env({ name: "TOKEN" }),
						key: "literal-secret",
						size: 3,
						on: true,
						list: ["a", null],
					},
				},
			]),
			[
				{
					id: "probe",
					name: "probe-plugin",
					disabled: false,
					config: {
						token: { env: "TOKEN" },
						key: "<redacted>",
						size: 3,
						on: true,
						list: ["<redacted>", null],
					},
				},
			],
		)
		assert.strictEqual(
			PluginsFile.canonical({
				b: new Entry.Env({ name: "TOKEN" }),
				a: undefined,
			}),
			'{"b":{"env":"TOKEN"}}',
		)
	})
})
