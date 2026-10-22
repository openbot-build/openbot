import { randomUUID } from "node:crypto"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import type { Config, Session } from "@openbot-build/core"
import { AgentsApi, type Caller, Permissions } from "@openbot-build/api"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { can } from "../authorization/Check.ts"
import { agentKey, rootOf } from "../authorization/Policy.ts"
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
	"You are the Main Agent of one person. You act for them. Do simple work yourself. When work needs a special skill or a long effort, give it to one of the person's other Agents with the delegate tool, or start a Session Agent for it. Write a clear brief, and always pass the person's own words unchanged. Read the results, check them, and tell the person what was done."

export const newId = () => "agt_" + randomUUID().replaceAll("-", "")

/** The Agents of an organization: the Main Agents, other lasting Agents and Session Agents. */
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
			input: {
				readonly archived?: boolean
				readonly session?: Session.Id
				readonly agent?: AgentId
			},
		) => Effect.Effect<ReadonlyArray<Agent>, Failure, AuthorizationServices>
		readonly create: (
			caller: Caller,
			input: AgentsApi.CreateAgentRequest,
		) => Effect.Effect<Agent, Failure, AuthorizationServices>
		/**
		 * Makes a lasting Agent that another Agent owns. An Agent uses it with a tool.
		 * The capability gate checks it first, so it checks no permission itself.
		 */
		readonly createOwned: (
			organizationId: string,
			owner: Agent,
			input: {
				readonly name: string
				readonly role: string
				readonly instructions: string
				readonly model?: Config.Selection
			},
		) => Effect.Effect<Agent, AgentsApi.AgentStorageUnavailable>
		/** Makes a Session Agent. The Session owns it, and it lives as long as the Session. */
		readonly createSessionAgent: (
			subject: Subject,
			input: {
				readonly session: Session.Id
				/** The Agent of the Session. */
				readonly agent: AgentId
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
		/**
		 * Makes a Session Agent a lasting Agent.
		 * The owner is the Agent `owner`, or the member of its Session without it.
		 */
		readonly promote: (
			caller: Caller,
			id: string,
			expected: number,
			owner?: AgentId,
		) => Effect.Effect<Agent, Failure, AuthorizationServices>
		/**
		 * The deciders of an Agent: its owner chain from the top, ending with the Agent.
		 * The top is the Main Agent of a member. Archived Agents are left out.
		 * `subject` is the member who works with the Agent now.
		 */
		readonly ownerChain: (
			subject: Subject,
			agent: Agent,
		) => Effect.Effect<
			ReadonlyArray<AgentId>,
			AgentsApi.AgentStorageUnavailable
		>
		/** The Session Agents that a Session owns. */
		readonly ownedBy: (
			subject: Subject,
			session: Session.Id,
		) => Effect.Effect<ReadonlyArray<Agent>, AgentsApi.AgentStorageUnavailable>
		/**
		 * Archives the Session Agents of a Session, for example when the Session goes away.
		 * The Agents that they own are archived too.
		 */
		readonly archiveOwnedBy: (
			subject: Subject,
			session: Session.Id,
		) => Effect.Effect<ReadonlyArray<Agent>, AgentsApi.AgentStorageUnavailable>
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
	owner: rootOf(agent.owner) ?? "",
	scope:
		agent.owner._tag === "Session"
			? agent.owner.session
			: agent.owner._tag === "Agent"
				? agent.owner.agent
				: "",
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
			update: (
				agent: Agent,
				now: number,
			) => Effect.Effect<Agent, Failure, AuthorizationServices>,
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
		const visible = (caller: Caller, list: ReadonlyArray<Agent>) =>
			Effect.filter(list, (agent) =>
				can({
					caller,
					permission: "agents.read",
					key: agentKey({ ...agent, organizationId: caller.organizationId }),
				}),
			)
		/** Archives Agents and every Agent below them in the owner tree. */
		const archiveTree = (
			organizationId: string,
			list: ReadonlyArray<Agent>,
			now: number,
		): Effect.Effect<ReadonlyArray<Agent>, AgentsApi.AgentStorageUnavailable> =>
			Effect.gen(function* () {
				if (list.length === 0) return []
				const archived = yield* Effect.forEach(list, (agent) =>
					agent.archived
						? Effect.succeed(agent)
						: put(organizationId, {
								...agent,
								archived: true,
								revision: agent.revision + 1,
								updatedAt: now,
							}),
				)
				const below = yield* Effect.forEach(list, (agent) =>
					agents.list(organizationId, { scope: agent.id }),
				)
				return [
					...archived,
					...(yield* archiveTree(
						organizationId,
						below.flat().filter((agent) => agent.owner._tag === "Agent"),
						now,
					)),
				]
			})
		/** The Agent that decides above an Agent, or none for a Main Agent. */
		const above = (subject: Subject, agent: Agent) => {
			switch (agent.owner._tag) {
				case "Agent":
				case "Session":
					return find(subject.organizationId, agent.owner.agent)
				case "Member":
					return agent.kind === "main"
						? Effect.succeedNone
						: ensureMain({
								organizationId: subject.organizationId,
								userId: agent.owner.userId,
							}).pipe(Effect.asSome)
				case "Organization":
					return ensureMain(subject).pipe(Effect.asSome)
			}
		}
		const climb = (
			subject: Subject,
			from: Agent,
			chain: ReadonlyArray<AgentId>,
			seen: ReadonlyArray<AgentId>,
		): Effect.Effect<
			ReadonlyArray<AgentId>,
			AgentsApi.AgentStorageUnavailable
		> =>
			above(subject, from).pipe(
				Effect.flatMap((next) => {
					// A loop can only come from broken records. It must not hang the work.
					if (Option.isNone(next) || seen.includes(next.value.id))
						return Effect.succeed(chain)
					const agent = next.value
					return climb(
						subject,
						agent,
						agent.archived ? chain : [agent.id, ...chain],
						[...seen, agent.id],
					)
				}),
			)
		/** The owner of an Agent that the Agent `owner` owns. */
		const ownerFor = (owner: Agent): Agent["owner"] => ({
			_tag: "Agent",
			agent: owner.id,
			userId: rootOf(owner.owner),
		})
		const fresh = (input: {
			readonly owner: Agent["owner"]
			readonly name: string
			readonly role: string
			readonly instructions: string
			readonly model?: Config.Selection
			readonly planApproval?: AgentsApi.Agent["planApproval"]
			readonly kind: "persistent" | "session"
			readonly now: number
		}): Agent => ({
			id: AgentsApi.AgentId.make(newId()),
			kind: input.kind,
			owner: input.owner,
			name: input.name,
			role: input.role,
			instructions: input.instructions,
			...(input.model === undefined ? {} : { model: input.model }),
			...(input.planApproval === undefined
				? {}
				: { planApproval: input.planApproval }),
			archived: false,
			revision: 0,
			createdAt: input.now,
			updatedAt: input.now,
		})
		const writable = (caller: Caller, agent: Agent) =>
			Effect.gen(function* () {
				const key = agentKey({
					...agent,
					organizationId: caller.organizationId,
				})
				if (!(yield* can({ caller, permission: "agents.write", key })))
					return yield* Permissions.PermissionDenied.make({
						permission: "agents.write",
						resource: key,
					})
			})
		return Agents.of({
			ensureMain,
			find,
			access,
			list: (caller, input) =>
				Effect.gen(function* () {
					if (input.agent !== undefined) {
						yield* access(caller, input.agent, "agents.read")
						const below = yield* agents.list(caller.organizationId, {
							scope: input.agent,
						})
						return (yield* visible(
							caller,
							below.filter((agent) => agent.owner._tag === "Agent"),
						)).filter(
							(agent) =>
								input.archived === undefined ||
								agent.archived === input.archived,
						)
					}
					const main = yield* ensureMain(caller)
					const own = yield* agents.list(caller.organizationId, {
						owner: caller.userId,
						...(input.session === undefined ? {} : { scope: input.session }),
					})
					const shared =
						input.session === undefined
							? yield* agents.list(caller.organizationId, { owner: "" })
							: []
					const all = yield* visible(caller, [
						...own.filter(
							(agent) =>
								agent.id !== main.id &&
								(input.session !== undefined || agent.kind !== "session"),
						),
						...shared,
					])
					return [
						...(input.session === undefined ? [main] : []),
						...all,
					].filter(
						(agent) =>
							input.archived === undefined || agent.archived === input.archived,
					)
				}),
			create: (caller, input) =>
				Effect.gen(function* () {
					if (input.shared === true && input.agent !== undefined)
						return yield* AgentsApi.AgentInvalid.make({
							message: "A shared Agent cannot have an owner Agent.",
						})
					const owner: Agent["owner"] =
						input.agent !== undefined
							? ownerFor(yield* access(caller, input.agent, "agents.read"))
							: input.shared === true
								? { _tag: "Organization" }
								: { _tag: "Member", userId: caller.userId }
					const agent = fresh({
						...input,
						owner,
						kind: "persistent",
						now: yield* Clock.currentTimeMillis,
					})
					yield* writable(caller, agent)
					return yield* put(caller.organizationId, agent)
				}),
			createOwned: (organizationId, owner, input) =>
				Effect.gen(function* () {
					return yield* put(
						organizationId,
						fresh({
							...input,
							owner: ownerFor(owner),
							kind: "persistent",
							now: yield* Clock.currentTimeMillis,
						}),
					)
				}),
			createSessionAgent: (subject, input) =>
				Effect.gen(function* () {
					return yield* put(
						subject.organizationId,
						fresh({
							...input,
							owner: {
								_tag: "Session",
								userId: subject.userId,
								session: input.session,
								agent: input.agent,
							},
							kind: "session",
							now: yield* Clock.currentTimeMillis,
						}),
					)
				}),
			update: (caller, id, input) =>
				Effect.gen(function* () {
					const agent = yield* change(
						caller,
						id,
						"agents.write",
						input.expected,
						(agent) => {
							if (agent.kind === "main" && input.archived === true)
								return Effect.fail(
									AgentsApi.AgentInvalid.make({
										message: "The Main Agent cannot be archived.",
									}),
								)
							const { model: _model, planApproval: _approval, ...rest } = agent
							const model =
								input.model === undefined
									? agent.model
									: (input.model ?? undefined)
							// A `null` makes the Agent follow the settings of the member again.
							const planApproval =
								input.planApproval === undefined
									? agent.planApproval
									: (input.planApproval ?? undefined)
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
								...(planApproval === undefined ? {} : { planApproval }),
							})
						},
					)
					// The Agents that an archived Agent owns are archived with it.
					if (input.archived === true)
						yield* archiveTree(caller.organizationId, [agent], agent.updatedAt)
					return agent
				}),
			promote: (caller, id, expected, owner) =>
				Effect.gen(function* () {
					const parent =
						owner === undefined
							? Option.none<Agent>()
							: Option.some(yield* access(caller, owner, "agents.read"))
					const agent = yield* change(
						caller,
						id,
						"agents.write",
						expected,
						(agent) => {
							const from = agent.owner
							return agent.kind !== "session" || from._tag !== "Session"
								? Effect.fail(
										AgentsApi.AgentInvalid.make({
											message: "Only a Session Agent can be promoted.",
										}),
									)
								: Effect.gen(function* () {
										const next: Agent = {
											...agent,
											kind: "persistent",
											owner: Option.match(parent, {
												onNone: () => ({
													_tag: "Member" as const,
													userId: from.userId,
												}),
												onSome: ownerFor,
											}),
										}
										// The new owner can move the Agent to another place.
										yield* writable(caller, next)
										return next
									})
						},
					)
					return agent
				}),
			ownerChain: (subject, agent) =>
				climb(subject, agent, [agent.id], [agent.id]),
			ownedBy: (subject, session) =>
				agents
					.list(subject.organizationId, {
						owner: subject.userId,
						scope: session,
					})
					.pipe(
						Effect.map((list) =>
							list.filter((agent) => agent.kind === "session"),
						),
					),
			archiveOwnedBy: (subject, session) =>
				Effect.gen(function* () {
					const owned = yield* agents.list(subject.organizationId, {
						owner: subject.userId,
						scope: session,
					})
					return yield* archiveTree(
						subject.organizationId,
						owned.filter(
							(agent) => agent.kind === "session" && !agent.archived,
						),
						yield* Clock.currentTimeMillis,
					)
				}),
		})
	})
export const layer = Layer.effect(Agents, make)

export type { AgentId }
