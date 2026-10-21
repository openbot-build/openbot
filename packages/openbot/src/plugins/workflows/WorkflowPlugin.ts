import type { Services as AuthorizationServices } from "../../authorization/Authorize.ts"
import {
	Agent,
	Plugin,
	type Session,
	type SessionStore,
} from "@openbot-build/core"
import { WorkflowsApi } from "@openbot-build/api"
import {
	Context,
	Effect,
	type JsonSchema,
	Layer,
	Option,
	Record,
	Schema,
	Stream,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { Gate } from "../../capabilities/Gate.ts"
import { Work } from "../../capabilities/Work.ts"
import * as SessionHost from "../../sessions/SessionHost.ts"
import { Launcher } from "../../workflows/Execution.ts"
import { Workflows } from "../../workflows/Workflows.ts"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/workflows")

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

/** The tool names of this plugin. A Run finds the answers of a step by these names. */
export const names = {
	list: "openbot_list_workflows",
	run: "openbot_run_workflow",
	stepResult: "openbot_step_result",
	check: "openbot_check",
	extract: "openbot_extract",
	finding: "openbot_report_finding",
} as const

export const StepResultInput = Schema.Struct({
	status: Schema.Literals(["done", "failed"]),
	summary: Schema.String,
})
export const CheckInput = Schema.Struct({
	passed: Schema.Boolean,
	evidence: Schema.String,
})
export const ExtractInput = Schema.Struct({ value: Schema.Json })
export const FindingInput = Schema.Struct({
	severity: WorkflowsApi.Severity,
	title: Schema.String,
	expected: Schema.String,
	observed: Schema.String,
	reproduction: Schema.Array(Schema.String),
})
const RunInput = Schema.Struct({
	workflow: Schema.String,
	reason: Schema.String,
	input: Schema.optionalKey(Schema.JsonObject),
})

interface Entry {
	readonly tool: Tools[string]
	readonly handle: (input: unknown) => Effect.Effect<Schema.Json>
}

const text = { type: "string" } as const
const json = (value: unknown): Schema.Json =>
	JSON.parse(JSON.stringify(value)) as Schema.Json

/** The words that a workflow Session reads with every step. */
const runInstructions = `You work in a Workflow Run. Each message is one step of the Run. Do only that step.
- An act step or an explore step: use your tools to reach the goal. Then call ${names.stepResult} once.
- In an explore step, call ${names.finding} for each problem that you find.
- A check step: look at the current state with your tools, but never change anything. Then call ${names.check} once.
- An extract step: look, but never change anything. Then call ${names.extract} once with the value.`

type Services = Workflows | Launcher | Gate | AuthorizationServices

/** What the Sessions of one member give to the Workflow plugin. */
interface ForOwnerInput {
	readonly read: (
		session: Session.Id,
	) => Effect.Effect<
		Session.View<SessionHost.Values>,
		Session.SessionNotFound | SessionStore.SessionStoreError
	>
}

/** Builds the Workflow plugin for the Sessions of one member. It runs inside the Agent plugin. */
export class WorkflowPlugin extends Context.Service<
	WorkflowPlugin,
	{ readonly forOwner: (input: ForOwnerInput) => Plugin.Plugin<Tools> }
>()("@openbot-build/openbot/plugins/workflows/WorkflowPlugin") {}

export const make: Effect.Effect<
	typeof WorkflowPlugin.Service,
	never,
	Services
> = Effect.gen(function* () {
	const services = yield* Effect.context<AuthorizationServices>()
	const workflows = yield* Workflows
	const launcher = yield* Launcher
	const gate = yield* Gate
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
					Effect.logWarning("A Workflow tool failed", cause).pipe(
						Effect.as(
							json({ error: "The tool could not finish. Try another way." }),
						),
					),
				),
			),
	})
	/** A tool whose answer the Run reads from the history. The tool only checks the input. */
	const answer = <A, I>(
		name: string,
		description: string,
		parameters: JsonSchema.JsonSchema,
		schema: Schema.Codec<A, I>,
	) =>
		entry(name, description, parameters, (input) =>
			Schema.decodeUnknownEffect(schema)(input).pipe(
				Effect.as(json({ received: true })),
			),
		)
	const visible = Effect.gen(function* () {
		const current = yield* work
		return yield* workflows
			.list(current.caller, { archived: false })
			.pipe(Effect.provideContext(services))
	})
	const common: ReadonlyArray<Entry> = [
		entry(
			names.list,
			"List the Workflows that you can run, with their ids and steps.",
			{ type: "object", properties: {} },
			() =>
				visible.pipe(
					Effect.map((list) =>
						json(
							list.map((workflow) => ({
								id: workflow.id,
								name: workflow.name,
								description: workflow.description,
								steps: workflow.steps.map((step) => step._tag + " " + step.id),
							})),
						),
					),
				),
		),
		entry(
			names.run,
			`Start a Run of a Workflow. Use an id from ${names.list}. The Run goes on in the background, and its result comes to this Session as a new message.`,
			{
				type: "object",
				properties: {
					workflow: text,
					reason: {
						type: "string",
						description:
							"Why you need this. The decider above you reads it when it must agree first.",
					},
					input: {
						type: "object",
						description:
							"The input of the Run. Steps read it as {{input.name}}.",
					},
				},
				required: ["workflow", "reason"],
			},
			(input) =>
				Effect.gen(function* () {
					const current = yield* work
					const request = yield* Schema.decodeUnknownEffect(RunInput)(input)
					const found = (yield* visible).find(
						(workflow) => workflow.id === request.workflow,
					)
					if (found === undefined)
						return json({
							error: `There is no Workflow with this id. Use ${names.list}.`,
						})
					// A handler does not know its tool call id. The Turn, the model step and the
					// Workflow name the call, so a second run of the same call finds the first Run.
					const step = yield* Effect.serviceOption(Agent.Context).pipe(
						Effect.flatMap(
							Option.match({
								onNone: () => Effect.succeed(0),
								onSome: (context) => context.step,
							}),
						),
					)
					const run = yield* launcher.start({
						organizationId: current.caller.organizationId,
						userId: current.caller.userId,
						trigger: "agent",
						input: request.input ?? {},
						cache: "use",
						source: { _tag: "Workflow", workflow: found },
						parent: {
							session: current.session,
							toolCallId: current.turn + "/" + step + "/" + found.id,
						},
					})
					return json({
						run: run.id,
						status: run.status,
						note: "The Run goes on. Its result comes as a new message.",
					})
				}),
			(input, context) =>
				Effect.gen(function* () {
					const request = yield* Schema.decodeUnknownEffect(RunInput)(input)
					const current = yield* work
					const found = (yield* visible).find(
						(workflow) => workflow.id === request.workflow,
					)
					// The handler explains a wrong id, so no decision is needed for it.
					if (found === undefined) return false
					const answer = yield* gate.check({
						capability: { action: "workflows.run", target: found.id },
						reason: request.reason,
						toolCallId: context.toolCallId,
						workflow: found,
						// An Agent may always run the Workflows that it owns.
						implicit:
							found.owner._tag === "Agent" &&
							found.owner.agent === current.agent.id,
					})
					return answer === "pause"
				}).pipe(Effect.orElseSucceed(() => true)),
		),
	]
	const runEntries: ReadonlyArray<Entry> = [
		answer(
			names.stepResult,
			"Say that the current act or explore step is done, or that it failed. Call it once.",
			{
				type: "object",
				properties: {
					status: { type: "string", enum: ["done", "failed"] },
					summary: text,
				},
				required: ["status", "summary"],
			},
			StepResultInput,
		),
		answer(
			names.check,
			"Give the answer of the current check step. passed is true only when the condition is true now.",
			{
				type: "object",
				properties: { passed: { type: "boolean" }, evidence: text },
				required: ["passed", "evidence"],
			},
			CheckInput,
		),
		answer(
			names.extract,
			"Give the value of the current extract step. It must match the JSON Schema in the step.",
			{
				type: "object",
				properties: { value: {} },
				required: ["value"],
			},
			ExtractInput,
		),
		answer(
			names.finding,
			"Report one problem that you found while you explored.",
			{
				type: "object",
				properties: {
					severity: { type: "string", enum: WorkflowsApi.Severity.literals },
					title: text,
					expected: text,
					observed: text,
					reproduction: { type: "array", items: text },
				},
				required: ["severity", "title", "expected", "observed", "reproduction"],
			},
			FindingInput,
		),
	]
	return WorkflowPlugin.of({
		forOwner: (input) =>
			Plugin.make({ id: pluginId })<Tools>(() =>
				Effect.succeed((next, options) =>
					Stream.unwrap(
						Effect.gen(function* () {
							const context = yield* Agent.Context
							const at = yield* context.at
							const view = yield* input.read(at.session)
							const state = SessionHost.hostState(view.session)
							// A review decides one request, so it gets no Workflow tools.
							if (state.kind === "review") return next(options)
							const entries =
								state.kind === "workflow" ? [...common, ...runEntries] : common
							const incoming = yield* options.toolkit
							const own = Toolkit.make(...entries.map((entry) => entry.tool))
							const handlers = yield* own.toHandlers(
								Record.fromEntries(
									entries.map((entry) => [entry.tool.name, entry.handle]),
								),
							)
							return next({
								...options,
								...(state.kind === "workflow"
									? {
											instructions: Prompt.concat(
												options.instructions,
												Prompt.make([
													{ role: "system", content: runInstructions },
												]),
											),
										}
									: {}),
								toolkit: Effect.succeed(Toolkit.merge(incoming, own)),
							}).pipe(Stream.provideContext(handlers))
							// Without its Session, a Turn cannot run, so it fails.
						}).pipe(Effect.orDie),
					),
				),
			),
	})
})
export const layer = Layer.effect(WorkflowPlugin, make)
