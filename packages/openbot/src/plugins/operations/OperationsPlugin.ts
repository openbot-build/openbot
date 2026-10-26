import { Bot, Operation, type Operations, Plugin } from "@openbot-build/core"
import {
	Array as Arr,
	DateTime,
	Effect,
	type JsonSchema,
	Record as Rec,
	Schema,
	Stream,
} from "effect"
import { Prompt, Toolkit } from "effect/ai"
import * as ToolEntry from "../ToolEntry.ts"
import { toolJson } from "../ToolJson.ts"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/operations")

/** The tools of this plugin. Their parameters are JSON Schema, like App tools. */
export type Tools = ToolEntry.Tools

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

const view = (record: Operation.Record) =>
	toolJson({
		operation: record.id,
		tool: record.tool,
		status: record.status,
		startedAt: DateTime.formatIso(DateTime.makeUnsafe(record.startedAt)),
		...(record.endedAt === undefined
			? {}
			: { endedAt: DateTime.formatIso(DateTime.makeUnsafe(record.endedAt)) }),
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
					) =>
						ToolEntry.entry(name, description, parameters, handle, {
							log: "An operation tool failed",
							failure: "The tool could not finish. Try again.",
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
												toolJson({ operations: Arr.map(records, view) }),
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
					const own = Toolkit.make(...Arr.map(entries, (each) => each.tool))
					const handlers = yield* own.toHandlers(
						Rec.fromEntries(
							Arr.map(entries, (each) => [each.tool.name, each.handle]),
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
