import { type Chat, type ChatStore, Bot, Operation } from "@openbot-build/core"
import { Caller, Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import * as Db from "../database/Database.ts"
import { Records, category } from "../errors/Records.ts"
import { CallContext } from "../execution/CallContext.ts"
import { Calls } from "../execution/Calls.ts"
import { Observation } from "../execution/Observation.ts"
import * as Recovery from "../execution/Recovery.ts"
import { Store, storage, type Fence } from "../execution/Store.ts"
import * as ToolEntry from "../plugins/ToolEntry.ts"
import * as StoredChats from "./StoredChats.ts"
import { ToolCommands } from "./ToolCommands.ts"
import * as ToolResults from "./ToolResults.ts"
import { outputCodec } from "./ToolSteps.ts"

export const names = {
	status: "openbot_execution_status",
	wait: "openbot_execution_wait",
	cancel: "openbot_execution_cancel",
} as const
export const maxWait = 30_000
const One = Schema.Struct({ executionId: Execution.Id })
const Many = Schema.Struct({
	executionIds: Schema.Array(Execution.Id).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(20),
	),
	timeoutMs: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxWait })),
	),
})
const sameCaller = Schema.toEquivalence(Caller)

export interface Service {
	readonly register: (parent: Fence) => Effect.Effect<
		{
			tools: {
				readonly openbot_execution_cancel: Tool.Tool<
					"openbot_execution_cancel",
					{
						readonly parameters: Schema.Unknown
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
				readonly openbot_execution_status: Tool.Tool<
					"openbot_execution_status",
					{
						readonly parameters: Schema.Unknown
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					never
				>
				readonly openbot_execution_wait: Tool.Tool<
					"openbot_execution_wait",
					{
						readonly parameters: Schema.Unknown
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					never
				>
			}
			handlers: Context.Context<
				Tool.HandlersFor<{
					readonly openbot_execution_cancel: Tool.Tool<
						"openbot_execution_cancel",
						{
							readonly parameters: Schema.Unknown
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
					readonly openbot_execution_status: Tool.Tool<
						"openbot_execution_status",
						{
							readonly parameters: Schema.Unknown
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						never
					>
					readonly openbot_execution_wait: Tool.Tool<
						"openbot_execution_wait",
						{
							readonly parameters: Schema.Unknown
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						never
					>
				}>
			>
			instructions: Prompt.Prompt
		},
		Chat.ChatNotFound | ChatStore.ChatStoreError,
		Bot.Context
	>
}

export class ToolControls extends Context.Service<ToolControls, Service>()(
	"@openbot-build/openbot/chats/ToolControls",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const calls = yield* Calls
	const tools = yield* ToolCommands
	const observation = yield* Observation
	const errors = yield* Records
	const recovery = yield* Recovery.Recovery
	const register = (parent: Fence) =>
		Effect.gen(function* () {
			const context = yield* Bot.Context
			const chat = (yield* context.at).chat
			const current = (mode: "advance" | "replay" = "advance") =>
				Effect.gen(function* () {
					yield* calls.authorize(parent, mode)
					const saved = yield* store.loadMember(parent)
					if (
						saved.generation !== parent.generation ||
						Execution.isTerminal(saved.record.status)
					)
						return yield* Execution.Conflict.make({ id: parent.id })
					return saved.identity.actor
				})
			const load = (
				id: Execution.Id,
				access: "read" | "cancel" = "read",
				mode: "advance" | "replay" = "advance",
			) =>
				Effect.gen(function* () {
					const actor = yield* current(mode)
					const key = { namespace: parent.namespace, id }
					const saved = yield* tools.load(key)
					if (saved.record.position.chat !== chat)
						return yield* Execution.NotFound.make({ id })
					// A Channel speaker can control their own work without owning the Channel's Chat.
					yield* tools.authorize(
						key,
						actor,
						sameCaller(actor, saved.identity.actor) ? "replay" : access,
					)
					return saved
				})
			const view = (id: Execution.Id) =>
				Effect.gen(function* () {
					const saved = yield* load(id)
					const record = saved.record
					const output = Execution.isTerminal(record.status)
						? yield* ToolResults.output(
								{
									...record,
									detached: false,
									calls: yield* store.calls({
										namespace: parent.namespace,
										id,
									}),
								},
								saved.input.call,
							)
						: undefined
					return yield* Schema.decodeEffect(Schema.Json)({
						executionId: id,
						toolExecutionId: record.id,
						tool: record.tool,
						status: record.status,
						failure: record.failure,
						...(output === undefined
							? {}
							: { output: yield* Schema.encodeEffect(outputCodec)(output) }),
					})
				})
			const handlers = {
				[names.status]: (raw: unknown) =>
					Schema.decodeUnknownEffect(One)(raw).pipe(
						Effect.flatMap(({ executionId }) => view(executionId)),
					),
				[names.wait]: (raw: unknown) =>
					Effect.gen(function* () {
						const { executionIds, timeoutMs = maxWait } =
							yield* Schema.decodeUnknownEffect(Many)(raw)
						const saved = yield* Effect.forEach(executionIds, (id) => load(id))
						if (
							timeoutMs > 0 &&
							!Arr.some(saved, ({ record }) =>
								Execution.isTerminal(record.status),
							)
						) {
							yield* Effect.raceAll(
								Arr.map(executionIds, (id) =>
									observation
										.observe({ namespace: parent.namespace, id }, 0)
										.pipe(
											Stream.runForEach(() => load(id).pipe(Effect.asVoid)),
										),
								),
							).pipe(Effect.timeoutOption(timeoutMs))
						}
						return { executions: yield* Effect.forEach(executionIds, view) }
					}),
				[names.cancel]: (raw: unknown) =>
					Effect.gen(function* () {
						const { executionId } = yield* Schema.decodeUnknownEffect(One)(raw)
						const saved = yield* load(executionId, "cancel")
						if (Execution.isTerminal(saved.record.status))
							return { executionId, accepted: true }
						const call = yield* CallContext
						if (
							call.fence.id !== parent.id ||
							call.fence.namespace !== parent.namespace ||
							call.fence.generation !== parent.generation
						)
							return yield* Execution.Conflict.make({ id: parent.id })
						yield* store.cancel(
							{ namespace: parent.namespace, id: executionId },
							Execution.CommandKey.make(`tool-cancel:${call.id}`),
							yield* current(),
							Effect.gen(function* () {
								yield* StoredChats.lock(db, parent.namespace, chat).pipe(
									storage,
								)
								yield* store.lock(parent)
								yield* load(executionId, "cancel")
							}),
						)
						return { executionId, accepted: true }
					}),
			}
			const recovered = (id: Execution.CallId, raw: unknown) =>
				Effect.gen(function* () {
					const { executionId } = yield* Schema.decodeUnknownEffect(One)(raw)
					const target = yield* load(executionId, "read", "replay")
					const actor = yield* current("replay")
					const receipt = yield* store.receipt(
						parent.namespace,
						Execution.CommandKey.make(`tool-cancel:${id}`),
						{
							actor,
							body: { kind: "cancel", executionId, actor },
						},
					)
					return Option.isSome(receipt) ||
						Execution.isTerminal(target.record.status)
						? Option.some({ executionId, accepted: true })
						: Option.none()
				}).pipe(
					(work) => recovery.storage(parent.id, work),
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: errors
									.record(cause, category(cause), parent.id)
									.pipe(Effect.orDie, Effect.flatMap(Effect.fail)),
					),
				)
			const own = Toolkit.make(
				...Arr.map(
					[
						Tool.dynamic(names.status, {
							description:
								"Read a tool execution of this Chat and its saved result.",
							parameters: Schema.toJsonSchemaDocument(One).schema,
							success: Schema.Json,
						}).annotate(Tool.Readonly, true),
						Tool.dynamic(names.wait, {
							description:
								"Wait for one tool execution to end. Closing the wait does not cancel work.",
							parameters: Schema.toJsonSchemaDocument(Many).schema,
							success: Schema.Json,
						}).annotate(Tool.Readonly, true),
						Tool.dynamic(names.cancel, {
							description:
								"Ask a tool execution to stop. A cancelling execution has not yet stopped.",
							parameters: Schema.toJsonSchemaDocument(One).schema,
							success: Schema.Json,
						})
							.annotate(ToolEntry.Idempotent, true)
							.annotate(ToolEntry.SavedResult, recovered)
							.addDependency(CallContext),
					],
					(tool) =>
						tool
							.annotate(Operation.Budget, "foreground")
							.annotate(ToolEntry.ReviewAllowed, true),
				),
			)
			const safe =
				<E, R>(handle: (raw: unknown) => Effect.Effect<Schema.Json, E, R>) =>
				(raw: unknown) =>
					recovery.storage(parent.id, handle(raw)).pipe(
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.failCause(
										Cause.fromReasons<never>(
											Arr.filter(cause.reasons, Cause.isInterruptReason),
										),
									)
								: errors.record(cause, category(cause), parent.id).pipe(
										Effect.map((failure) => ({ failure })),
										Effect.orDie,
									),
						),
					)
			const bound = yield* own.toHandlers({
				[names.status]: safe(handlers[names.status]),
				[names.wait]: safe(handlers[names.wait]),
				[names.cancel]: safe(handlers[names.cancel]),
			})
			return {
				tools: own.tools,
				handlers: bound,
				instructions: Prompt.make(
					`A long tool call can return an executionId and run in the background. Its result returns to this Chat. Use ${names.status} to read it, ${names.wait} when the next step needs it, or ${names.cancel} to ask it to stop. Cancellation is complete only when the saved status says so.`,
				),
			}
		})
	return ToolControls.of({ register })
})

export const layer = Layer.effect(ToolControls, make).pipe(
	Layer.provide(Recovery.layer),
)
