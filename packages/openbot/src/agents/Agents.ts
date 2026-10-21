import { randomUUID } from "node:crypto"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import type { Config, Session } from "@openbot-build/core"
import { AgentsApi, type Caller, Permissions } from "@openbot-build/api"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { can } from "../authorization/Check.ts"
import { agentKey } from "../authorization/Policy.ts"
import { AgentRecords, type Keys } from "./AgentRecords.ts"

type Agent = AgentsApi.Agent
type AgentId = AgentsApi.AgentId

export type Failure =
	| AgentsApi.AgentNotFound
	| AgentsApi.AgentConflict
	| AgentsApi.AgentInvalid
	| AgentsApi.AgentStorageUnavailable
	| Permissions.PermissionDenied
	| Permissions.AuthorizationUnavailable

/** The member that work is done for. */
export interface Subject {
	readonly organizationId: string
	readonly userId: string
}

export const mainInstructions =
	"You are the Main Agent of one person. You act for them. Do simple work yourself. When work needs a special skill or a long effort, give it to one of the person's other Agents with the delegate tool, or start a subagent for it. Write a clear brief, and always pass the person's own words unchanged. Read the results, check them, and tell the person what was done."

export const newId = () => "agt_" + randomUUID().replaceAll("-", "")

/** The Agents of an organization: the Main Agents, other lasting Agents and subagents. */
export class Agents extends Context.Service<
	Agents,
	{
		/** The Main Agent of a member. It is made the first time it is needed. */
		readonly ensureMain: (
			subject: Subject,
		) => Effect.Effect<Agent, AgentsApi.AgentStorageUnavailable>
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Agent>, AgentsApi.AgentStorageUnavailable>
		/** Reads an Agent and checks that the caller has the permission on it. */
		readonly access: (
			caller: Caller,
			id: string,
			permission: Permissions.PermissionGroupId,
		) => Effect.Effect<Agent, Failure, AuthorizationServices>
		readonly list: (
			caller: Caller,
			input: { readonly archived?: boolean; readonly session?: Session.Id },
		) => Effect.Effect<ReadonlyArray<Agent>, Failure, AuthorizationServices>
		readonly create: (
			caller: Caller,
			input: AgentsApi.CreateAgentRequest,
		) => Effect.Effect<Agent, Failure, AuthorizationServices>
		/** Makes a subagent. The Session owns it, and it lives as long as the Session. */
		readonly createSubagent: (
			subject: Subject,
			input: {
				readonly session: Session.Id
				readonly name: string
				readonly role: string
				readonly instructions: string
				readonly model?: Config.Selection
			},
		) => Effect.Effect<Agent, AgentsApi.AgentStorageUnavailable>
		readonly update: (
			caller: Caller,
			id: string,
			input: AgentsApi.UpdateAgentRequest,
		) => Effect.Effect<Agent, Failure, AuthorizationServices>
		/** Changes the owner of a subagent to the member of its Session. */
		readonly promote: (
			caller: Caller,
			id: string,
			expected: number,
		) => Effect.Effect<Agent, Failure, AuthorizationServices>
		/** The subagents that a Session owns. */
		readonly ownedBy: (
			subject: Subject,
			session: Session.Id,
		) => Effect.Effect<ReadonlyArray<Agent>, AgentsApi.AgentStorageUnavailable>
		/** Archives the subagents of a Session, for example when the Session goes away. */
		readonly archiveOwnedBy: (
			subject: Subject,
			session: Session.Id,
		) => Effect.Effect<ReadonlyArray<Agent>, AgentsApi.AgentStorageUnavailable>
		/** Copies a subagent for another Session, so that a Fork has its own subagent. */
		readonly copyFor: (
			subject: Subject,
			agent: Agent,
			session: Session.Id,
		) => Effect.Effect<Agent, AgentsApi.AgentStorageUnavailable>
	}
>()("@openbot-build/openbot/agents/Agents") {}

/** The status key of an Agent record: its kind, or `archived`. */
const RecordStatus = Schema.Literals([
	"archived",
	...AgentsApi.AgentKind.literals,
])
type RecordStatus = typeof RecordStatus.Type

/** The owner and scope keys of an Agent record. */
const keys = (organizationId: string, agent: Agent): Keys<RecordStatus> => ({
	organizationId,
	id: agent.id,
	owner: agent.owner._tag === "Organization" ? "" : agent.owner.userId,
	scope: agent.owner._tag === "Session" ? agent.owner.session : "",
	status: agent.archived ? "archived" : agent.kind,
})

export const make: Effect.Effect<typeof Agents.Service, never, AgentRecords> =
	Effect.gen(function* () {
		const records = yield* AgentRecords
		const agents = records.collection("agent", AgentsApi.Agent, RecordStatus)
		const put = (organizationId: string, agent: Agent) =>
			agents.put(keys(organizationId, agent), agent).pipe(Effect.as(agent))
		const find: typeof Agents.Service.find = (organizationId, id) =>
			agents.find(organizationId, id)
		const notFound = (id: string) => AgentsApi.AgentNotFound.make({ agent: id })
		const access: typeof Agents.Service.access = (caller, id, permission) =>
			Effect.gen(function* () {
				const agent = yield* find(caller.organizationId, id).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.fail(notFound(id)),
							onSome: Effect.succeed,
						}),
					),
				)
				const key = agentKey({
					...agent,
					organizationId: caller.organizationId,
				})
				// A caller who cannot read the Agent does not learn that it exists.
				if (!(yield* can({ caller, permission: "agents.read", key })))
					return yield* notFound(id)
				if (
					permission !== "agents.read" &&
					!(yield* can({ caller, permission, key }))
				)
					return yield* Permissions.PermissionDenied.make({
						permission,
						resource: key,
					})
				return agent
			})
		const ensureMain: typeof Agents.Service.ensureMain = (subject) =>
			records.transaction(
				"main:" + subject.organizationId + ":" + subject.userId,
				Effect.gen(function* () {
					const existing = (yield* agents.list(subject.organizationId, {
						owner: subject.userId,
						status: "main",
					}))[0]
					if (existing !== undefined) return existing
					const now = yield* Clock.currentTimeMillis
					return yield* put(subject.organizationId, {
						id: AgentsApi.AgentId.make(newId()),
						kind: "main",
						owner: { _tag: "Member", userId: subject.userId },
						name: "Main",
						role: "Main Agent",
						instructions: mainInstructions,
						archived: false,
						revision: 0,
						createdAt: now,
						updatedAt: now,
					})
				}),
			)
		const change = (
			caller: Caller,
			id: string,
			permission: Permissions.PermissionGroupId,
			expected: number,
			update: (agent: Agent, now: number) => Effect.Effect<Agent, Failure>,
		) =>
			records.transaction(
				"agent:" + caller.organizationId + ":" + id,
				Effect.gen(function* () {
					const agent = yield* access(caller, id, permission)
					if (agent.revision !== expected)
						return yield* AgentsApi.AgentConflict.make({
							message: "The Agent changed. Read it again and retry.",
						})
					const now = yield* Clock.currentTimeMillis
					const next = yield* update(agent, now)
					return yield* put(caller.organizationId, {
						...next,
						revision: agent.revision + 1,
						updatedAt: now,
					})
				}),
			)
		return Agents.of({
			ensureMain,
			find,
			access,
			list: (caller, input) =>
				Effect.gen(function* () {
					const main = yield* ensureMain(caller)
					const own = yield* agents.list(caller.organizationId, {
						owner: caller.userId,
						...(input.session === undefined ? {} : { scope: input.session }),
					})
					const shared =
						input.session === undefined
							? yield* agents.list(caller.organizationId, { owner: "" })
							: []
					const all = [
						...own.filter(
							(agent) =>
								agent.id !== main.id &&
								(input.session !== undefined || agent.kind !== "subagent"),
						),
						...shared,
					]
					const visible = yield* Effect.filter(all, (agent) =>
						can({
							caller,
							permission: "agents.read",
							key: agentKey({
								...agent,
								organizationId: caller.organizationId,
							}),
						}),
					)
					return [
						...(input.session === undefined ? [main] : []),
						...visible,
					].filter(
						(agent) =>
							input.archived === undefined || agent.archived === input.archived,
					)
				}),
			create: (caller, input) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const agent: Agent = {
						id: AgentsApi.AgentId.make(newId()),
						kind: "persistent",
						owner:
							input.shared === true
								? { _tag: "Organization" }
								: { _tag: "Member", userId: caller.userId },
						name: input.name,
						role: input.role,
						instructions: input.instructions,
						...(input.model === undefined ? {} : { model: input.model }),
						archived: false,
						revision: 0,
						createdAt: now,
						updatedAt: now,
					}
					const key = agentKey({
						...agent,
						organizationId: caller.organizationId,
					})
					if (!(yield* can({ caller, permission: "agents.write", key })))
						return yield* Permissions.PermissionDenied.make({
							permission: "agents.write",
							resource: key,
						})
					return yield* put(caller.organizationId, agent)
				}),
			createSubagent: (subject, input) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					return yield* put(subject.organizationId, {
						id: AgentsApi.AgentId.make(newId()),
						kind: "subagent",
						owner: {
							_tag: "Session",
							userId: subject.userId,
							session: input.session,
						},
						name: input.name,
						role: input.role,
						instructions: input.instructions,
						...(input.model === undefined ? {} : { model: input.model }),
						archived: false,
						revision: 0,
						createdAt: now,
						updatedAt: now,
					})
				}),
			update: (caller, id, input) =>
				change(caller, id, "agents.write", input.expected, (agent) => {
					if (agent.kind === "main" && input.archived === true)
						return Effect.fail(
							AgentsApi.AgentInvalid.make({
								message: "The Main Agent cannot be archived.",
							}),
						)
					const { model: _model, ...rest } = agent
					const model =
						input.model === undefined ? agent.model : (input.model ?? undefined)
					return Effect.succeed({
						...rest,
						...(input.name === undefined ? {} : { name: input.name }),
						...(input.role === undefined ? {} : { role: input.role }),
						...(input.instructions === undefined
							? {}
							: { instructions: input.instructions }),
						...(input.archived === undefined
							? {}
							: { archived: input.archived }),
						...(model === undefined ? {} : { model }),
					})
				}),
			promote: (caller, id, expected) =>
				change(caller, id, "agents.write", expected, (agent) =>
					agent.kind !== "subagent" || agent.owner._tag !== "Session"
						? Effect.fail(
								AgentsApi.AgentInvalid.make({
									message: "Only a subagent can be promoted.",
								}),
							)
						: Effect.succeed({
								...agent,
								kind: "persistent" as const,
								owner: { _tag: "Member" as const, userId: agent.owner.userId },
							}),
				),
			ownedBy: (subject, session) =>
				agents
					.list(subject.organizationId, {
						owner: subject.userId,
						scope: session,
					})
					.pipe(
						Effect.map((list) =>
							list.filter((agent) => agent.kind === "subagent"),
						),
					),
			archiveOwnedBy: (subject, session) =>
				Effect.gen(function* () {
					const owned = yield* agents.list(subject.organizationId, {
						owner: subject.userId,
						scope: session,
					})
					const now = yield* Clock.currentTimeMillis
					return yield* Effect.forEach(
						owned.filter(
							(agent) => agent.kind === "subagent" && !agent.archived,
						),
						(agent) =>
							put(subject.organizationId, {
								...agent,
								archived: true,
								revision: agent.revision + 1,
								updatedAt: now,
							}),
					)
				}),
			copyFor: (subject, agent, session) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					return yield* put(subject.organizationId, {
						...agent,
						id: AgentsApi.AgentId.make(newId()),
						owner: { _tag: "Session", userId: subject.userId, session },
						revision: 0,
						createdAt: now,
						updatedAt: now,
					})
				}),
		})
	})
export const layer = Layer.effect(Agents, make)

export type { AgentId }
