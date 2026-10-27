import { CodeRunsApi } from "@openbot-build/api"
import { Operation } from "@openbot-build/core"
import {
	Array as Arr,
	Effect,
	Option,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { Tool } from "effect/ai"
import type * as Bindings from "../../apps/Bindings.ts"
import type { Position } from "../../apps/Invocations.ts"
import type { CodeRuns } from "../../code/CodeRuns.ts"
import { name, ToolResult, toolResult } from "../../code/CodeRuns.ts"
import { declarations } from "../../code/Declarations.ts"
import * as VaultCode from "../../vaults/CodeMode.ts"
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
	/** The Vault items of the Bot. Programs name them, and never see their values. */
	readonly vault: ReadonlyArray<VaultCode.Entry>
	readonly occupied: ReadonlyArray<string>
}): ReadonlyArray<Entry> => {
	if (
		input.bindings.length === 0 ||
		input.occupied.includes(names.api) ||
		input.occupied.includes(names.run)
	)
		return []
	const named = name(input.bindings)
	const index = pipe(
		named,
		Arr.take(200),
		Arr.map(
			({ alias, binding }) =>
				"apps." + alias + ": " + Str.slice(0, 80)(binding.description),
		),
		Arr.join("\n"),
	)
	const vaultDeclarations = VaultCode.declarations(input.vault)
	const vaultIndex =
		input.vault.length === 0
			? ""
			: "\nThe Vault items are: " +
				pipe(
					input.vault,
					Arr.map((entry) => "vault." + entry.alias),
					Arr.join(", "),
				) +
				". `vault.<item>.<field>` is a reference to a secret, not the secret. Put it in a string argument of an App tool. OpenBot puts the secret in when it sends the call, and only to the tools that the item allows."
	const api: Entry = {
		tool: Tool.dynamic(names.api, {
			description:
				"Shows the TypeScript declarations of the App bindings that `" +
				names.run +
				"` can call. Read them before you write a program.",
			parameters: ApiInput,
			success: ApiResult,
		})
			.annotate(Tool.Readonly, true)
			.annotate(Operation.Budget, "foreground") as unknown as Entry["tool"],
		handle: (raw) =>
			Schema.decodeUnknownEffect(ApiInput)(raw).pipe(
				Effect.map((query) => {
					const words = pipe(
						query.query ?? "",
						Str.toLowerCase,
						Str.split(/\s+/),
						Arr.filter(Str.isNonEmpty),
					)
					const found = declarations(named, ({ alias, binding }) => {
						const group = Arr.headNonEmpty(Str.split(alias, "."))
						const text = Str.toLowerCase(
							alias + " " + binding.source.name + " " + binding.description,
						)
						return (
							(query.connections === undefined ||
								query.connections.includes(group)) &&
							Arr.every(words, (word) => Str.includes(word)(text))
						)
					})
					return {
						declarations:
							vaultDeclarations === "" ||
							(query.connections !== undefined &&
								!query.connections.includes("vault"))
								? found
								: found + "\n\n" + vaultDeclarations,
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
					: "") +
				vaultIndex,
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
		}).annotate(Operation.Budget, "foreground") as unknown as Entry["tool"],
		handle: (_raw, context) =>
			(context.toolCallId === undefined
				? Effect.succeed(unavailable("The program has no tool call."))
				: input.codeRuns
						.forCall(
							input.position.owner,
							input.position.chat,
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
