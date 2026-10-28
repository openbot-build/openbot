import { Records } from "../../errors/Records.ts"
import {
	Bot,
	type Chat,
	type ChatStore,
	Item,
	type Plugin,
	type Turn,
} from "@openbot-build/core"
import { Todo } from "@openbot-build/domain"

import {
	Array as Arr,
	Cause,
	Context,
	Crypto,
	DateTime,
	Effect,
	type JsonSchema,
	Option,
	Record as Rec,
	Schema,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import * as Background from "../../execution/Background.ts"
import { Answer, Gate } from "../../capabilities/Gate.ts"
import { Work } from "../../capabilities/Work.ts"
import { Settings } from "../../settings/Settings.ts"
import * as ChatHost from "../../chats/ChatHost.ts"
import { OpenWork } from "../../chats/OpenWork.ts"
import * as Plans from "./Plans.ts"
import * as Todos from "./Todos.ts"
import { ReminderCommands } from "./ReminderCommands.ts"
import type { Fence } from "../../execution/Store.ts"
import * as ToolEntry from "../ToolEntry.ts"
import { toolJson } from "../ToolJson.ts"

/** The work control tools. Their parameters are JSON Schema, like App tools. */
export type Tools = ToolEntry.Tools

export const names = {
	todos: "openbot_todos",
	remind: "openbot_remind",
	submitPlan: "openbot_submit_plan",
} as const

const TodosInput = Schema.Struct({ items: Schema.Array(Todo) })
const PlanInput = Schema.Struct({
	items: Schema.Array(Todo).check(Schema.isMinLength(1)),
	summary: Schema.String,
})
const RemindInput = Schema.Struct({
	seconds: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
	until: Schema.optionalKey(Schema.String),
	note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
})
const sameTodos = Schema.toEquivalence(Schema.Array(Todo))

/** When a reminder comes, or why the input is not valid. */
const dueAt = (
	input: typeof RemindInput.Type,
	now: number,
): number | string => {
	if ((input.seconds === undefined) === (input.until === undefined))
		return "Give either seconds or until, not both."
	if (input.seconds !== undefined) {
		const at = now + input.seconds * 1000
		// A time past the range of a date cannot be shown, so it is not kept.
		return Option.isNone(DateTime.make(at)) ? "seconds is too large." : at
	}
	const at = Date.parse(input.until!)
	if (Number.isNaN(at))
		return "until must be a date and time, such as 2026-10-23T09:00:00Z."
	return Math.max(at, now)
}

type CallContext = ToolEntry.CallContext

const text = { type: "string" } as const
const json = toolJson

const remindInstructions = `To come back to something later, call ${names.remind} with seconds, or with until and a date and time, and a note. Your Turn does not wait. At that time, OpenBot sends you the note as a message.`

const todoInstructions = `Keep a todo list when work has more than one step. Call ${names.todos} with the whole list each time it changes: when you plan the steps, when you start a step, and when you finish one. Keep one item in_progress at a time. While an item is not done, you go on working. If an item is not needed any more, remove it and say why. When every item is done, the list becomes empty at the end of your answer.`

const planInstructions = `You are in plan mode. Look things up with your tools, but do not change anything yet. Only the tools that just read are open to you now. Write the steps of the work as a todo list. When the plan is ready, call ${names.submitPlan} with the list and a short summary, and then end your answer. When the plan is approved, a new Turn starts in build mode with all your tools. If it is not approved, you get the reason and stay in plan mode.`

/** The message that starts the work after a plan is approved. */
export const approved =
	"[OpenBot] Your plan is approved. Carry it out now, and keep the todo list up to date."

/** The message that keeps a Turn going while items are open. */
export const reminder = (open: ReadonlyArray<Todo>) =>
	`[OpenBot] These todos are not done yet:\n${Todos.describe(open)}\nDo them now. If one is done, mark it done. If one is not needed, remove it and say why.`

/** The Chat data used by the work control tools. */
interface ForOwnerInput {
	readonly read: (
		chat: Chat.Id,
	) => Effect.Effect<
		Chat.View<ChatHost.Values>,
		Chat.ChatNotFound | ChatStore.ChatStoreError
	>
	readonly store: Pick<ChatStore.Store<ChatHost.Values>, "modifyEffect">
}

/**
 * Registers work control tools and a hook for saved step results.
 * The host checks the mode of the Turn after all tools are registered.
 */
export class WorkTools extends Context.Service<
	WorkTools,
	{
		readonly register: (
			input: ForOwnerInput,
		) => Effect.Effect<Bot.ToolRegistration, never, Bot.Context | Work>
	}
>()("@openbot-build/openbot/plugins/work/WorkTools") {}

/** Input for the next Turn. It never steers the running Turn. */
const nextTurn = (
	id: Item.Id,
	content: string,
	author: Turn.Author | undefined,
	notice: Item.Notice,
): Chat.InboxEntry => ({
	id,
	kind: "message",
	content: Prompt.make([{ role: "user", content }]),
	notice,
	...(author === undefined ? {} : { author }),
})

export const durable = (fence: Fence) =>
	Effect.gen(function* () {
		const background = yield* Background.make
		const records = yield* Records
		const commands = yield* ReminderCommands
		const gate = yield* Gate
		const settings = yield* Settings
		const openWork = yield* OpenWork
		const crypto = yield* Crypto.Crypto
		const newId = crypto.randomUUIDv4().pipe(Effect.orDie)
		const newItemId = Effect.map(newId, (id) => Item.Id.make(id))
		/** The ID of a tool call, or a new one when the call has none. */
		const callIdOf = (context: CallContext) =>
			context.toolCallId === undefined
				? newId
				: Effect.succeed(context.toolCallId)
		return WorkTools.of({
			register: (input) =>
				Effect.gen(function* () {
					const current = yield* Work
					const work = Effect.succeed(current)
					// Work tools change the state of their Turn, so they never go to the background.
					const entry = <E>(
						name: string,
						description: string,
						parameters: JsonSchema.JsonSchema,
						handle: (
							input: unknown,
							context: CallContext,
						) => Effect.Effect<Schema.Json, E>,
						needsApproval?: (
							input: unknown,
							context: Tool.NeedsApprovalContext,
						) => Effect.Effect<boolean>,
					) =>
						ToolEntry.entry(name, description, parameters, handle, {
							records,
							executionId: fence.id,
							...(needsApproval === undefined ? {} : { needsApproval }),
						})
					const todoList = {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: text,
								content: text,
								status: {
									type: "string",
									enum: ["pending", "in_progress", "done"],
								},
							},
							required: ["id", "content", "status"],
						},
					} as const
					const todosEntry = (input: ForOwnerInput) =>
						entry(
							names.todos,
							"Replace your todo list with this list. Send every item each time.",
							{
								type: "object",
								properties: { items: todoList },
								required: ["items"],
							},
							(raw) =>
								Effect.gen(function* () {
									const request =
										yield* Schema.decodeUnknownEffect(TodosInput)(raw)
									const reason = Todos.problem(request.items)
									if (reason !== undefined) return json({ error: reason })
									const current = yield* work
									yield* Todos.replace({
										store: input.store,
										chat: current.chat,
										items: request.items,
									})
									const open = Todos.open({ items: request.items })
									return json({
										open: open.length,
										done: request.items.length - open.length,
									})
								}),
						)
					const remindEntry = entry(
						names.remind,
						"Get a message from OpenBot later. Give seconds, or until with a date and time, and the note that you want to read then. Your Turn does not wait.",
						{
							type: "object",
							properties: {
								seconds: { type: "number", exclusiveMinimum: 0 },
								until: { type: "string", format: "date-time" },
								note: text,
							},
							required: ["note"],
						},
						(raw, context) =>
							Effect.gen(function* () {
								const request =
									yield* Schema.decodeUnknownEffect(RemindInput)(raw)
								const now = yield* Effect.clockWith(
									(clock) => clock.currentTimeMillis,
								)
								const due = dueAt(request, now)
								if (typeof due === "string") return json({ error: due })
								const toolCallId = yield* callIdOf(context)
								const saved = yield* commands.start(
									fence,
									toolCallId,
									request.note,
									due,
								)
								return json({
									reminder: saved.id,
									...(saved.executionId === undefined
										? {}
										: { executionId: saved.executionId }),
									at: DateTime.formatIso(DateTime.makeUnsafe(saved.dueAt)),
								})
							}),
					)
					/**
					 * Asks to carry out a plan. `needsApproval` saves the list as the todo list and
					 * asks for approval, as the approval settings say. The handler runs only when the
					 * plan is allowed at once: the Chat moves to build mode, and a new Turn with every
					 * tool starts after this one. A plan that waits for a decider gets its answer as
					 * a message later.
					 */
					const submitPlanEntry = (input: ForOwnerInput) =>
						entry(
							names.submitPlan,
							"Ask to carry out your plan. Give the steps as a todo list and a short summary.",
							{
								type: "object",
								properties: { items: todoList, summary: text },
								required: ["items", "summary"],
							},
							(raw) =>
								Effect.gen(function* () {
									const request =
										yield* Schema.decodeUnknownEffect(PlanInput)(raw)
									const reason = Todos.problem(request.items)
									if (reason !== undefined) return json({ error: reason })
									const current = yield* work
									const view = yield* input.read(current.chat)
									// The approval is for this list. A changed list needs a new approval.
									if (!sameTodos(Todos.of(view).items, request.items))
										return json({
											error:
												"The todo list changed after you asked. Read it, and submit the plan again.",
										})
									const id = yield* newItemId
									yield* input.store.modifyEffect({
										chat: current.chat,
										update: (now) =>
											Effect.succeed([
												undefined,
												Option.some({
													chat: {
														settings: {
															...now.chat.settings,
															mode: "build" as const,
														},
														// The build Turn works for the same person as the plan Turn.
														inbox: [
															...now.chat.inbox,
															nextTurn(
																id,
																approved,
																now.chat.turn?.id === current.turn
																	? now.chat.turn.author
																	: undefined,
																{ kind: "plan" },
															),
														],
													},
												}),
											] as const),
									})
									return json({
										approved: true,
										note: "End your answer now. A new Turn in build mode starts right after it.",
									})
								}),
							(raw, context) =>
								Effect.gen(function* () {
									const decoded = yield* Schema.decodeUnknownEffect(PlanInput)(
										raw,
									).pipe(Effect.option)
									// A wrong list does not ask. The handler tells the Bot why.
									if (
										Option.isNone(decoded) ||
										Todos.problem(decoded.value.items) !== undefined
									)
										return false
									const request = decoded.value
									const current = yield* work
									yield* Todos.replace({
										store: input.store,
										chat: current.chat,
										items: request.items,
									})
									const view = yield* input.read(current.chat)
									const approval = yield* Plans.approvalFor({
										settings,
										state: ChatHost.hostState(view.chat),
										chain: current.chain,
										bot: current.bot,
									})
									const answer = yield* gate.check({
										capability: { action: "plans.run", target: current.chat },
										reason: request.summary,
										site: { main: context.toolCallId, path: [] },
										ask: {
											person: approval.approver === "person",
											timeoutMs: approval.timeoutMs,
											onExpire: approval.onTimeout === "run" ? "allow" : "deny",
										},
									})
									return answer._tag !== "Allow"
								}).pipe(
									// When the check fails, the Turn keeps a Deny, so the plan never runs
									// without a decision. A plain tools.call check must not decide it.
									Effect.catchCause((cause) =>
										Cause.hasInterruptsOnly(cause)
											? Effect.interrupt
											: Effect.logWarning(
													"A plan could not be submitted",
													cause,
												).pipe(
													Effect.andThen(
														gate.remember(
															context.toolCallId,
															Answer.Deny({
																reason: "OpenBot could not check this plan.",
															}),
														),
													),
													Effect.as(true),
												),
									),
								),
						)
					/** The mode of the current Turn. A Turn copies the Chat mode when it starts. */
					const modeOf = (view: Chat.View<ChatHost.Values>, turn: Turn.Id) =>
						(view.chat.turn?.id === turn
							? view.chat.turn.settings
							: view.chat.settings
						).mode
					/** The runner calls this on saved results, including results read after a restart. */
					const afterStep =
						(input: ForOwnerInput) => (step: Plugin.StepResult) =>
							Effect.gen(function* () {
								if (
									step.kind !== "model" ||
									step.finishReason !== "stop" ||
									Arr.some(
										step.output.content,
										(message) =>
											message.role === "assistant" &&
											Arr.some(
												message.content,
												(part) => part.type === "tool-call",
											),
									)
								)
									return
								const view = yield* input.read(step.chat)
								const todos = Todos.of(view)
								const allowReminder = Todos.cleared(todos) === undefined
								if (allowReminder) {
									if (Todos.open(todos).length === 0) return
									const organizationId = ChatHost.hostState(view.chat).chain
										.organizationId
									// A count that fails is not an empty set of work.
									const waiting = yield* openWork.count(
										organizationId,
										step.chat,
									)
									if (
										waiting.delegations + waiting.requests + waiting.reminders >
										0
									)
										return
								}
								yield* Todos.continueTurn({
									store: input.store,
									chat: step.chat,
									turn: step.turn.id,
									item: yield* newItemId,
									allowReminder,
									message: reminder,
								})
							}).pipe(
								background.logFailure("The todo reminder could not be saved"),
							)
					const context = yield* Bot.Context
					const at = yield* context.at
					const turn = yield* context.turn
					const view = yield* input.read(at.chat)
					const state = ChatHost.hostState(view.chat)
					// A review decides one request, so it gets no work tools.
					if (state.kind === "review")
						return { tools: {}, handlers: Context.empty() }
					const planning = modeOf(view, turn) === "plan"
					const entries = planning
						? [todosEntry(input), remindEntry, submitPlanEntry(input)]
						: [todosEntry(input), remindEntry]
					const own = Toolkit.make(
						...Arr.map(entries, (entry) =>
							entry.tool
								.annotate(ToolEntry.PlanAllowed, true)
								.annotate(ToolEntry.Local, entry.tool.name === names.remind),
						),
					)
					const handlers = yield* own.toHandlers(
						Rec.fromEntries(
							Arr.map(entries, (entry) => [entry.tool.name, entry.handle]),
						),
					)
					const open = Todos.open(Todos.of(view))
					const instructions = Prompt.concat(
						Prompt.empty,
						Prompt.make([
							{
								role: "system",
								content: Arr.join(
									[
										...(planning ? [planInstructions] : []),
										todoInstructions,
										remindInstructions,
										...(open.length === 0
											? []
											: [
													`Your todo list now:\n${Todos.describe(Todos.of(view).items)}`,
												]),
									],
									"\n\n",
								),
							},
						]),
					)
					return {
						tools: own.tools,
						handlers,
						instructions,
						...(planning ? {} : { afterStep: afterStep(input) }),
					}
				}).pipe(Effect.orDie),
		})
	})
