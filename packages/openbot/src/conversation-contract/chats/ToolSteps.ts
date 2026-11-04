import { Schema } from "effect"
import { Prompt } from "effect/ai"

const Output = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	result: Schema.optionalKey(Schema.Json),
	isFailure: Schema.Boolean,
	preliminary: Schema.Boolean,
	modelOutput: Schema.optionalKey(Schema.Array(Prompt.ToolModelOutputPart)),
})

export const outputCodec = Schema.toCodecJson(Output)

/** The id of the durable step that saves the result of one tool call. */
export const stepId = (item: string, call: string) =>
	`tool:${item.length}:${item}${call}`
