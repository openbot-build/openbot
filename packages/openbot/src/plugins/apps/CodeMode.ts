import { CodeRunsApi } from "@openbot-build/api"
import { Effect, Option, Schema } from "effect"
import { Tool } from "effect/ai"
import type * as Bindings from "../../apps/Bindings.ts"
import type { Position } from "../../apps/Invocations.ts"
import type { CodeRuns } from "../../code/CodeRuns.ts"
import { name, ToolResult, toolResult } from "../../code/CodeRuns.ts"
import { declarations } from "../../code/Declarations.ts"
import type { Entry } from "./AppPlugin.ts"

/** The names of the Code Mode tools. */
export const names = {
	api: "openbot_code_api",
	run: "openbot_run_code",
} as const

const ApiInput = Schema.Struct({
	query: Schema.optionalKey(
		Schema.String.annotate({
			description:
				"Words to look for in the names and descriptions of the bindings.",
		}),
	),
	connections: Schema.optionalKey(
		Schema.Array(Schema.String).annotate({
			description:
				"The first part of binding names, such as `calendar`, to show only these connections.",
		}),
	),
})
const ApiResult = Schema.Struct({ declarations: Schema.String })
const RunInput = Schema.Struct({
	code: CodeRunsApi.Code.annotate({
		description:
			"The body of an async JavaScript function. Use `await apps.<connection>.<name>(args)` and `return` the value you need.",
	}),
	reason: Schema.String.annotate({
		description:
			"Why you run this program. A decider reads it when a call needs a decision.",
	}),
})

const unavailable = (message: string): ToolResult => ({
	run: "",
	result: { _tag: "Failed", reason: "Unavailable", message, logs: [] },
	calls: [],
})

/** The Code Mode tools for one Turn. They use the same bindings as the App tools. */
export const entries = (input: {
	readonly codeRuns: typeof CodeRuns.Service
	readonly position: Position
	readonly bindings: ReadonlyArray<Bindings.Binding>
	readonly occupied: ReadonlyArray<string>
}): ReadonlyArray<Entry> => {
	if (
		input.bindings.length === 0 ||
		input.occupied.includes(names.api) ||
		input.occupied.includes(names.run)
	)
		return []
	const named = name(input.bindings)
	const index = named
		.slice(0, 200)
		.map(
			({ alias, binding }) =>
				"apps." + alias + ": " + binding.description.slice(0, 80),
		)
		.join("\n")
	const api: Entry = {
		tool: Tool.dynamic(names.api, {
			description:
				"Shows the TypeScript declarations of the App bindings that `" +
				names.run +
				"` can call. Read them before you write a program.",
			parameters: ApiInput,
			success: ApiResult,
		}).annotate(Tool.Readonly, true) as unknown as Entry["tool"],
		handle: (raw) =>
			Schema.decodeUnknownEffect(ApiInput)(raw).pipe(
				Effect.map((query) => {
					const words = (query.query ?? "")
						.toLowerCase()
						.split(/\s+/)
						.filter((word) => word.length > 0)
					return {
						declarations: declarations(named, ({ alias, binding }) => {
							const group = alias.split(".")[0]!
							const text = (
								alias +
								" " +
								binding.source.name +
								" " +
								binding.description
							).toLowerCase()
							return (
								(query.connections === undefined ||
									query.connections.includes(group)) &&
								words.every((word) => text.includes(word))
							)
						}),
					}
				}),
				Effect.orElseSucceed(() => ({
					declarations: "The query is not valid.",
				})),
			) as unknown as ReturnType<Entry["handle"]>,
	}
	const run: Entry = {
		tool: Tool.dynamic(names.run, {
			description:
				"Runs a short JavaScript program that calls App bindings, and gives back what it returns. " +
				"Use it to call many App tools at once, or to filter and join large results before you read them. " +
				"The program is the body of an async function. It has no network, no files and no timers. " +
				"Each App call goes through the same checks as a normal App tool call. " +
				"When a call needs a decision, the program waits, and then starts again from the top: calls that already ran give the same result and do not run again. " +
				"So the program must make the same calls in the same order each time. " +
				"Read the declarations with `" +
				names.api +
				"` first. The bindings are:\n" +
				index +
				(named.length > 200
					? "\n(More bindings exist. Search them with `" + names.api + "`.)"
					: ""),
			parameters: RunInput,
			success: ToolResult,
			needsApproval: (raw, context) =>
				Schema.decodeUnknownEffect(RunInput)(raw).pipe(
					Effect.flatMap(({ code, reason }) =>
						input.codeRuns.start({
							position: input.position,
							callId: context.toolCallId,
							code,
							reason,
							bindings: input.bindings,
						}),
					),
					// The Turn waits only while a call of the program waits for a decision.
					Effect.map((run) => run.status === "Waiting"),
					// Without a run the handler reports the problem, so the Turn does not wait.
					Effect.catch((error) =>
						Effect.logWarning("Could not run a Code Mode program.", error).pipe(
							Effect.as(false),
						),
					),
				),
		}) as unknown as Entry["tool"],
		handle: (_raw, context) =>
			(context.toolCallId === undefined
				? Effect.succeed(unavailable("The program has no tool call."))
				: input.codeRuns
						.forCall(
							input.position.owner,
							input.position.session,
							context.toolCallId,
						)
						.pipe(
							Effect.map(
								Option.match({
									onNone: () =>
										unavailable("OpenBot could not run or save the program."),
									onSome: toolResult,
								}),
							),
							Effect.orElseSucceed(() =>
								unavailable("OpenBot could not read the program."),
							),
						)) as unknown as ReturnType<Entry["handle"]>,
	}
	return [api, run]
}
