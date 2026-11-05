import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import * as Preset from "../src/app/Preset.ts"
import * as PresetPlugins from "../src/app/PresetPlugins.ts"
import * as Feature from "@openbot-build/server-plugin/Feature"

/** The plugin that publishes each key, by the key. */
const publishers: Readonly<Record<string, string>> = Rec.fromEntries(
	Arr.flatMap(Preset.ids, (id) =>
		Arr.map(
			Feature.keys(PresetPlugins.byId[id]).publishes,
			(key) => [key.key, id] as const,
		),
	),
)

/** The other plugins that each plugin waits for, in name order. */
const needs: Readonly<Record<string, ReadonlyArray<string>>> = Rec.fromEntries(
	Arr.map(Preset.ids, (id) => [
		id,
		Arr.sort(
			Arr.dedupe(
				Arr.filter(
					Arr.flatMap(Feature.keys(PresetPlugins.byId[id]).inject, (key) =>
						Option.toArray(Rec.get(publishers, key.key)),
					),
					(other) => other !== id,
				),
			),
			Order.String,
		),
	]),
)

/** Every plugin that stops when `id` is off: the plugins that need it, and the plugins that need those. */
const stopsWith = (id: string): ReadonlyArray<string> => {
	const step = (
		found: ReadonlyArray<string>,
		next: ReadonlyArray<string>,
	): ReadonlyArray<string> => {
		const more = Arr.filter(
			Rec.keys(needs),
			(other) =>
				other !== id &&
				!Arr.contains(found, other) &&
				Arr.some(next, (one) => Arr.contains(needs[other] ?? [], one)),
		)
		return Arr.isReadonlyArrayEmpty(more)
			? found
			: step([...found, ...more], more)
	}
	return Arr.sort(step([], [id]), Order.String)
}

/**
 * The "Needs" column of the table on the Plugins page of the docs. When a
 * plugin gets a new key to wait for, change this list and the docs.
 */
const documented: Readonly<Record<string, ReadonlyArray<string>>> = {
	audit: [],
	mail: [],
	platform: [
		"access",
		"audit",
		"auth",
		"authorization",
		"mail",
		"models",
		"organization",
	],
	organization: [
		"audit",
		"auth",
		"authorization",
		"mail",
		"models",
		"platform",
	],
	access: ["auth", "authorization"],
	sso: ["access", "audit", "auth", "authorization"],
	auth: [
		"access",
		"audit",
		"authorization",
		"mail",
		"organization",
		"platform",
		"sso",
	],
	authorization: ["auth", "organization", "platform"],
	models: ["audit", "auth", "authorization"],
	files: ["auth", "authorization"],
	artifacts: [
		"apps",
		"auth",
		"authorization",
		"computers",
		"files",
		"imported",
		"organization",
	],
	bots: [
		"audit",
		"auth",
		"authorization",
		"capabilities",
		"chats",
		"imported",
		"mail",
		"models",
		"organization",
		"work",
	],
	capabilities: [
		"apps",
		"audit",
		"auth",
		"authorization",
		"bots",
		"chats",
		"imported",
		"models",
	],
	work: ["bots", "chats"],
	imported: ["authorization", "bots"],
	chats: [
		"auth",
		"authorization",
		"bots",
		"capabilities",
		"channels",
		"files",
		"imported",
		"models",
		"organization",
	],
	channels: [
		"audit",
		"auth",
		"authorization",
		"bots",
		"capabilities",
		"chats",
		"imported",
		"models",
		"organization",
	],
	apps: [
		"auth",
		"authorization",
		"bots",
		"capabilities",
		"chats",
		"code",
		"imported",
		"models",
		"vaults",
	],
	code: ["apps", "auth", "authorization", "chats", "imported", "vaults"],
	vaults: ["audit", "auth", "authorization", "bots"],
	computers: ["audit", "auth", "authorization", "bots", "chats"],
	triggers: ["audit", "auth", "authorization", "bots", "chats", "models"],
	billing: ["audit", "auth", "authorization", "organization"],
	settings: ["auth", "authorization", "bots"],
	"turn-limiter": [],
	"time-limiter": [],
	"token-limiter": [],
}

describe("PluginNeeds", () => {
	it("the docs name every plugin that each plugin needs", () => {
		assert.deepStrictEqual(needs, documented)
	})

	it("only the plugins that nothing needs can be turned off alone", () => {
		const alone = Arr.filter(
			Preset.ids,
			(id) =>
				!Arr.contains(Preset.required, id) &&
				Arr.isReadonlyArrayEmpty(stopsWith(id)),
		)
		assert.deepStrictEqual(alone, [
			"artifacts",
			"triggers",
			"billing",
			"settings",
			"turn-limiter",
			"time-limiter",
			"token-limiter",
		])
	})

	it("a plugin that a needed plugin uses can not be turned off", () => {
		const needed = Arr.filter(
			Preset.ids,
			(id) =>
				!Arr.contains(Preset.required, id) &&
				Arr.some(stopsWith(id), (other) =>
					Arr.contains(Preset.required, other as Preset.Id),
				),
		)
		assert.deepStrictEqual(needed, ["mail", "sso", "models"])
	})

	it("every key that a plugin needs comes from one plugin only", () => {
		const keys = Arr.flatMap(Preset.ids, (id) =>
			Arr.map(Feature.keys(PresetPlugins.byId[id]).publishes, (key) => key.key),
		)
		assert.strictEqual(Arr.dedupe(keys).length, keys.length)
	})
})
