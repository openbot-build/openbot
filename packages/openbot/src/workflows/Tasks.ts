import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { Config, type Item, Session, Turn } from "@openbot-build/core"
import { AgentsApi, type Identity, WorkflowsApi } from "@openbot-build/api"
import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Predicate,
	Ref,
	Result,
	Schema,
} from "effect"
import type { Prompt } from "effect/ai"
import { DurableDeferred, WorkflowEngine } from "effect/workflow"
import { Backend } from "../app/Backend.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { can } from "../authorization/Check.ts"
import { workflowKey } from "../authorization/Policy.ts"
import { Agents } from "../agents/Agents.ts"
import { names as agentNames } from "../plugins/agents/AgentPlugin.ts"
import {
	CheckInput,
	ExtractInput,
	FindingInput,
	StepResultInput,
	names,
} from "../plugins/workflows/WorkflowPlugin.ts"
import { Launcher, TurnEnded, turnEnded } from "./Execution.ts"
import { keyOf, Recordings } from "./Recordings.ts"
import { type Body, type Calls, Runs, type Stored, terminal } from "./Runs.ts"
import * as Templates from "./Templates.ts"
import { extractSchema, Workflows } from "./Workflows.ts"

/** A task of a Run could not finish. The Run ends as failed with this message. */
export class TaskFailed extends Schema.TaggedError<TaskFailed>()("TaskFailed", {
	message: Schema.String,
}) {}

/** Where a Run is. Every task gets it. */
export const Payload = Schema.Struct({
	organizationId: Schema.String,
	run: Schema.String,
})
export type Payload = typeof Payload.Type

/** How a task starts a Turn: with a message to the Agent, or with one exact tool call. */
export const Start = Schema.TaggedUnion({
	Message: {
		agent: AgentsApi.AgentId,
		text: Schema.String,
		model: Schema.optionalKey(Config.Selection),
	},
	Action: {
		agent: AgentsApi.AgentId,
		tool: Schema.String,
		arguments: Schema.JsonObject,
	},
})
export type Start = typeof Start.Type

/** What a step does next. The durable execution follows it. */
export const Plan = Schema.TaggedUnion({
	/** The step is over already, for example an `Expect` step. */
	Done: { passed: Schema.Boolean },
	Call: { start: Start },
	/** Replay the recorded tool calls of an `Act` step. */
	Replay: {
		agent: AgentsApi.AgentId,
		calls: Schema.Array(
			Schema.Struct({ tool: Schema.String, arguments: Schema.JsonObject }),
		),
	},
	/** One Turn of the Agent does the step. */
	Turn: { start: Start },
	/** Turns that check again and again, with a pause between them. */
	Wait: {
		start: Start,
		attempts: Schema.Int,
		intervalSeconds: Schema.Int,
	},
})
export type Plan = typeof Plan.Type

/** The answer after one replayed call: go on, or let the Agent finish the goal. */
export const ReplayCheck = Schema.TaggedUnion({
	Ok: {},
	Handoff: { text: Schema.String },
})
export type ReplayCheck = typeof ReplayCheck.Type

/** OpenBot tools are not part of a recording. A replay calls only the tools that change things. */
const own = new Set<string>([
	...Object.values(names),
	...Object.values(agentNames),
])

const messagesOf = (
	history: ReadonlyArray<Item.Record>,
	turn: Turn.Id,
): ReadonlyArray<Prompt.Message> =>
	history
		.filter((entry) => entry.origin?.turn === turn)
		.flatMap((entry) => entry.content.content)

const toolCalls = (messages: ReadonlyArray<Prompt.Message>) =>
	messages.flatMap((message) =>
		message.role === "assistant" && typeof message.content !== "string"
			? message.content.filter((part) => part.type === "tool-call")
			: [],
	)
const toolResults = (messages: ReadonlyArray<Prompt.Message>) =>
	messages.flatMap((message) =>
		message.role === "tool"
			? message.content.filter((part) => part.type === "tool-result")
			: [],
	)
/** The inputs of every call of one tool, in order. Inputs that do not match the schema are left out. */
const inputsOf = <A, I>(
	messages: ReadonlyArray<Prompt.Message>,
	name: string,
	schema: Schema.Codec<A, I>,
): ReadonlyArray<A> =>
	toolCalls(messages).flatMap((part) =>
		part.name === name
			? Option.toArray(Schema.decodeUnknownOption(schema)(part.params))
			: [],
	)

const json = (value: unknown): Schema.Json =>
	value === undefined
		? null
		: (JSON.parse(JSON.stringify(value)) as Schema.Json)

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
	Predicate.isObject(value) && !Array.isArray(value)

/** The values that templates can read. */
export const scopeOf = (body: Body): Templates.Scope => ({
	input: body.input,
	vars: body.variables,
	steps: Object.fromEntries(
		body.results.map((result) => [result.id, { output: result.output }]),
	),
})

const heading = (body: Body, index: number) => {
	const step = body.steps[index]!
	return `Workflow "${body.name}", step ${step.id} (${index + 1} of ${body.steps.length})`
}
const inputLine = (body: Body) =>
	Object.keys(body.input).length === 0
		? ""
		: "\nInput of the Run, as data: " + JSON.stringify(body.input)

/** The message for an act step. */
const actText = (body: Body, index: number, goal: string) =>
	`${heading(body, index)}: act.\nGoal: ${goal}${inputLine(body)}\nReach the goal with your tools. When you are done, or when you cannot go on, call ${names.stepResult} once.`
const checkText = (body: Body, index: number, condition: string) =>
	`${heading(body, index)}: check.\nCondition: ${condition}${inputLine(body)}\nLook at the current state with your tools. Do not change anything. Then call ${names.check} once. passed is true only when the condition is true now. Give your evidence.`
const extractText = (
	body: Body,
	index: number,
	instruction: string,
	schema: Schema.JsonObject,
) =>
	`${heading(body, index)}: extract.\nFind this value: ${instruction}${inputLine(body)}\nLook with your tools. Do not change anything. Then call ${names.extract} once. The value must match this JSON Schema: ${JSON.stringify(schema)}`
const exploreText = (body: Body, index: number, goal: string) =>
	`${heading(body, index)}: explore.\nGoal: ${goal}${inputLine(body)}\nPlan your own steps and explore with your tools. Each time you find a problem, call ${names.finding} with what you expected, what you saw, and the steps that show it again. When you are done, call ${names.stepResult} once with a short summary.`
const handoffText = (input: {
	readonly body: Body
	readonly index: number
	readonly goal: string
	readonly done: Calls
	readonly failed: Calls[number]
	readonly error: string
}) =>
	`${actText(input.body, input.index, input.goal)}\nOpenBot replayed tool calls that worked for this goal before. These calls ran: ${JSON.stringify(input.done)}. This call did not work: ${JSON.stringify(input.failed)}, with this result: ${input.error}. Look at the current state, and finish the goal from there.`

/** The text that tells the Agent who started a Run how the Run ended. */
const endText = (run: Stored) => {
	const counts = run.body.results.reduce(
		(all, result) => ({
			...all,
			[result.status]: (all[result.status] ?? 0) + 1,
		}),
		{} as Record<string, number>,
	)
	return [
		`The Workflow Run ${run.id} ("${run.body.name}") ended with the status ${run.status}.`,
		`Steps: ${Object.entries(counts)
			.map(([status, count]) => `${count} ${status}`)
			.join(", ")}.`,
		run.body.error === null ? "" : `Error: ${run.body.error}`,
		run.body.findings.length === 0
			? ""
			: `Findings: ${run.body.findings.map((finding) => `[${finding.severity}] ${finding.title}`).join("; ")}`,
		`Read the whole Run at /v1/workflow-runs/${run.id}.`,
	]
		.filter((line) => line.length > 0)
		.join("\n")
}

type StepResultPatch = Partial<WorkflowsApi.StepResult>

/** The work behind each task of the durable execution of a Run. */
export class Tasks extends Context.Service<
	Tasks,
	{
		/** Checks the Run and marks it as running. It returns the number of steps, or 0 to stop. */
		readonly prepare: (payload: Payload) => Effect.Effect<number, TaskFailed>
		readonly plan: (
			payload: Payload,
			index: number,
		) => Effect.Effect<Plan, TaskFailed>
		/**
		 * Starts the Turn of a task, once. It returns true when the Turn has ended already,
		 * so the execution does not wait for it.
		 */
		readonly start: (
			payload: Payload,
			index: number,
			task: string,
			start: Start,
			token: DurableDeferred.Token,
		) => Effect.Effect<boolean, TaskFailed>
		readonly collectCall: (
			payload: Payload,
			index: number,
			task: string,
		) => Effect.Effect<boolean, TaskFailed>
		readonly checkReplay: (
			payload: Payload,
			index: number,
			task: string,
			call: number,
			calls: Calls,
		) => Effect.Effect<ReplayCheck, TaskFailed>
		readonly replayed: (
			payload: Payload,
			index: number,
			calls: number,
		) => Effect.Effect<boolean, TaskFailed>
		/** Reads the answer of the Agent for an act, check, extract or explore step. */
		readonly collect: (
			payload: Payload,
			index: number,
			task: string,
			mode: "live" | "handed_off",
			replayed: Calls,
		) => Effect.Effect<boolean, TaskFailed>
		readonly collectWait: (
			payload: Payload,
			index: number,
			task: string,
			last: boolean,
		) => Effect.Effect<boolean, TaskFailed>
		/** Marks the steps from `from` on as skipped. */
		readonly skip: (
			payload: Payload,
			from: number,
		) => Effect.Effect<void, TaskFailed>
		readonly finish: (payload: Payload) => Effect.Effect<void, TaskFailed>
		/** Ends the Run as failed after a task could not finish. */
		readonly abort: (payload: Payload, message: string) => Effect.Effect<void>
		/** Wakes the execution of a Run when the Turn that it waits for has ended. */
		readonly wake: (run: Stored) => Effect.Effect<void>
		/** Stops a Run, its execution and the Turns that it started. */
		readonly cancel: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			Option.Option<Stored>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
	}
>()("@openbot-build/openbot/workflows/Tasks") {}

export const make: Effect.Effect<
	typeof Tasks.Service,
	never,
	| Launcher
	| Backend
	| Agents
	| Runs
	| Recordings
	| Workflows
	| AuditLog
	| WorkflowEngine.WorkflowEngine
	| AuthorizationServices
> = Effect.gen(function* () {
	const launcher = yield* Launcher
	const backend = yield* Backend
	const agents = yield* Agents
	const runs = yield* Runs
	const recordings = yield* Recordings
	const workflows = yield* Workflows
	const audit = yield* AuditLog
	const engine = yield* WorkflowEngine.WorkflowEngine
	const services = yield* Effect.context<AuthorizationServices>()

	const fail = (message: string) => TaskFailed.make({ message })
	/** Every failure of a task becomes TaskFailed with a short message. Interruption stays. */
	const task = <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<A, TaskFailed, R> =>
		effect.pipe(
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
				const error = Cause.squash(cause)
				const message =
					Predicate.hasProperty(error, "message") &&
					typeof error.message === "string" &&
					error.message.length > 0
						? error.message
						: "OpenBot could not do a task of the Run."
				return Effect.logWarning("A task of a Workflow Run failed", cause).pipe(
					Effect.andThen(Effect.fail(fail(message))),
				)
			}),
		)
	const memberOf = (run: Stored): typeof Identity.Service => ({
		kind: "member",
		organizationId: run.organizationId,
		userId: run.userId,
	})
	const sessionsFor = (run: Stored) =>
		backend.get(ownerKey(memberOf(run)), memberOf(run))
	const load = (payload: Payload) =>
		runs.find(payload.organizationId, payload.run).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(fail("The Run does not exist any more.")),
					onSome: Effect.succeed,
				}),
			),
		)
	/** Changes the Run with its row locked. */
	const update = (payload: Payload, change: (run: Stored) => Stored) =>
		runs
			.change(payload.organizationId, payload.run, (run) =>
				Effect.succeedSome(change(run)),
			)
			.pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.fail(fail("The Run does not exist any more.")),
						onSome: Effect.succeed,
					}),
				),
			)
	const patchResult = (
		body: Body,
		index: number,
		patch: StepResultPatch,
	): Body => ({
		...body,
		results: body.results.map((result, at) =>
			at === index ? { ...result, ...patch } : result,
		),
	})
	const now = Effect.clockWith((clock) => clock.currentTimeMillis)
	/** Ends a step with its status, and returns whether it passed. */
	const settleStep = (
		payload: Payload,
		index: number,
		patch: StepResultPatch & { readonly status: "passed" | "failed" },
		body?: (body: Body) => Body,
	) =>
		Effect.gen(function* () {
			const at = yield* now
			yield* update(payload, (run) => ({
				...run,
				body: patchResult((body ?? ((same) => same))(run.body), index, {
					...patch,
					finishedAt: at,
				}),
			}))
			return patch.status === "passed"
		})
	/** Writes the confirmed recordings, after a check passed. A `read` Run only forgets them. */
	const confirm = (run: Stored) =>
		Effect.gen(function* () {
			if (run.body.pending.length === 0) return
			if (run.body.cache === "use" && run.workflowId !== null) {
				const at = yield* now
				for (const pending of run.body.pending)
					yield* recordings.put(run.organizationId, run.workflowId, {
						key: pending.key,
						step: pending.step,
						calls: pending.calls,
						verifiedAt: at,
					})
			}
		})
	/** The Session of an Agent in this Run. The first use makes it. */
	const sessionFor = (payload: Payload, agentId: AgentsApi.AgentId) =>
		Effect.gen(function* () {
			const run = yield* load(payload)
			const existing = run.body.sessions.find(
				(entry) => entry.agent === agentId,
			)
			if (existing !== undefined) return existing.session
			const agent = yield* agents.find(run.organizationId, agentId)
			if (Option.isNone(agent) || agent.value.archived)
				return yield* fail(`The Agent ${agentId} does not exist any more.`)
			const sessions = yield* sessionsFor(run)
			const view = yield* sessions.create({
				agent: agent.value,
				kind: "workflow",
				run: run.id,
				chain: {
					organizationId: run.organizationId,
					userId: run.userId,
					agents: [agent.value.id],
					sessions: [],
				},
				title: run.body.name.slice(0, 100),
			})
			yield* update(payload, (current) => ({
				...current,
				body: {
					...current.body,
					sessions: [
						...current.body.sessions,
						{ agent: agentId, session: view.session.id },
					],
				},
			}))
			return view.session.id
		})
	/** The Turn of a task, with the messages that it added to the history. */
	const ended = (payload: Payload, task: string) =>
		Effect.gen(function* () {
			const run = yield* load(payload)
			const ref = run.body.turns[task]
			if (ref === undefined) return yield* fail("The task has no Turn.")
			const sessions = yield* sessionsFor(run)
			const view = yield* sessions.get(ref.session)
			const { turn } = yield* sessions.turn(ref.session, ref.turn)
			return {
				run,
				turn,
				messages: messagesOf(view.state.value.conversation.history, turn.id),
			}
		})
	const failureOf = (turn: Turn.Record) =>
		turn.status._tag === "Failed"
			? "The Turn failed: " + turn.status.message
			: turn.status._tag === "Interrupted"
				? "The Turn was stopped."
				: null
	/** The result of the one tool of a call Turn. */
	const callResult = (
		turn: Turn.Record,
		messages: ReadonlyArray<Prompt.Message>,
		tool: string,
	): Result.Result<Schema.Json, string> => {
		const failure = failureOf(turn)
		if (failure !== null) return Result.fail(failure)
		const result = toolResults(messages)
			.filter((part) => part.name === tool)
			.at(-1)
		if (result === undefined)
			return Result.fail(`The tool ${tool} gave no result.`)
		return result.isFailure
			? Result.fail(JSON.stringify(result.result))
			: Result.succeed(json(result.result))
	}
	/** Sends the end of a Run to the Agent that started it. */
	const tell = (run: Stored) =>
		Effect.gen(function* () {
			if (run.parent === null) return
			const sessions = yield* sessionsFor(run)
			const view = yield* sessions.get(run.parent.session)
			const current = Session.currentTurn(view.session)
			const busy =
				current !== undefined &&
				(current.status._tag === "Running" || current.status._tag === "Waiting")
			const input = endText(run)
			if (busy) yield* sessions.enqueue(view.session.id, { input })
			else
				yield* sessions.send(view.session.id, {
					expected: view.session.revision,
					input,
				})
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("The end of a Workflow Run could not be sent", cause),
			),
		)
	const ending = (run: Stored) =>
		audit
			.record({
				organizationId: run.organizationId,
				action: "workflow.run_finished",
				actor: memberOf(run),
				resource: run.id,
				details: { workflow: run.workflowId, status: run.status },
			})
			.pipe(Effect.ignore, Effect.andThen(tell(run)))

	const prepare: typeof Tasks.Service.prepare = (payload) =>
		task(
			Effect.gen(function* () {
				const run = yield* load(payload)
				if (terminal(run.status)) return 0
				// A scheduled Run or a webhook Run works for the actor, who must still be allowed to run it.
				if (
					run.workflowId !== null &&
					(run.trigger === "schedule" || run.trigger === "webhook")
				) {
					const workflow = yield* workflows.find(
						run.organizationId,
						run.workflowId,
					)
					if (Option.isNone(workflow))
						return yield* fail("The Workflow does not exist any more.")
					const allowed = yield* can({
						caller: memberOf(run),
						permission: "workflows.run",
						key: workflowKey({
							...workflow.value,
							organizationId: run.organizationId,
						}),
					}).pipe(Effect.provideContext(services))
					if (!allowed)
						return yield* fail(
							"The actor of the Workflow may not run it any more.",
						)
				}
				const at = yield* now
				yield* update(payload, (current) => ({
					...current,
					status: "running",
					body: { ...current.body, startedAt: current.body.startedAt ?? at },
				}))
				return run.body.steps.length
			}),
		)

	const plan: typeof Tasks.Service.plan = (payload, index) =>
		task(
			Effect.gen(function* () {
				const at = yield* now
				const run = yield* update(payload, (current) => ({
					...current,
					body: patchResult(current.body, index, {
						status: "running",
						startedAt: current.body.results[index]?.startedAt ?? at,
					}),
				}))
				const body = run.body
				const step = body.steps[index]
				if (step === undefined) return yield* fail("The step does not exist.")
				const scope = scopeOf(body)
				const agent =
					"agent" in step && step.agent !== undefined ? step.agent : body.agent
				const model = body.judge === undefined ? {} : { model: body.judge }
				const broken = (message: string) =>
					settleStep(payload, index, {
						status: "failed",
						mode: "deterministic",
						message,
					}).pipe(Effect.as<Plan>({ _tag: "Done", passed: false }))
				const rendered = (template: string) => Templates.text(template, scope)
				switch (step._tag) {
					case "Expect": {
						const checked = Templates.expect(step, scope)
						if (Result.isFailure(checked)) return yield* broken(checked.failure)
						yield* confirm(run)
						return yield* settleStep(
							payload,
							index,
							{
								status: "passed",
								mode: "deterministic",
								output: checked.success,
								attempts: 1,
							},
							(body) => ({ ...body, pending: [] }),
						).pipe(Effect.as<Plan>({ _tag: "Done", passed: true }))
					}
					case "Call": {
						const args = Templates.json(step.arguments, scope)
						if (Result.isFailure(args)) return yield* broken(args.failure)
						if (!isJsonObject(args.success))
							return yield* broken("The arguments must be a JSON object.")
						return {
							_tag: "Call",
							start: {
								_tag: "Action",
								agent,
								tool: step.tool,
								arguments: args.success,
							},
						}
					}
					case "Act": {
						const goal = rendered(step.goal)
						if (Result.isFailure(goal)) return yield* broken(goal.failure)
						if (body.cache !== "off" && run.workflowId !== null) {
							const recorded = yield* recordings.find(
								run.organizationId,
								run.workflowId,
								keyOf({ step: step.id, goal: goal.success, agent }),
							)
							if (Option.isSome(recorded) && recorded.value.length > 0)
								return { _tag: "Replay", agent, calls: recorded.value }
						}
						return {
							_tag: "Turn",
							start: {
								_tag: "Message",
								agent,
								text: actText(body, index, goal.success),
							},
						}
					}
					case "Assert": {
						const condition = rendered(step.condition)
						if (Result.isFailure(condition))
							return yield* broken(condition.failure)
						return {
							_tag: "Turn",
							start: {
								_tag: "Message",
								agent,
								text: checkText(body, index, condition.success),
								...model,
							},
						}
					}
					case "WaitFor": {
						const condition = rendered(step.condition)
						if (Result.isFailure(condition))
							return yield* broken(condition.failure)
						return {
							_tag: "Wait",
							start: {
								_tag: "Message",
								agent,
								text: checkText(body, index, condition.success),
								...model,
							},
							attempts:
								Math.floor(step.timeoutSeconds / step.intervalSeconds) + 1,
							intervalSeconds: step.intervalSeconds,
						}
					}
					case "Extract": {
						const instruction = rendered(step.instruction)
						if (Result.isFailure(instruction))
							return yield* broken(instruction.failure)
						return {
							_tag: "Turn",
							start: {
								_tag: "Message",
								agent,
								text: extractText(
									body,
									index,
									instruction.success,
									step.schema,
								),
								...model,
							},
						}
					}
					case "Explore": {
						const goal = rendered(step.goal)
						if (Result.isFailure(goal)) return yield* broken(goal.failure)
						return {
							_tag: "Turn",
							start: {
								_tag: "Message",
								agent,
								text: exploreText(body, index, goal.success),
							},
						}
					}
				}
			}),
		)

	/** Clears the wait of a Run when it still waits with this token. True when this call cleared it. */
	const clearWait = (run: Stored, token: string) =>
		Effect.gen(function* () {
			const cleared = yield* Ref.make(false)
			yield* runs.change(run.organizationId, run.id, (current) =>
				current.waiting?.token === token
					? Ref.set(cleared, true).pipe(
							Effect.as(Option.some({ ...current, waiting: null })),
						)
					: Effect.succeedNone,
			)
			return yield* Ref.get(cleared)
		})
	/** The status of the Turn that a Run waits for, when the Turn has ended. */
	const endedStatus = (run: Stored, session: Session.Id, turn: string) =>
		sessionsFor(run).pipe(
			Effect.flatMap((sessions) => sessions.turn(session, Turn.Id.make(turn))),
			Effect.map(({ turn }) =>
				Option.filter(
					Option.some(turn.status._tag),
					(status): status is TurnEnded => Schema.is(TurnEnded)(status),
				),
			),
		)

	const start: typeof Tasks.Service.start = (
		payload,
		index,
		name,
		start,
		token,
	) =>
		task(
			Effect.gen(function* () {
				let run = yield* load(payload)
				let ref = run.body.turns[name]
				if (ref === undefined) {
					const session = yield* sessionFor(payload, start.agent)
					const sessions = yield* sessionsFor(run)
					const view = yield* sessions.get(session)
					const turn =
						start._tag === "Message"
							? (yield* sessions.send(session, {
									expected: view.session.revision,
									input: start.text,
									...(start.model === undefined
										? {}
										: { overrides: { model: start.model } }),
								})).id
							: (yield* sessions.startAction(session, {
									expected: view.session.revision,
									action: { name: start.tool, arguments: start.arguments },
								})).turn
					const started = { session, turn }
					ref = started
					run = yield* update(payload, (current) => {
						const body = patchResult(current.body, index, {
							turns: [...(current.body.results[index]?.turns ?? []), started],
							attempts: (current.body.results[index]?.attempts ?? 0) + 1,
						})
						return {
							...current,
							body: { ...body, turns: { ...body.turns, [name]: started } },
							waiting: { session, turn, token },
						}
					})
				} else if (run.waiting === null) {
					// The task runs again after a restart, and nobody woke the execution yet.
					run = yield* update(payload, (current) => ({
						...current,
						waiting: { session: ref!.session, turn: ref!.turn, token },
					}))
				}
				// The Turn may have ended before the wait was saved. Then nobody else wakes the execution.
				const status = yield* endedStatus(run, ref.session, ref.turn)
				if (Option.isNone(status)) return false
				return yield* clearWait(run, token)
			}),
		)

	const collectCall: typeof Tasks.Service.collectCall = (
		payload,
		index,
		name,
	) =>
		task(
			Effect.gen(function* () {
				const { run, turn, messages } = yield* ended(payload, name)
				const step = run.body.steps[index]!
				if (step._tag !== "Call") return yield* fail("The step is not a call.")
				const result = callResult(turn, messages, step.tool)
				return yield* settleStep(
					payload,
					index,
					Result.isSuccess(result)
						? {
								status: "passed",
								mode: "deterministic",
								output: result.success,
							}
						: {
								status: "failed",
								mode: "deterministic",
								message: result.failure,
							},
				)
			}),
		)

	const checkReplay: typeof Tasks.Service.checkReplay = (
		payload,
		index,
		name,
		call,
		calls,
	) =>
		task(
			Effect.gen(function* () {
				const { run, turn, messages } = yield* ended(payload, name)
				const recorded = calls[call]!
				const result = callResult(turn, messages, recorded.tool)
				if (Result.isSuccess(result)) return { _tag: "Ok" } as const
				const step = run.body.steps[index]!
				const goal =
					step._tag === "Act"
						? Result.getOrElse(
								Templates.text(step.goal, scopeOf(run.body)),
								() => step.goal,
							)
						: ""
				return {
					_tag: "Handoff",
					text: handoffText({
						body: run.body,
						index,
						goal,
						done: calls.slice(0, call),
						failed: recorded,
						error: result.failure,
					}),
				} as const
			}),
		)

	const replayed: typeof Tasks.Service.replayed = (payload, index, calls) =>
		task(
			settleStep(payload, index, {
				status: "passed",
				mode: "replayed",
				message: `OpenBot replayed ${calls} recorded tool calls.`,
			}),
		)

	const collect: typeof Tasks.Service.collect = (
		payload,
		index,
		name,
		mode,
		done,
	) =>
		task(
			Effect.gen(function* () {
				const { run, turn, messages } = yield* ended(payload, name)
				const step = run.body.steps[index]!
				const failure = failureOf(turn)
				const text =
					turn.status._tag === "Completed" ? turn.status.result.text : ""
				if (failure !== null)
					return yield* settleStep(payload, index, {
						status: "failed",
						mode,
						message: failure,
					})
				const report = inputsOf(messages, names.stepResult, StepResultInput).at(
					-1,
				)
				switch (step._tag) {
					case "Act": {
						const passed = report === undefined || report.status === "done"
						const results = toolResults(messages)
						const calls: Calls = [
							...done,
							...toolCalls(messages).flatMap((part) =>
								!own.has(part.name) &&
								isJsonObject(json(part.params)) &&
								results.some(
									(result) => result.id === part.id && !result.isFailure,
								)
									? [
											{
												tool: part.name,
												arguments: json(part.params) as Schema.JsonObject,
											},
										]
									: [],
							),
						]
						const goal = Result.getOrElse(
							Templates.text(step.goal, scopeOf(run.body)),
							() => step.goal,
						)
						const agent = step.agent ?? run.body.agent
						return yield* settleStep(
							payload,
							index,
							{
								status: passed ? "passed" : "failed",
								mode,
								output: report?.summary ?? text,
								message: report?.summary ?? null,
							},
							(body) =>
								passed && body.cache === "use" && calls.length > 0
									? {
											...body,
											pending: [
												...body.pending.filter(
													(entry) => entry.step !== step.id,
												),
												{
													step: step.id,
													key: keyOf({ step: step.id, goal, agent }),
													calls,
												},
											],
										}
									: body,
						)
					}
					case "Assert": {
						const check = inputsOf(messages, names.check, CheckInput).at(-1)
						const passed = check?.passed === true
						if (passed) yield* confirm(run)
						return yield* settleStep(
							payload,
							index,
							{
								status: passed ? "passed" : "failed",
								mode,
								output: check?.evidence ?? null,
								message:
									check?.evidence ?? `The Agent did not call ${names.check}.`,
							},
							(body) => (passed ? { ...body, pending: [] } : body),
						)
					}
					case "Extract": {
						const extracted = inputsOf(
							messages,
							names.extract,
							ExtractInput,
						).at(-1)
						if (extracted === undefined)
							return yield* settleStep(payload, index, {
								status: "failed",
								mode,
								message: `The Agent did not call ${names.extract}.`,
							})
						const schema = extractSchema(step.schema)
						const valid = Result.isSuccess(schema)
							? Schema.decodeOption(schema.success as Schema.Decoder<unknown>)(
									extracted.value,
								)
							: Option.none()
						if (Option.isNone(valid))
							return yield* settleStep(payload, index, {
								status: "failed",
								mode,
								output: extracted.value,
								message:
									"The value does not match the JSON Schema of the step.",
							})
						return yield* settleStep(
							payload,
							index,
							{ status: "passed", mode, output: extracted.value },
							(body) => ({
								...body,
								variables: { ...body.variables, [step.name]: extracted.value },
							}),
						)
					}
					case "Explore": {
						const findings = inputsOf(
							messages,
							names.finding,
							FindingInput,
						).map((finding): WorkflowsApi.Finding => ({
							step: step.id,
							...finding,
						}))
						const passed = report?.status !== "failed"
						return yield* settleStep(
							payload,
							index,
							{
								status: passed ? "passed" : "failed",
								mode,
								output: report?.summary ?? text,
								message: `The Agent reported ${findings.length} findings.`,
							},
							(body) => ({
								...body,
								findings: [...body.findings, ...findings],
							}),
						)
					}
					default:
						return yield* fail("This step does not use a Turn of the Agent.")
				}
			}),
		)

	const collectWait: typeof Tasks.Service.collectWait = (
		payload,
		index,
		name,
		last,
	) =>
		task(
			Effect.gen(function* () {
				const { run, turn, messages } = yield* ended(payload, name)
				const step = run.body.steps[index]!
				const check = inputsOf(messages, names.check, CheckInput).at(-1)
				const passed = failureOf(turn) === null && check?.passed === true
				const evidence =
					failureOf(turn) ??
					check?.evidence ??
					`The Agent did not call ${names.check}.`
				if (passed) {
					yield* confirm(run)
					return yield* settleStep(
						payload,
						index,
						{
							status: "passed",
							mode: "live",
							output: evidence,
							message: evidence,
						},
						(body) => ({ ...body, pending: [] }),
					)
				}
				if (last)
					return yield* settleStep(payload, index, {
						status: "failed",
						mode: "live",
						message: `The condition was not true within ${step._tag === "WaitFor" ? step.timeoutSeconds : 0} seconds. Last evidence: ${evidence}`,
					})
				yield* update(payload, (current) => ({
					...current,
					body: patchResult(current.body, index, {
						mode: "live",
						message: evidence,
					}),
				}))
				return false
			}),
		)

	const skip: typeof Tasks.Service.skip = (payload, from) =>
		task(
			update(payload, (run) => ({
				...run,
				body: {
					...run.body,
					results: run.body.results.map((result, index) =>
						index >= from && result.status === "pending"
							? { ...result, status: "skipped" }
							: result,
					),
				},
			})).pipe(Effect.asVoid),
		)

	/** Ends a Run. It fails when a step failed or when `error` says why it stopped. */
	const close = (payload: Payload, error: string | null) =>
		Effect.gen(function* () {
			const at = yield* now
			const closed = yield* Ref.make(false)
			const run = yield* runs.change(
				payload.organizationId,
				payload.run,
				(run) =>
					terminal(run.status)
						? Effect.succeedNone
						: Ref.set(closed, true).pipe(
								Effect.as(
									Option.some<Stored>({
										...run,
										status:
											error === null &&
											!run.body.results.some(
												(result) => result.status === "failed",
											)
												? "passed"
												: "failed",
										waiting: null,
										finishedAt: at,
										body: {
											...run.body,
											error,
											results: run.body.results.map((result) =>
												result.status === "running"
													? {
															...result,
															status: "failed",
															message: error ?? result.message,
															finishedAt: at,
														}
													: result.status === "pending"
														? { ...result, status: "skipped" }
														: result,
											),
										},
									}),
								),
							),
			)
			if ((yield* Ref.get(closed)) && Option.isSome(run))
				yield* ending(run.value)
		})

	const finish: typeof Tasks.Service.finish = (payload) =>
		task(close(payload, null))
	const abort: typeof Tasks.Service.abort = (payload, message) =>
		close(payload, message).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("A failed Workflow Run could not be closed", cause),
			),
		)

	const wake: typeof Tasks.Service.wake = (run) =>
		Effect.gen(function* () {
			const waiting = run.waiting
			if (waiting === null) return
			const status = yield* endedStatus(run, waiting.session, waiting.turn)
			if (Option.isNone(status)) return
			if (!(yield* clearWait(run, waiting.token))) return
			yield* DurableDeferred.done(turnEnded("turn"), {
				token: DurableDeferred.Token.make(waiting.token),
				exit: Exit.succeed(status.value),
			}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("A Workflow Run could not be woken", cause),
			),
		)

	const cancel: typeof Tasks.Service.cancel = (organizationId, id) =>
		Effect.gen(function* () {
			const at = yield* now
			const closed = yield* Ref.make(false)
			const run = yield* runs.change(organizationId, id, (run) =>
				terminal(run.status)
					? Effect.succeedNone
					: Ref.set(closed, true).pipe(
							Effect.as(
								Option.some<Stored>({
									...run,
									status: "cancelled",
									waiting: null,
									finishedAt: at,
									body: {
										...run.body,
										results: run.body.results.map((result) =>
											result.status === "running" || result.status === "pending"
												? {
														...result,
														status: "skipped",
														message: "The Run was cancelled.",
													}
												: result,
										),
									},
								}),
							),
						),
			)
			if (Option.isNone(run) || !(yield* Ref.get(closed))) return run
			yield* launcher.interrupt(run.value)
			const sessions = yield* sessionsFor(run.value).pipe(Effect.option)
			if (Option.isSome(sessions))
				for (const entry of run.value.body.sessions) {
					const view = yield* sessions.value
						.get(entry.session)
						.pipe(Effect.option)
					const current = Option.flatMap(view, (view) =>
						Option.fromNullishOr(Session.currentTurn(view.session)),
					)
					if (
						Option.isSome(current) &&
						(current.value.status._tag === "Running" ||
							current.value.status._tag === "Waiting")
					)
						yield* sessions.value
							.interrupt(entry.session, current.value.id)
							.pipe(Effect.ignore)
				}
			yield* ending(run.value)
			return run
		})

	return Tasks.of({
		prepare,
		plan,
		start,
		collectCall,
		checkReplay,
		replayed,
		collect,
		collectWait,
		skip,
		finish,
		abort,
		wake,
		cancel,
	})
})

export const layer = Layer.effect(Tasks, make)
