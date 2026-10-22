import {
	Agent,
	Item,
	Plugin,
	type Session,
	type SessionStore,
	type Turn,
} from "@openbot-build/core"
import { Todo } from "@openbot-build/api"
import {
	Context,
	Effect,
	type JsonSchema,
	Layer,
	Option,
	Record,
	Ref,
	Schema,
	Stream,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { Signal, publish } from "../../agents/Signals.ts"
import { Work } from "../../capabilities/Work.ts"
import * as SessionHost from "../../sessions/SessionHost.ts"
import * as Todos from "./Todos.ts"
import { Waits } from "./Waits.ts"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/work")

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
	todos: "openbot_todos",
	wait: "openbot_wait",
} as const

/**
 * Tools whose waiting calls OpenBot answers by itself, not with a request.
 * The coordinator leaves them alone.
 */
export const answersItself = (tool: string) => tool === names.wait

const TodosInput = Schema.Struct({ items: Schema.Array(Todo) })
const WaitInput = Schema.Struct({
	seconds: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
	until: Schema.optionalKey(Schema.String),
	reason: Schema.optionalKey(Schema.String),
})

/** When a wait ends, or why the input is not valid. */
const dueAt = (input: typeof WaitInput.Type, now: number): number | string => {
	if ((input.seconds === undefined) === (input.until === undefined))
		return "Give either seconds or until, not both."
	if (input.seconds !== undefined) return now + input.seconds * 1000
	const at = Date.parse(input.until!)
	if (Number.isNaN(at))
		return "until must be a date and time, such as 2026-10-23T09:00:00Z."
	return Math.max(at, now)
}

interface Entry {
	readonly tool: Tools[string]
	readonly handle: (input: unknown) => Effect.Effect<Schema.Json>
}

const text = { type: "string" } as const
const json = (value: unknown): Schema.Json =>
	JSON.parse(JSON.stringify(value)) as Schema.Json

const waitInstructions = `To wait for some time, call ${names.wait} with seconds, or with until and a date and time. Your Turn waits, and goes on when the time comes. To wait for several Agents at once, give them their tasks with several openbot_delegate calls in the same step.`

const todoInstructions = `Keep a todo list when work has more than one step. Call ${names.todos} with the whole list each time it changes: when you plan the steps, when you start a step, and when you finish one. Keep one item in_progress at a time. While an item is not done, you go on working. If an item is not needed any more, remove it and say why.`

/** The message that keeps a Turn going while items are open. */
export const reminder = (open: ReadonlyArray<Todo>) =>
	`OpenBot reminder: these todos are not done yet:\n${Todos.describe(open)}\nDo them now. If one is done, mark it done. If one is not needed, remove it and say why.`

/** What the Sessions of one member give to the work plugin. */
interface ForOwnerInput {
	readonly read: (
		session: Session.Id,
	) => Effect.Effect<
		Session.View<SessionHost.Values>,
		Session.SessionNotFound | SessionStore.SessionStoreError
	>
	readonly store: Pick<SessionStore.Store<SessionHost.Values>, "modifyEffect">
}

/**
 * Builds the work plugin for the Sessions of one member. It runs inside the Agent
 * plugin, so it sees every tool of the Turn.
 */
export class WorkPlugin extends Context.Service<
	WorkPlugin,
	{ readonly forOwner: (input: ForOwnerInput) => Plugin.Plugin<Tools> }
>()("@openbot-build/openbot/plugins/work/WorkPlugin") {}

export const make: Effect.Effect<typeof WorkPlugin.Service, never, Waits> =
	Effect.gen(function* () {
		const waits = yield* Waits
		const work = Effect.serviceOption(Work).pipe(
			Effect.flatMap(Effect.fromOption),
		)
		const entry = (
			name: string,
			description: string,
			parameters: JsonSchema.JsonSchema,
			handle: (input: unknown) => Effect.Effect<Schema.Json, unknown>,
			needsApproval?: (
				input: unknown,
				context: Tool.NeedsApprovalContext,
			) => Effect.Effect<boolean>,
		): Entry => ({
			tool: Tool.dynamic(name, {
				description,
				parameters,
				success: Schema.Json,
				...(needsApproval === undefined ? {} : { needsApproval }),
			}) as Tools[string],
			handle: (input) =>
				handle(input).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("A work tool failed", cause).pipe(
							Effect.as(
								json({ error: "The tool could not finish. Try another way." }),
							),
						),
					),
				),
		})
		const todosEntry = (input: ForOwnerInput) =>
			entry(
				names.todos,
				"Replace your todo list with this list. Send every item each time.",
				{
					type: "object",
					properties: {
						items: {
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
						},
					},
					required: ["items"],
				},
				(raw) =>
					Effect.gen(function* () {
						const request = yield* Schema.decodeUnknownEffect(TodosInput)(raw)
						const reason = Todos.problem(request.items)
						if (reason !== undefined) return json({ error: reason })
						const current = yield* work
						yield* Todos.replace({
							store: input.store,
							session: current.session,
							items: request.items,
						})
						const open = Todos.open({ items: request.items })
						return json({
							open: open.length,
							done: request.items.length - open.length,
						})
					}),
			)
		/**
		 * The call waits: `needsApproval` saves the wait and always pauses. The coordinator
		 * answers the call when the time comes. The handler runs only for a wrong input.
		 */
		const waitEntry = entry(
			names.wait,
			"Wait for some time, then go on. Give seconds, or until with a date and time.",
			{
				type: "object",
				properties: {
					seconds: { type: "number", exclusiveMinimum: 0 },
					until: { type: "string", format: "date-time" },
					reason: text,
				},
			},
			(raw) =>
				Effect.gen(function* () {
					const request = yield* Schema.decodeUnknownEffect(WaitInput)(raw)
					const now = yield* Effect.clockWith(
						(clock) => clock.currentTimeMillis,
					)
					const due = dueAt(request, now)
					return json({
						error:
							typeof due === "string"
								? due
								: "OpenBot could not save the wait.",
					})
				}),
			(raw, context) =>
				Effect.gen(function* () {
					const request = yield* Schema.decodeUnknownEffect(WaitInput)(raw)
					const now = yield* Effect.clockWith(
						(clock) => clock.currentTimeMillis,
					)
					const due = dueAt(request, now)
					if (typeof due === "string") return false
					const current = yield* work
					const wait = yield* waits.start(current.caller.organizationId, {
						userId: current.caller.userId,
						session: current.session,
						turn: current.turn,
						toolCallId: context.toolCallId,
						dueAt: due,
					})
					yield* publish(
						Signal.WaitStarted({
							organizationId: current.caller.organizationId,
							wait: wait.id,
						}),
					)
					return true
				}).pipe(
					// Without a saved wait, nothing would answer the call, so it must not pause.
					Effect.catchCause((cause) =>
						Effect.logWarning("A wait could not be saved", cause).pipe(
							Effect.as(false),
						),
					),
				),
		)
		/**
		 * Keeps the Turn going while todos are open. When a model step ends with no tool
		 * call, it adds a reminder as a steer message, so the runtime runs one more step.
		 * It reminds only once for each state of the list. When the Agent stops again
		 * without a change, the Turn ends, so a model that cannot go on does not loop.
		 */
		const keepGoing = <A extends Agent.Event<Tools>, E, R>(
			input: ForOwnerInput,
			turn: Turn.Id,
			stream: Stream.Stream<A, E, R>,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const called = yield* Ref.make(false)
					const reminded = yield* Ref.make(new Set<string>())
					const check = (session: Session.Id) =>
						Effect.gen(function* () {
							if (yield* Ref.get(called)) return
							const view = yield* input.read(session)
							const open = Todos.open(Todos.of(view))
							if (open.length === 0) return
							const key = JSON.stringify(Todos.of(view).items)
							const seen = yield* Ref.get(reminded)
							if (seen.has(key)) return
							yield* Ref.set(reminded, new Set([...seen, key]))
							yield* input.store.modifyEffect({
								session,
								update: (current) =>
									Effect.succeed([
										undefined,
										Option.some({
											session: {
												pending: [
													...current.session.pending,
													{
														id: Item.Id.make(crypto.randomUUID()),
														kind: "steer" as const,
														turn,
														content: Prompt.make([
															{ role: "user", content: reminder(open) },
														]),
													},
												],
											},
										}),
									] as const),
							})
						}).pipe(
							// The reminder is best effort. Without it, the Turn ends as usual.
							Effect.catchCause((cause) =>
								Effect.logWarning(
									"The todo reminder could not be saved",
									cause,
								),
							),
						)
					return stream.pipe(
						Stream.tap((event) => {
							if (event._tag === "ModelStepStarted")
								return Ref.set(called, false)
							if (event._tag !== "ResponsePart") return Effect.void
							if (event.part.type === "tool-call") return Ref.set(called, true)
							if (event.part.type === "finish" && event.part.reason === "stop")
								return check(event.at.session)
							return Effect.void
						}),
					)
				}),
			)
		return WorkPlugin.of({
			forOwner: (input) =>
				Plugin.make({ id: pluginId })<Tools>(() =>
					Effect.succeed((next, options) =>
						Stream.unwrap(
							Effect.gen(function* () {
								const context = yield* Agent.Context
								const at = yield* context.at
								const turn = yield* context.turn
								const view = yield* input.read(at.session)
								const state = SessionHost.hostState(view.session)
								// A review decides one request, so it gets no work tools.
								if (state.kind === "review") return next(options)
								const entries = [todosEntry(input), waitEntry]
								const incoming = yield* options.toolkit
								const own = Toolkit.make(...entries.map((entry) => entry.tool))
								const handlers = yield* own.toHandlers(
									Record.fromEntries(
										entries.map((entry) => [entry.tool.name, entry.handle]),
									),
								)
								const open = Todos.open(Todos.of(view))
								const instructions = Prompt.concat(
									options.instructions,
									Prompt.make([
										{
											role: "system",
											content: [
												todoInstructions,
												waitInstructions,
												...(open.length === 0
													? []
													: [
															`Your todo list now:\n${Todos.describe(Todos.of(view).items)}`,
														]),
											].join("\n\n"),
										},
									]),
								)
								return keepGoing(
									input,
									turn,
									next({
										...options,
										instructions,
										toolkit: Effect.succeed(Toolkit.merge(incoming, own)),
									}).pipe(Stream.provideContext(handlers)),
								)
								// Without its Session, a Turn cannot run, so it fails.
							}).pipe(Effect.orDie),
						),
					),
				),
		})
	})
export const layer = Layer.effect(WorkPlugin, make)
