import { Execution } from "@openbot-build/domain"
import { Schema } from "effect"

export const CallInput = Schema.Struct({
	index: Schema.Natural,
	binding: Schema.String,
	arguments: Schema.String,
})
export const Submitted = Schema.TaggedUnion({
	Child: { executionId: Execution.Id },
	Rejected: { name: Schema.String, message: Schema.String },
})
