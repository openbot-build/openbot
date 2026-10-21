import { Context, Effect, HashMap, Layer, Option, Ref, Schema } from "effect"

export const readTool = {
	name: "read_document",
	_meta: { ui: { resourceUri: "ui://development/document" } },
	description: "Read a document from the simulated account",
	inputSchema: {
		type: "object",
		properties: { id: { type: "string" } },
		required: ["id"],
		additionalProperties: false,
	},
	outputSchema: {
		type: "object",
		properties: {
			id: { type: "string" },
			text: { type: "string" },
			handlerExecutions: { type: "number" },
		},
		required: ["id", "text", "handlerExecutions"],
	},
	annotations: { readOnlyHint: true },
}

export class Business extends Context.Service<
	Business,
	{
		readonly read: (
			owner: string,
			input: unknown,
			continuation?: {
				readonly requestState?: string
				readonly inputResponses?: Schema.JsonObject
			},
		) => Effect.Effect<Schema.JsonObject, Schema.SchemaError>
		readonly write: (
			owner: string,
			input: unknown,
		) => Effect.Effect<Schema.JsonObject, Schema.SchemaError>
		readonly executions: (owner: string) => Effect.Effect<number>
	}
>()("@openbot-build/platform/app/DevelopmentBusiness/Business") {}

/** Simulated App handlers that keep state. Model responses never make up their results. */
export const layer = Layer.effect(
	Business,
	Effect.gen(function* () {
		const calls = yield* Ref.make(HashMap.empty<string, number>())
		const documents = yield* Ref.make(HashMap.empty<string, string>())
		const inputs = yield* Ref.make(
			HashMap.empty<string, { readonly owner: string; readonly id: string }>(),
		)
		const executionCount = (
			values: HashMap.HashMap<string, number>,
			owner: string,
		) => Option.getOrElse(HashMap.get(values, owner), () => 0)
		const countExecution = (owner: string) =>
			Ref.modify(calls, (values) => {
				const count = executionCount(values, owner) + 1
				return [count, HashMap.set(values, owner, count)] as const
			})
		return Business.of({
			write: (owner, input) =>
				Effect.gen(function* () {
					const { id, text } = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ id: Schema.String, text: Schema.String }),
					)(input)
					yield* Ref.update(documents, (values) =>
						HashMap.set(values, JSON.stringify([owner, id]), text),
					)
					const count = yield* countExecution(owner)
					return {
						content: [{ type: "text", text: "Saved document " + id }],
						structuredContent: { id, text, handlerExecutions: count },
					}
				}),
			executions: (owner) =>
				Ref.get(calls).pipe(
					Effect.map((values) => executionCount(values, owner)),
				),
			read: (owner, input, continuation) =>
				Effect.gen(function* () {
					const { id } = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ id: Schema.String }),
					)(input)
					if (continuation !== undefined) {
						if (continuation.requestState === undefined) {
							const state = yield* Effect.sync(() => crypto.randomUUID())
							yield* Ref.update(inputs, (values) =>
								HashMap.set(values, state, { owner, id }),
							)
							return {
								resultType: "input_required",
								requestState: state,
								inputRequests: {
									consent: {
										method: "elicitation/create",
										params: {
											message: "Continue this simulated document operation?",
											requestedSchema: {
												type: "object",
												properties: { confirmed: { type: "boolean" } },
												required: ["confirmed"],
											},
										},
									},
								},
							}
						}
						const state = continuation.requestState
						const pending = yield* Ref.modify(
							inputs,
							(values) =>
								[
									HashMap.get(values, state),
									HashMap.remove(values, state),
								] as const,
						)
						if (
							!Option.exists(
								pending,
								(pending) => pending.owner === owner && pending.id === id,
							)
						)
							return yield* Schema.decodeUnknownEffect(Schema.Never)(null)
						const accepted = Schema.decodeUnknownOption(
							Schema.Struct({
								consent: Schema.Struct({
									action: Schema.Literal("accept"),
									content: Schema.Struct({ confirmed: Schema.Literal(true) }),
								}),
							}),
						)(continuation.inputResponses)
						if (Option.isNone(accepted))
							return {
								isError: true,
								content: [
									{
										type: "text",
										text: "The simulated operation was declined.",
									},
								],
							}
					}
					const count = yield* countExecution(owner)
					return {
						content: [{ type: "text", text: "Simulated document: " + id }],
						structuredContent: {
							id,
							text: Option.getOrElse(
								HashMap.get(
									yield* Ref.get(documents),
									JSON.stringify([owner, id]),
								),
								() => "Simulated document content for " + id,
							),
							handlerExecutions: count,
						},
					}
				}),
		})
	}),
)

export const writeTool = {
	...readTool,
	name: "write_document",
	description: "Save a document in the simulated account",
	_meta: { ui: { visibility: ["app"] } },
	inputSchema: {
		type: "object",
		properties: { id: { type: "string" }, text: { type: "string" } },
		required: ["id", "text"],
		additionalProperties: false,
	},
}
