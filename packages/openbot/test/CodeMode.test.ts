import * as ErrorRecordsFixture from "./ErrorRecordsFixture.ts"
import { Records } from "../src/errors/Records.ts"
import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { ConnectionsApi } from "@openbot-build/api"
import {
	Array as Arr,
	Cause,
	Effect,
	Logger,
	Layer,
	Option,
	Ref,
	String as Str,
} from "effect"
import type { Binding } from "../src/code/Bindings.ts"
import { name } from "../src/code/Bindings.ts"
import { declarations } from "../src/code/Declarations.ts"
import type { Call } from "../src/code/Protocol.ts"
import { make as makeSandbox, type Program } from "../src/code/Sandbox.ts"
import * as BrowserHost from "./BrowserHost.ts"

const limits = {
	timeoutMs: 2_000,
	memoryBytes: 32 * 1024 * 1024,
	outputBytes: 4_096,
}

/** Runs a program. Each App call answers with its name and arguments. */
const runProgram = (code: string, options: Partial<Program> = {}) =>
	Effect.gen(function* () {
		const sandbox = yield* makeSandbox
		const seen = yield* Ref.make<ReadonlyArray<Call>>([])
		const outcome = yield* sandbox.run(
			{
				code,
				bindings: ["calendar.list", "calendar.add"],
				seed: 7,
				clock: 1_000,
				limits,
				...options,
			},
			(calls) =>
				Effect.map(Ref.update(seen, Arr.appendAll(calls)), () =>
					Option.some(
						Arr.map(calls, (call) => ({
							index: call.index,
							ok: true as const,
							value: JSON.stringify({
								binding: call.binding,
								arguments: JSON.parse(call.arguments),
							}),
						})),
					),
				),
		)
		return { outcome, seen: yield* Ref.get(seen) }
	})

it.layer(Layer.merge(NodeFileSystem.layer, ErrorRecordsFixture.layer))((it) => {
	it.effect(
		"a program runs in a closed sandbox and gets its App results in order",
		() =>
			Effect.gen(function* () {
				const { outcome, seen } = yield* runProgram(`
			const [a, b] = await Promise.all([
				apps.calendar.list({ day: 1 }),
				apps.call("calendar.add", { title: "Lunch" }),
			])
			console.log("first", a.arguments.day)
			return { a, b, now: Date.now(), date: new Date().getTime(), random: Math.random() }
		`)
				assert.strictEqual(outcome._tag, "Done")
				assert.deepStrictEqual(
					Arr.map(seen, (call) => [call.index, call.binding]),
					[
						[0, "calendar.list"],
						[1, "calendar.add"],
					],
				)
				if (outcome._tag !== "Done") return
				assert.deepStrictEqual(outcome.logs, ["first 1"])
				const value = outcome.value as Record<string, unknown>
				assert.strictEqual(value["now"], 1_000)
				assert.strictEqual(value["date"], 1_000)
				// The same seed gives the same random numbers in each run.
				const again = yield* runProgram("return Math.random()")
				const other = yield* runProgram("return Math.random()", { seed: 8 })
				assert.strictEqual(again.outcome._tag, "Done")
				assert.strictEqual(other.outcome._tag, "Done")
				if (again.outcome._tag !== "Done" || other.outcome._tag !== "Done")
					return
				assert.strictEqual(again.outcome.value, value["random"])
				assert.notStrictEqual(other.outcome.value, value["random"])
			}),
	)

	it.effect(
		"a defect of the host gives an unavailable result and keeps its cause out of the log",
		() => {
			let errors: ReadonlyArray<Cause.Cause<unknown>> = []
			const logger = Logger.layer([
				Logger.make((log) => {
					if (log.logLevel === "Error") errors = [...errors, log.cause]
				}),
			])
			return Effect.gen(function* () {
				const recorded = yield* ErrorRecordsFixture.make
				const sandbox = yield* makeSandbox.pipe(
					Effect.provideService(Records, recorded.records),
				)
				const outcome = yield* sandbox.run(
					{
						code: "await apps.calendar.list({}); return 1",
						bindings: ["calendar.list"],
						seed: 1,
						clock: 1,
						limits,
					},
					() => Effect.die(new Error("The inside state is broken.")),
				)
				assert.deepStrictEqual(outcome, {
					_tag: "Failed",
					reason: "Unavailable",
					message: "OpenBot could not run the program.",
					logs: [],
				})
				assert.strictEqual(errors.length, 1)
				assert.notMatch(
					Arr.join(Arr.map(errors, Cause.pretty), "\n"),
					/The inside state is broken\./,
				)
				const saved = yield* recorded.failures
				assert.match(
					Cause.pretty(saved[0]!.cause),
					/The inside state is broken\./,
				)
			}).pipe(Effect.provide(logger))
		},
	)
})

// These tests need real time: the sandbox stops a program after a real
// timeout.
it.layer(Layer.merge(BrowserHost.layerPlatform, ErrorRecordsFixture.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"a program has no Node.js, and the sandbox stops programs at their limits",
		() =>
			Effect.gen(function* () {
				const closed = yield* runProgram(
					"return [typeof fetch, typeof require, typeof process, typeof setTimeout, typeof globalThis.__openbot_host]",
				)
				assert.deepStrictEqual(
					closed.outcome._tag === "Done" && closed.outcome.value,
					["undefined", "undefined", "undefined", "undefined", "undefined"],
				)
				const cases = [
					["while (true) {}", "Timeout"],
					["const list = []; for (;;) list.push({ a: [1, 2, 3] })", "Memory"],
					["return 'x'.repeat(10000)", "OutputTooLarge"],
					["throw new Error('boom')", "Error"],
					// A value that JSON cannot hold is an error of the program.
					["const a = []; a[0] = a; return a", "Error"],
					["return 10n", "Error"],
					["await new Promise(() => {})", "Error"],
					["return apps.calendar.remove({})", "Error"],
					["return apps.calendar.list('not an object')", "Error"],
				] as const
				for (const [code, reason] of cases) {
					const { outcome, seen } = yield* runProgram(code)
					assert.strictEqual(outcome._tag, "Failed", code)
					assert.strictEqual(
						outcome._tag === "Failed" && outcome.reason,
						reason,
						code,
					)
					assert.strictEqual(seen.length, 0, code)
				}
				const logged = yield* runProgram(
					"for (let i = 0; i < 1000; i++) console.log('line ' + i); return 1",
				)
				assert.strictEqual(logged.outcome._tag, "Done")
				if (logged.outcome._tag === "Done")
					assert.strictEqual(
						logged.outcome.logs.at(-1),
						"[More output was cut off.]",
					)
				// An App error reaches the program as an Error that it can catch.
				const denying = yield* makeSandbox
				const failing = yield* denying.run(
					{
						code: "try { await apps.calendar.list({}) } catch (error) { return [error.name, error.details.operationId] }",
						bindings: ["calendar.list"],
						seed: 1,
						clock: 1,
						limits,
					},
					(calls) =>
						Effect.succeedSome(
							Arr.map(calls, (call) => ({
								index: call.index,
								ok: false as const,
								error: JSON.stringify({
									name: "AppCallDenied",
									message: "No.",
									details: { operationId: "op_1" },
								}),
							})),
						),
				)
				assert.deepStrictEqual(failing._tag === "Done" && failing.value, [
					"AppCallDenied",
					"op_1",
				])
				// When the host gives no answer, the program stops and waits.
				const silent = yield* makeSandbox
				const stopped = yield* silent.run(
					{
						code: "await apps.calendar.list({}); return 1",
						bindings: ["calendar.list"],
						seed: 1,
						clock: 1,
						limits,
					},
					() => Effect.succeedNone,
				)
				assert.strictEqual(stopped._tag, "Stopped")
			}),
	)
})

it.effect(
	"each binding gets a stable short name and a TypeScript declaration",
	() =>
		Effect.sync(() => {
			const binding = (
				connectionId: string,
				connectionName: string,
				toolName: string,
				kind: "tool" | "resource" = "tool",
			): Binding => ({
				name: "openbot_" + toolName,
				source: {
					connectionId: ConnectionsApi.ConnectionId.make(connectionId),
					connectionName,
					cardUrl: "https://apps.example.com/card",
					appName: "Example",
					remoteIndex: 0,
					revision: 0,
					kind,
					name: toolName,
				},
				schema: {
					type: "object",
					properties: {
						day: { type: "integer", description: "The day of the month." },
						tags: { type: "array", items: { type: "string" } },
						mode: { enum: ["fast", "slow"] },
					},
					required: ["day"],
				},
				description: "Lists events.",
				needsDecision: kind === "tool",
				readOnly: false,
			})
			const named = name([
				binding("b", "Work calendar", "list-events"),
				binding("a", "Work calendar", "list-events"),
				binding("a", "Work calendar", "notes://index", "resource"),
				binding("c", "Call", "add"),
			])
			assert.deepStrictEqual(
				Arr.map(named, (entry) => entry.alias),
				[
					"work_calendar.notes_index_resource",
					"work_calendar.list_events",
					"work_calendar_2.list_events",
					"call_2.add",
				],
			)
			const text = declarations(named, ({ alias }) =>
				Str.startsWith("work_calendar.")(alias),
			)
			assert.match(text, /declare const apps: \{/)
			assert.match(
				text,
				/list_events\(args: \{ \/\*\* The day of the month\. \*\/ "day": number; "tags"\?: Array<string>; "mode"\?: "fast" \| "slow" \}\): Promise<ToolResult>/,
			)
			assert.match(
				text,
				/notes_index_resource\(args: .*\): Promise<ReadResult>/,
			)
			assert.strictEqual(Str.includes("work_calendar_2")(text), false)
		}),
)
