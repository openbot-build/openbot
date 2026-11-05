import { assert, it } from "@effect/vitest"
import type { Bot } from "@openbot-build/core"
import { Array as Arr, Context, Effect, Record as Rec, Ref } from "effect"
import { Prompt, Tool } from "effect/ai"
import * as Assembly from "../src/Assembly.ts"

const registration = (
	names: ReadonlyArray<string>,
	instructions?: string,
): Bot.ToolRegistration => ({
	tools: Rec.fromEntries(
		Arr.map(names, (name) => [name, Tool.make(name)] as const),
	),
	handlers: Context.empty(),
	...(instructions === undefined
		? {}
		: { instructions: Prompt.make(instructions) }),
})

// A hook of a feature can stop the Turn, so the registration can have an error.
const toolNames = (value: Bot.ToolRegistration<{}, unknown>) => {
	const tools: Readonly<Record<string, Tool.Any>> = value.tools
	return Rec.keys(tools)
}

/** The parts of a Turn as the server has them, with fake tools. */
const parts = (
	built: Ref.Ref<ReadonlyArray<string>>,
	occupied: Ref.Ref<ReadonlyArray<string>>,
): ReadonlyArray<Assembly.Part> => {
	const part = (
		id: string,
		order: number,
		tools: ReadonlyArray<string>,
		options: { readonly last?: boolean; readonly builtIn?: boolean } = {},
	): Assembly.Part => ({
		id,
		order,
		builtIn: options.builtIn ?? false,
		build: options.last === true ? "last" : "normal",
		register: (names) =>
			Effect.gen(function* () {
				yield* Ref.update(built, Arr.append(id))
				if (options.last === true) yield* Ref.set(occupied, names)
				return registration(tools, `${id} rules`)
			}),
	})
	return [
		part("computers", 60, ["computer_run"]),
		part("apps", 10, ["app_call"], { last: true }),
		part("work", 40, ["work_plan"]),
		part("controls", 30, ["control_stop"], { builtIn: true }),
		part("channels", 50, ["channel_send"]),
		part("bots", 20, ["bot_ask", "shared"]),
	]
}

it.effect(
	"parts are built in order, and a last part is built after the others",
	() =>
		Effect.gen(function* () {
			const built = yield* Ref.make<ReadonlyArray<string>>([])
			const occupied = yield* Ref.make<ReadonlyArray<string>>([])
			yield* Assembly.assemble(
				registration(["host_read"]),
				parts(built, occupied),
				["reserved"],
			)
			assert.deepStrictEqual(yield* Ref.get(built), [
				"bots",
				"controls",
				"work",
				"channels",
				"computers",
				"apps",
			])
		}),
)

it.effect(
	"a last part gets the names of the host and the other parts, then the reserved names",
	() =>
		Effect.gen(function* () {
			const built = yield* Ref.make<ReadonlyArray<string>>([])
			const occupied = yield* Ref.make<ReadonlyArray<string>>([])
			yield* Assembly.assemble(
				registration(["host_read"]),
				parts(built, occupied),
				["reserved"],
			)
			assert.deepStrictEqual(yield* Ref.get(occupied), [
				"host_read",
				"bot_ask",
				"shared",
				"control_stop",
				"work_plan",
				"channel_send",
				"computer_run",
				"reserved",
			])
		}),
)

it.effect(
	"tools and instructions merge in the order host, apps, bots, controls, work, channels, computers",
	() =>
		Effect.gen(function* () {
			const built = yield* Ref.make<ReadonlyArray<string>>([])
			const occupied = yield* Ref.make<ReadonlyArray<string>>([])
			const result = yield* Assembly.assemble(
				registration(["host_read"], "host rules"),
				parts(built, occupied),
				[],
			)
			assert.deepStrictEqual(toolNames(result), [
				"host_read",
				"app_call",
				"bot_ask",
				"shared",
				"control_stop",
				"work_plan",
				"channel_send",
				"computer_run",
			])
			assert.deepStrictEqual(
				result.instructions,
				Arr.reduce(
					[
						"host rules",
						"apps rules",
						"bots rules",
						"controls rules",
						"work rules",
						"channels rules",
						"computers rules",
					],
					Prompt.empty,
					(prompt, text) => Prompt.concat(prompt, Prompt.make(text)),
				),
			)
		}),
)

it.effect("a later part wins a name, and the name keeps its first place", () =>
	Effect.gen(function* () {
		const first = Tool.make("same", { description: "first" })
		const second = Tool.make("same", { description: "second" })
		const result = yield* Assembly.assemble(
			registration(["host_read"]),
			[
				{
					id: "b",
					order: 20,
					builtIn: false,
					build: "normal",
					register: () =>
						Effect.succeed({
							tools: { same: second },
							handlers: Context.empty(),
						}),
				},
				{
					id: "a",
					order: 10,
					builtIn: false,
					build: "normal",
					register: () =>
						Effect.succeed({
							tools: { same: first, other: Tool.make("other") },
							handlers: Context.empty(),
						}),
				},
			],
			[],
		)
		assert.deepStrictEqual(toolNames(result), ["host_read", "same", "other"])
		const tools: Readonly<Record<string, Tool.Any>> = result.tools
		assert.strictEqual(tools["same"]?.description, "second")
	}),
)

it.effect("transformPrompt runs in merge order", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<ReadonlyArray<string>>([])
		const part = (id: string, order: number): Assembly.Part => ({
			id,
			order,
			builtIn: false,
			build: id === "last" ? "last" : "normal",
			register: () =>
				Effect.succeed({
					tools: {},
					handlers: Context.empty(),
					transformPrompt: (prompt: Prompt.Prompt) =>
						Effect.as(Ref.update(seen, Arr.append(id)), prompt),
				}),
		})
		const result = yield* Assembly.assemble(
			registration([]),
			[part("c", 30), part("last", 10), part("b", 20)],
			[],
		)
		assert.ok(result.transformPrompt !== undefined)
		yield* result.transformPrompt!(Prompt.empty)
		assert.deepStrictEqual(yield* Ref.get(seen), ["last", "b", "c"])
	}),
)
