import { Effect, Schema, type JsonSchema } from "effect"

export const reasonKey = "openbot_reason"
export const withReason = (
	schema: JsonSchema.JsonSchema,
): JsonSchema.JsonSchema => {
	const declared = schema["properties"]
	const properties =
		typeof declared === "object" && declared !== null ? declared : {}
	return {
		...schema,
		type: "object",
		properties: {
			...properties,
			[reasonKey]: {
				type: "string",
				description:
					"Why you call this tool. A decider reads it when the call needs a decision.",
			},
		},
	}
}
export const split = (input: unknown) =>
	Schema.decodeUnknownEffect(Schema.JsonObject)(input).pipe(
		Effect.map((all) => {
			const { [reasonKey]: reason, ...args } = all
			return {
				args,
				reason:
					typeof reason === "string" && reason.length > 0
						? reason
						: "The Bot gave no reason.",
			}
		}),
	)
