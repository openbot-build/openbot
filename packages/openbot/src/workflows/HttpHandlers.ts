import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import {
	type Caller,
	Identity,
	OpenBotApi,
	type OrganizationApi,
	Permissions,
	WorkflowsApi,
} from "@openbot-build/api"
import { Effect, Option, type Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import { can } from "../authorization/Check.ts"
import { workflowKey, workflowPlace } from "../authorization/Policy.ts"
import { Agents } from "../agents/Agents.ts"
import { Launcher } from "./Execution.ts"
import { Recordings } from "./Recordings.ts"
import * as Report from "./Report.ts"
import { Runs, view } from "./Runs.ts"
import { Tasks } from "./Tasks.ts"
import { Workflows } from "./Workflows.ts"

const unavailable = () => WorkflowsApi.WorkflowStorageUnavailable.make({})

/** The Agents that do the steps of a Workflow. */
const agentsOf = (workflow: WorkflowsApi.Workflow) => [
	...new Set([
		...(workflow.agent === null ? [] : [workflow.agent]),
		...workflow.steps.flatMap((step) =>
			"agent" in step && step.agent !== undefined ? [step.agent] : [],
		),
	]),
]

export const layer = (publicOrigin: string) =>
	HttpApiBuilder.group(OpenBotApi, "workflows", (handlers) =>
		Effect.gen(function* () {
			const workflows = yield* Workflows
			const runs = yield* Runs
			const recordings = yield* Recordings
			const launcher = yield* Launcher
			const tasks = yield* Tasks
			const agents = yield* Agents
			const audit = yield* AuditLog
			const services = yield* Effect.context<AuthorizationServices>()
			const access = (
				caller: Caller,
				id: string,
				permission: Permissions.PermissionGroupId,
			) =>
				workflows
					.access(caller, id, permission)
					.pipe(Effect.provideContext(services))
			const record = (
				caller: Caller,
				action: OrganizationApi.AuditAction,
				workflow: WorkflowsApi.Workflow,
				details: Schema.JsonObject,
			) =>
				audit
					.record({
						organizationId: caller.organizationId,
						action,
						actor: caller,
						resource: workflowKey({
							...workflow,
							organizationId: caller.organizationId,
						}),
						details,
					})
					.pipe(Effect.mapError(unavailable))
			/** The caller must be able to give work to every Agent that does the steps. */
			const mayUse = (
				caller: Caller,
				list: ReadonlyArray<WorkflowsApi.Workflow["agent"] & string>,
			) =>
				Effect.forEach(list, (agent) =>
					agents.access(caller, agent, "agents.delegate").pipe(
						Effect.provideContext(services),
						Effect.catchTags({
							AgentNotFound: () =>
								Effect.fail(
									WorkflowsApi.WorkflowInvalid.make({
										message: `There is no Agent ${agent}.`,
									}),
								),
							AgentConflict: () => Effect.fail(unavailable()),
							AgentInvalid: () => Effect.fail(unavailable()),
							AgentStorageUnavailable: () => Effect.fail(unavailable()),
						}),
					),
				)
			/** The Runs of a member are below the member, like their Sessions. */
			const ownRuns = (
				caller: Caller,
				permission: "workflows.read" | "workflows.run",
			) =>
				Effect.gen(function* () {
					const key = workflowPlace({
						organizationId: caller.organizationId,
						root: caller.userId,
					})
					if (
						!(yield* can({ caller, permission, key }).pipe(
							Effect.provideContext(services),
						))
					)
						return yield* Permissions.PermissionDenied.make({
							permission,
							resource: key,
						})
				})
			const ownRun = (
				caller: Caller,
				id: string,
				permission: "workflows.read" | "workflows.run",
			) =>
				Effect.gen(function* () {
					yield* ownRuns(caller, permission)
					const found = yield* runs.find(caller.organizationId, id)
					if (Option.isNone(found) || found.value.userId !== caller.userId)
						return yield* WorkflowsApi.WorkflowNotFound.make({ id })
					return found.value
				})
			return handlers
				.handle("listWorkflows", ({ query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						return yield* workflows
							.list(caller, {
								...(query.archived === undefined
									? {}
									: { archived: query.archived === "true" }),
								...(query.owner === undefined ? {} : { owner: query.owner }),
							})
							.pipe(Effect.provideContext(services))
					}),
				)
				.handle("createWorkflow", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const workflow = yield* workflows
							.create(caller, payload)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "workflow.created", workflow, {
							name: workflow.name,
							steps: workflow.steps.length,
						})
						return workflow
					}),
				)
				.handle("getWorkflow", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						access(caller, params.workflowId, "workflows.read"),
					),
				)
				.handle("updateWorkflow", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const workflow = yield* workflows
							.update(caller, params.workflowId, payload)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "workflow.updated", workflow, {
							revision: workflow.revision,
						})
						return workflow
					}),
				)
				.handle("startRun", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const workflow = yield* access(
							caller,
							params.workflowId,
							"workflows.run",
						)
						if (workflow.archived)
							return yield* WorkflowsApi.WorkflowInvalid.make({
								message: "An archived Workflow cannot run.",
							})
						yield* mayUse(caller, agentsOf(workflow))
						const run = yield* launcher.start({
							organizationId: caller.organizationId,
							userId: caller.userId,
							trigger: "manual",
							input: payload.input ?? {},
							cache: payload.cache ?? "use",
							source: { _tag: "Workflow", workflow },
						})
						return view(run)
					}),
				)
				.handle("setWebhook", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { workflow, secret } = yield* workflows
							.setWebhook(caller, params.workflowId)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "workflow.hook_changed", workflow, {
							webhook: true,
						})
						return {
							url: publicOrigin + "/v1/hooks/workflows/" + workflow.id,
							secret,
						}
					}),
				)
				.handle("removeWebhook", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const workflow = yield* workflows
							.removeWebhook(caller, params.workflowId)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "workflow.hook_changed", workflow, {
							webhook: false,
						})
					}),
				)
				.handle("listRecordings", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const workflow = yield* access(
							caller,
							params.workflowId,
							"workflows.read",
						)
						return yield* recordings.list(caller.organizationId, workflow.id)
					}),
				)
				.handle("clearRecordings", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const workflow = yield* access(
							caller,
							params.workflowId,
							"workflows.write",
						)
						yield* recordings.clear(caller.organizationId, workflow.id)
						yield* record(caller, "workflow.updated", workflow, {
							recordings: "cleared",
						})
					}),
				)
				.handle("explore", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						yield* ownRuns(caller, "workflows.run")
						if (payload.agent !== undefined)
							yield* mayUse(caller, [payload.agent])
						const run = yield* launcher.start({
							organizationId: caller.organizationId,
							userId: caller.userId,
							trigger: "explore",
							input: payload.input ?? {},
							cache: "off",
							source: {
								_tag: "Explore",
								goal: payload.goal,
								...(payload.agent === undefined
									? {}
									: { agent: payload.agent }),
							},
						})
						return view(run)
					}),
				)
				.handle("listRuns", ({ query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						yield* ownRuns(caller, "workflows.read")
						const list = yield* runs.list(caller.organizationId, {
							userId: caller.userId,
							...(query.workflow === undefined
								? {}
								: { workflowId: query.workflow }),
							...(query.status === undefined ? {} : { status: query.status }),
						})
						return list.map(view)
					}),
				)
				.handle("getRun", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						ownRun(caller, params.runId, "workflows.read").pipe(
							Effect.map(view),
						),
					),
				)
				.handle("cancelRun", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const run = yield* ownRun(caller, params.runId, "workflows.run")
						const cancelled = yield* tasks.cancel(run.organizationId, run.id)
						return view(Option.getOrElse(cancelled, () => run))
					}),
				)
				.handle("runReportMarkdown", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						ownRun(caller, params.runId, "workflows.read").pipe(
							Effect.map((run) => Report.markdown(view(run))),
						),
					),
				)
				.handle("runReportJunit", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						ownRun(caller, params.runId, "workflows.read").pipe(
							Effect.map((run) => Report.junit(view(run))),
						),
					),
				)
		}),
	)

/** Webhooks: the secret is the only credential. The Run works for the actor of the Workflow. */
export const layerHooks = HttpApiBuilder.group(
	OpenBotApi,
	"workflowHooks",
	(handlers) =>
		Effect.gen(function* () {
			const workflows = yield* Workflows
			const launcher = yield* Launcher
			return handlers.handle(
				"triggerWorkflow",
				({ params, headers, payload }) =>
					Effect.gen(function* () {
						const denied = WorkflowsApi.WorkflowHookDenied.make({})
						const match = /^Bearer\s+(\S+)$/i.exec(headers.authorization)
						if (match === null) return yield* denied
						const found = yield* workflows.verifyHook(
							params.workflowId,
							match[1]!,
						)
						if (Option.isNone(found) || found.value.workflow.actor === null)
							return yield* denied
						const { organizationId, workflow } = found.value
						const run = yield* launcher.start({
							organizationId,
							userId: workflow.actor!,
							trigger: "webhook",
							input: payload,
							cache: "use",
							source: { _tag: "Workflow", workflow },
						})
						return { run: run.id }
					}),
			)
		}),
)
