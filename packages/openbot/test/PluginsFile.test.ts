import { NodeCrypto } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Entry } from "@graftland/loader"
import { Array as Arr, Effect, Option, Record as Rec, Result } from "effect"
import * as PluginsFile from "../src/PluginsFile.ts"
import * as Preset from "../src/Preset.ts"
import * as PresetPlugins from "../src/PresetPlugins.ts"

const known = PresetPlugins.known

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
	it("reads plain values", () => {
		const [entry] = parsed("- id: probe\n  config:\n    size: 3\n")
		assert.deepStrictEqual(entry, { id: "probe", config: { size: 3 } })
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

	it("takes a tag as a problem, so no value comes from the environment", () => {
		const found = problems(
			PluginsFile.parse("- id: probe\n  config: !env TOKEN\n"),
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
			Rec.keys(Preset.plugins),
		)
		assert.deepStrictEqual(
			Arr.filter(entries, (entry) => entry.disabled !== undefined),
			[
				{ id: "bots", name: Preset.plugins["bots"].name, disabled: false },
				{
					id: "triggers",
					name: Preset.plugins["triggers"].name,
					disabled: true,
				},
				{
					id: "turn-limiter",
					name: Preset.plugins["turn-limiter"].name,
					disabled: true,
				},
				{
					id: "time-limiter",
					name: Preset.plugins["time-limiter"].name,
					disabled: true,
				},
				{
					id: "token-limiter",
					name: Preset.plugins["token-limiter"].name,
					disabled: true,
				},
			],
		)
	})

	it("turns a limit plugin on with its config", () => {
		const entries = Result.getOrThrow(
			merged(
				"- id: turn-limiter\n  disabled: false\n  config:\n    maxSteps: 40\n",
			),
		)
		assert.deepStrictEqual(
			Arr.findFirst(entries, (entry) => entry.id === "turn-limiter"),
			Option.some<Entry.Entry>({
				id: "turn-limiter",
				name: Preset.plugins["turn-limiter"].name,
				disabled: false,
				config: { maxSteps: 40 },
			}),
		)
		assert.deepStrictEqual(PluginsFile.changes(known, entries).off, [
			"time-limiter",
			"token-limiter",
		])
	})

	it("gives a problem for config on a limit plugin that stays off", () => {
		assert.deepStrictEqual(
			problems(merged("- id: turn-limiter\n  config:\n    maxSteps: 40\n")),
			[
				{
					entry: 1,
					id: "turn-limiter",
					reason: 'This plugin is off. Add "disabled: false" to turn it on.',
				},
			],
		)
		// With "disabled: true" the file says that the plugin stays off.
		assert.isTrue(
			Result.isSuccess(
				merged(
					"- id: turn-limiter\n  disabled: true\n  config:\n    maxSteps: 40\n",
				),
			),
		)
	})

	it("still refuses config on a plugin that takes no config", () => {
		assert.deepStrictEqual(
			problems(merged("- id: triggers\n  config:\n    maxSteps: 40\n")),
			[{ entry: 1, id: "triggers", reason: "This plugin takes no config." }],
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
						`  name: "${Preset.plugins["bots"].name}"`,
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
				`- id: probe\n  name: "${extra}"\n  config:\n    token: a-token\n    size: 3\n`,
				{ ...known, bundled: [...known.bundled, extra] },
			),
		)
		assert.strictEqual(entries.length, Rec.keys(Preset.plugins).length + 1)
		assert.deepStrictEqual(
			Arr.last(entries),
			Option.some({
				id: "probe",
				name: extra,
				config: { token: "a-token", size: 3 },
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

	it.effect("depends on the entries only, not on the order of keys", () =>
		Effect.gen(function* () {
			const entry = {
				id: "probe",
				name: "probe-plugin",
				config: { a: 1, token: "TOKEN" },
			}
			const same = {
				config: { token: "TOKEN", a: 1 },
				name: "probe-plugin",
				disabled: false,
				id: "probe",
			}
			const first = yield* hash([entry])
			assert.match(first, /^sha256:[0-9a-f]{64}$/)
			assert.strictEqual(yield* hash([same]), first)
			assert.notStrictEqual(yield* hash([{ ...entry, disabled: true }]), first)
			assert.notStrictEqual(
				yield* hash([
					{
						...entry,
						config: { a: 1, token: "OTHER" },
					},
				]),
				first,
			)
		}),
	)

	it("uses the entries of the preset as the default", () => {
		assert.deepStrictEqual(PresetPlugins.known.base, Preset.entries)
	})
})

describe("show", () => {
	it("redacts every string", () => {
		assert.deepStrictEqual(
			PluginsFile.show([
				{
					id: "probe",
					name: "probe-plugin",
					config: {
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
						key: "<redacted>",
						size: 3,
						on: true,
						list: ["<redacted>", null],
					},
				},
			],
		)
		assert.strictEqual(
			PluginsFile.canonical({ b: "TOKEN", a: undefined }),
			'{"b":"TOKEN"}',
		)
	})
})
