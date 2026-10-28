import { Execution } from "@openbot-build/domain"
import { Array as Arr, Context, Duration, Effect, Option, Schema } from "effect"
import { Operation, type ModelStep } from "@openbot-build/core"
import { Tool } from "effect/ai"
import { InputState, Local, Idempotent } from "../plugins/ToolEntry.ts"
import type { Store, Key } from "../execution/Store.ts"

/** The tool data shown to a model is part of that model call's saved input. */
export const Definition = Schema.Struct({
	name: Schema.String,
	description: Schema.optionalKey(Schema.String),
	parameters: Schema.JsonObject,
	readOnly: Schema.Boolean,
	local: Schema.Boolean,
	idempotent: Schema.Boolean,
	inputState: Schema.optionalKey(Schema.Json),
	budgetMs: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
})
export type Definition = typeof Definition.Type
export const capture = (tool: Tool.Any) => {
	const inputState = Context.get(tool.annotations, InputState)
	const budget = Option.getOrUndefined(
		Context.getOption(tool.annotations, Operation.Budget),
	)
	return Schema.decodeUnknownEffect(Definition)({
		name: tool.name,
		...(Tool.getDescription(tool) === undefined
			? {}
			: { description: Tool.getDescription(tool) }),
		parameters: Tool.getJsonSchema(tool),
		readOnly: Context.get(tool.annotations, Tool.Readonly),
		local: Context.get(tool.annotations, Local),
		idempotent: Context.get(tool.annotations, Idempotent),
		...(budget === undefined
			? {}
			: {
					budgetMs:
						budget === "foreground"
							? null
							: Duration.toMillis(Duration.fromInputUnsafe(budget)),
				}),
		...(inputState === undefined ? {} : { inputState }),
	})
}
const ModelInput = Schema.Struct({ tools: Schema.Array(Definition) })
export const selected = (
	store: typeof Store.Service,
	parent: Key,
	position: ModelStep.Position,
	name: string,
	current?: Tool.Any,
) =>
	Effect.gen(function* () {
		const last = yield* store.latestCall(parent, `model:${position.item}`)
		if (Option.isNone(last)) {
			// An explicit Turn action has no model call. Its command fixes its first tool definition.
			const saved = yield* store.loadMember(parent)
			const command = Schema.decodeUnknownOption(
				Schema.Struct({ actionDefinition: Definition }),
			)(saved.input)
			if (Option.isSome(command))
				return command.value.actionDefinition.name === name
					? Option.some(command.value.actionDefinition)
					: Option.none<Definition>()
			return current === undefined
				? Option.none<Definition>()
				: Option.some(yield* capture(current))
		}
		if (last.value.status !== "completed")
			return yield* Execution.Conflict.make({ id: parent.id })
		const input = yield* Schema.decodeUnknownEffect(ModelInput)(
			last.value.input,
		)
		const tool = Arr.findFirst(input.tools, (tool) => tool.name === name)
		return tool
	})
