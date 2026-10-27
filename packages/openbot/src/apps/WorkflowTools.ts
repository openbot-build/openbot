import type { Definition } from "../chats/ToolDefinitions.ts"
import { withReason, split } from "./ToolInput.ts"
import { CallContext } from "../execution/CallContext.ts"
import { toolJson } from "../plugins/ToolJson.ts"
import { Operation } from "@openbot-build/core"
import { AppCalls, CodeRuns, Execution, Vaults } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Effect,
	Option,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { Tool, type Toolkit } from "effect/ai"
import { CodeCommands } from "../code/CodeCommands.ts"
import { name, type Binding } from "../code/Bindings.ts"
import { declarations } from "../code/Declarations.ts"
import { ApiInput, RunInput, names } from "../code/ToolSchema.ts"
import { Records, category } from "../errors/Records.ts"
import { Observation } from "../execution/Observation.ts"
import * as Recovery from "../execution/Recovery.ts"
import { type Fence } from "../execution/Store.ts"
import { InputState, Local } from "../plugins/ToolEntry.ts"
import * as VaultCode from "../vaults/CodeMode.ts"
import { AppCommands } from "./AppCommands.ts"
import { json } from "./AppResults.ts"

export type Tools = Record<
	string,
	Tool.Tool<
		string,
		{
			readonly parameters: typeof Schema.Unknown
			readonly success: typeof Schema.Json
			readonly failure: typeof Schema.Never
			readonly failureMode: "error"
		},
		CallContext
	>
>
export interface Entry {
	readonly tool: Tools[string]
	readonly handle: (
		input: unknown,
		context: Toolkit.HandlerContext<Tools[string]>,
	) => Effect.Effect<Schema.Json, never, CallContext>
}
const AppState = Schema.Struct({
	kind: Schema.Literal("app"),
	input: Schema.Literals(["host", "model"]),
	source: AppCalls.Source,
})
const CodeState = Schema.Struct({
	kind: Schema.Literal("code"),
	bindings: Schema.Array(CodeRuns.Binding),
	vault: Schema.Array(Vaults.ReferenceBinding),
})

/** Tools only submit and read work. The feature workflows own outside calls and scopes. */
export const make = Effect.gen(function* () {
	const apps = yield* AppCommands
	const code = yield* CodeCommands
	const observation = yield* Observation
	const errors = yield* Records
	const recovery = yield* Recovery.make
	const safe = <A extends Schema.Json, E, R>(
		fence: Fence,
		work: Effect.Effect<A, E, R>,
	) =>
		recovery.storage(fence.id, work).pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: errors.record(cause, category(cause), fence.id).pipe(
							Effect.map((failure) => ({ failure })),
							Effect.orDie,
						),
			),
		)
	const runApp =
		(fence: Fence, toolName: string): Entry["handle"] =>
		(raw, context) =>
			safe(
				fence,
				Effect.gen(function* () {
					if (context.toolCallId === undefined)
						return yield* Execution.Conflict.make({ id: fence.id })
					const state = yield* Schema.decodeUnknownEffect(AppState)(
						(yield* CallContext).inputState,
					)
					const { args, reason } = yield* state.input === "host"
						? Schema.decodeUnknownEffect(Schema.JsonObject)(raw).pipe(
								Effect.map((args) => ({
									args,
									reason: "The person used the App view.",
								})),
							)
						: split(raw)
					const receipt = yield* apps.submit(
						fence,
						Execution.mainCall(context.toolCallId),
						{
							source: state.source,
							arguments: args,
							toolName,
							reason,
						},
					)
					const key = { namespace: fence.namespace, id: receipt.executionId }
					const first = yield* observation.observe(key, 0).pipe(
						Stream.mapEffect(() => apps.first(key)),
						Stream.filter(
							(first) =>
								Option.isSome(first.outcome) ||
								Execution.isTerminal(first.execution.status),
						),
						Stream.runHead,
						Effect.flatMap(
							Option.match({
								onNone: () =>
									Effect.fail(Execution.Conflict.make({ id: key.id })),
								onSome: Effect.succeed,
							}),
						),
					)
					return yield* json({
						operationId: first.id,
						executionId: key.id,
						source: state.source,
						status: first.execution.status,
						outcome: Option.getOrNull(first.outcome),
						failure: first.execution.failure,
					})
				}),
			)
	const app = (fence: Fence, binding: Binding): Entry => ({
		tool: Tool.dynamic(binding.name, {
			description: `${binding.source.appName} / ${binding.source.connectionName} / ${binding.source.name}. ${binding.description}`,
			parameters: withReason(binding.schema),
			success: Schema.Json,
		})
			.addDependency(CallContext)
			.annotate(Local, true)
			.annotate(Tool.Readonly, binding.readOnly)
			.annotate(
				InputState,
				toolJson({ kind: "app", input: "model", source: binding.source }),
			),
		handle: runApp(fence, binding.name),
	})
	const runProgram =
		(fence: Fence): Entry["handle"] =>
		(raw, context) =>
			safe(
				fence,
				Effect.gen(function* () {
					if (context.toolCallId === undefined)
						return yield* Execution.Conflict.make({ id: fence.id })
					const state = yield* Schema.decodeUnknownEffect(CodeState)(
						(yield* CallContext).inputState,
					)
					const input = yield* Schema.decodeUnknownEffect(RunInput)(raw)
					const receipt = yield* code.submit(
						fence,
						Execution.mainCall(context.toolCallId),
						{
							...input,
							bindings: state.bindings,
							vault: state.vault,
						},
					)
					const key = { namespace: fence.namespace, id: receipt.executionId }
					yield* observation.observe(key, 0).pipe(Stream.runDrain)
					yield* code.authorize(
						key,
						(yield* code.load(key)).execution.identity.actor,
						"replay",
					)
					const saved = yield* code.view(key)
					return yield* json({
						run: saved.id,
						executionId: key.id,
						status: saved.status,
						result: saved.result,
						failure: saved.failure,
					})
				}),
			)
	const program = (
		fence: Fence,
		bindings: ReadonlyArray<Binding>,
		vault: ReadonlyArray<VaultCode.Entry>,
		occupied: ReadonlyArray<string>,
	): ReadonlyArray<Entry> => {
		if (
			bindings.length === 0 ||
			Arr.contains(occupied, names.run) ||
			Arr.contains(occupied, names.api)
		)
			return []
		const named = name(bindings)
		const index = Arr.join(
			Arr.map(
				Arr.take(named, 200),
				({ alias, binding }) =>
					`apps.${alias}: ${Str.slice(0, 80)(binding.description)}`,
			),
			"\n",
		)
		return [
			{
				tool: Tool.dynamic(names.api, {
					description: `Shows the TypeScript declarations for ${names.run}. Read them before writing a program.`,
					parameters: Schema.toJsonSchemaDocument(ApiInput).schema,
					success: Schema.Json,
				})
					.annotate(Tool.Readonly, true)
					.annotate(Operation.Budget, "foreground"),
				handle: (raw) =>
					safe(
						fence,
						Effect.gen(function* () {
							const query = yield* Schema.decodeUnknownEffect(ApiInput)(raw)
							const words = Arr.filter(
								Str.split(/\s+/)(Str.toLowerCase(query.query ?? "")),
								Str.isNonEmpty,
							)
							const found = declarations(named, ({ alias, binding }) => {
								const group = Arr.headNonEmpty(Str.split(alias, "."))
								const text = Str.toLowerCase(
									`${alias} ${binding.source.name} ${binding.description}`,
								)
								return (
									(query.connections === undefined ||
										Arr.contains(query.connections, group)) &&
									Arr.every(words, (word) => Str.includes(word)(text))
								)
							})
							const secrets =
								query.connections === undefined ||
								Arr.contains(query.connections, "vault")
									? VaultCode.declarations(vault)
									: ""
							return {
								declarations: secrets === "" ? found : `${found}\n\n${secrets}`,
							}
						}),
					),
			},
			{
				tool: Tool.dynamic(names.run, {
					description: `Runs an async JavaScript function body with App bindings. It has no network, files or timers. Each App call uses the current policy and may wait for a decision. A replay starts from the top and reuses saved answers. Keep calls in the same order. Use await apps.<connection>.<name>(args), then return a value. Vault fields are references, never secret values; put them in App tool string arguments. Read ${names.api} first. Bindings:\n${index}`,
					parameters: Schema.toJsonSchemaDocument(RunInput).schema,
					success: Schema.Json,
				})
					.addDependency(CallContext)
					.annotate(Local, true)
					.annotate(
						InputState,
						toolJson({
							kind: "code",
							bindings: Arr.map(named, ({ alias, binding }) => ({
								alias,
								source: binding.source,
							})),
							vault: Arr.map(vault, ({ alias, usable }) => ({
								alias,
								item: usable.item.id,
								fields: usable.item.fields,
							})),
						}),
					),
				handle: runProgram(fence),
			},
		]
	}
	const restore = (
		fence: Fence,
		definition: Definition,
	): Option.Option<Entry> => {
		const state = definition.inputState
		if (!Schema.is(AppState)(state) && !Schema.is(CodeState)(state))
			return Option.none()
		return Option.some({
			tool: Tool.dynamic(definition.name, {
				parameters: definition.parameters,
				success: Schema.Json,
			})
				.addDependency(CallContext)
				.annotate(Local, true)
				.annotate(Tool.Readonly, definition.readOnly)
				.annotate(InputState, state),
			handle:
				state.kind === "app"
					? runApp(fence, definition.name)
					: runProgram(fence),
		})
	}
	return { app, program, restore }
})
