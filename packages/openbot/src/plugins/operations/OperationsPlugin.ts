import { Bot, Operation, type Operations, Plugin } from "@openbot-build/core"
import { Effect, type JsonSchema, Record, Schema, Stream } from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { toolJson } from "../ToolJson.ts"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/operations")

/** The tools of this plugin. Their parameters are JSON Schema, like App tools. */
export type Tools = Record<
	string,
	Tool.Dynamic<
		string,
		{
			readonly parameters: JsonSchema.JsonSchema
			readonly success: typeof Schema.Json
			readonly failure: typeof Schema.Never
			readonly failureMode: "error"
		}
	>
>

export const names = {
	status: "openbot_operation_status",
	wait: "openbot_operation_wait",
	cancel: "openbot_operation_cancel",
} as const

/** The longest time that one wait may take. A longer wait would keep the Turn from its other work. */
export const maxWait = 30 * 1000

const StatusInput = Schema.Struct({ id: Operation.Id })
const WaitInput = Schema.Struct({
	ids: Schema.Array(Operation.Id).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(20),
	),
	timeout_ms: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxWait })),
	),
})

const instructions = `A tool call that takes more time than its budget goes on in the background. Then you get an operation id at once, and the result comes back to this Chat as a message when the call ends. You do not need to wait for it: do other work, or end your answer. Call ${names.wait} only when your next step needs the result now. Call ${names.status} to see where an operation is, and ${names.cancel} to stop one that is no longer needed.`

const idSchema = { type: "string" } as const

interface Entry {
	readonly tool: Tools[string]
	readonly handle: (input: unknown) => Effect.Effect<Schema.Json>
}

const view = (record: Operation.Record) =>
	toolJson({
		operation: record.id,
		tool: record.tool,
		status: record.status,
		startedAt: new Date(record.startedAt).toISOString(),
		...(record.endedAt === undefined
			? {}
			: { endedAt: new Date(record.endedAt).toISOString() }),
	})

const notFound = (id: string) =>
	toolJson({ error: `There is no operation ${id} in this Chat.` })

/**
 * The tools that read, wait for and stop the background calls of the current Chat.
 * They never go to the background themselves.
 */
export const make = (
	operations: typeof Operations.Operations.Service,
): Plugin.Plugin<Tools> =>
	Plugin.make({ id: pluginId })<Tools>(() =>
		Effect.succeed((next, options) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const context = yield* Bot.Context
					const chat = (yield* context.at).chat
					const entry = (
						name: string,
						description: string,
						parameters: JsonSchema.JsonSchema,
						handle: (
							input: unknown,
						) => Effect.Effect<Schema.Json, Schema.SchemaError>,
					): Entry => ({
						tool: Tool.dynamic(name, {
							description,
							parameters,
							success: Schema.Json,
						}).annotate(Operation.Budget, "foreground") as Tools[string],
						handle: (input) =>
							handle(input).pipe(
								Effect.catchCause((cause) =>
									Effect.logWarning("An operation tool failed", cause).pipe(
										Effect.as(
											toolJson({
												error: "The tool could not finish. Try again.",
											}),
										),
									),
								),
							),
					})
					const entries = [
						entry(
							names.status,
							"Shows where a background operation of this Chat is, and its result when it has ended.",
							{
								type: "object",
								properties: { id: idSchema },
								required: ["id"],
							},
							(raw) =>
								Schema.decodeUnknownEffect(StatusInput)(raw).pipe(
									Effect.flatMap(({ id }) =>
										operations.get(chat, id).pipe(
											Effect.map(view),
											Effect.catchTag("OperationNotFound", (error) =>
												Effect.succeed(notFound(error.id)),
											),
										),
									),
								),
						),
						entry(
							names.wait,
							`Waits until one of the background operations ends, or until timeout_ms (at most ${maxWait}). It gives each operation as it is then.`,
							{
								type: "object",
								properties: {
									ids: { type: "array", items: idSchema, minItems: 1 },
									timeout_ms: { type: "integer", minimum: 0, maximum: maxWait },
								},
								required: ["ids"],
							},
							(raw) =>
								Schema.decodeUnknownEffect(WaitInput)(raw).pipe(
									Effect.flatMap(({ ids, timeout_ms }) =>
										operations.wait(chat, ids, timeout_ms ?? maxWait).pipe(
											Effect.map((records) =>
												toolJson({ operations: records.map(view) }),
											),
											Effect.catchTag("OperationNotFound", (error) =>
												Effect.succeed(notFound(error.id)),
											),
										),
									),
								),
						),
						entry(
							names.cancel,
							"Stops a background operation of this Chat.",
							{
								type: "object",
								properties: { id: idSchema },
								required: ["id"],
							},
							(raw) =>
								Schema.decodeUnknownEffect(StatusInput)(raw).pipe(
									Effect.flatMap(({ id }) =>
										operations.cancel(chat, id).pipe(
											Effect.map(view),
											Effect.catchTag("OperationNotFound", (error) =>
												Effect.succeed(notFound(error.id)),
											),
										),
									),
								),
						),
					]
					const own = Toolkit.make(...entries.map((each) => each.tool))
					const handlers = yield* own.toHandlers(
						Record.fromEntries(
							entries.map((each) => [each.tool.name, each.handle]),
						),
					)
					const all = yield* options.toolkit
					return next({
						...options,
						instructions: Prompt.concat(
							options.instructions,
							Prompt.make([{ role: "system", content: instructions }]),
						),
						toolkit: Effect.succeed(Toolkit.merge(all, own)),
					}).pipe(Stream.provideContext(handlers))
					// Without its Chat, a Turn cannot run, so it fails.
				}).pipe(Effect.orDie),
			),
		),
	)
