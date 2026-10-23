import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import {
	Account,
	AgentsApi,
	type Caller,
	Identity,
	OrganizationApi,
	OpenBotApi,
} from "@openbot-build/api"
import { Effect, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Backend } from "../app/Backend.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { agentKey } from "../authorization/Policy.ts"
import { Grants } from "../capabilities/Grants.ts"
import { Rules } from "../capabilities/Rules.ts"
import { AgentMemories, homeOf } from "./AgentMemories.ts"
import { MemoryAgent } from "./MemoryAgent.ts"
import { Organization } from "../organization/Organization.ts"
import { Agents } from "./Agents.ts"
import * as InvitationLinks from "./InvitationLinks.ts"
import { shareable } from "./Sharing.ts"

const unavailable = () => AgentsApi.AgentStorageUnavailable.make({})

export const layer = (publicOrigin: string) =>
	HttpApiBuilder.group(OpenBotApi, "agents", (handlers) =>
		Effect.gen(function* () {
			const agents = yield* Agents
			const memories = yield* AgentMemories
			const memoryAgent = yield* MemoryAgent
			const rules = yield* Rules
			const grants = yield* Grants
			const audit = yield* AuditLog
			const backend = yield* Backend
			const organization = yield* Organization
			const services = yield* Effect.context<
				AuthorizationServices | Effect.Services<typeof InvitationLinks.make>
			>()
			const access = (
				caller: Caller,
				id: string,
				permission: "agents.read" | "agents.write" | "agents.share",
			) =>
				agents
					.access(caller, id, permission)
					.pipe(Effect.provideContext(services))
			const record = (
				caller: Caller,
				action: OrganizationApi.AuditAction,
				agent: AgentsApi.Agent,
				details: Schema.JsonObject,
			) =>
				audit
					.record({
						organizationId: caller.organizationId,
						action,
						actor: caller,
						resource: agentKey({
							...agent,
							organizationId: caller.organizationId,
						}),
						details,
					})
					.pipe(Effect.mapError(unavailable))
			/**
			 * The memory pool of an Agent, as the caller sees it. Each person reads only the
			 * entries for them, in their own organization. Nobody reads another person's memory.
			 */
			const memoryOf = (caller: Caller, id: string) =>
				Effect.gen(function* () {
					const agent = yield* access(caller, id, "agents.read")
					return {
						agent,
						home: homeOf(caller.organizationId, agent),
						viewer: {
							organizationId: caller.organizationId,
							person: caller.userId,
						},
					}
				})
			/** The memory Agent and the purge belong to the people of the Agent, not to its members. */
			const ownMemory = (caller: Caller, id: string) =>
				Effect.gen(function* () {
					const agent = yield* access(caller, id, "agents.write")
					if (agent.source !== undefined)
						return yield* AgentsApi.AgentInvalid.make({
							message:
								"This Agent is shared with you. Only its own people manage its memory.",
						})
					return { agent, home: homeOf(caller.organizationId, agent) }
				})
			return handlers
				.handle("listAgents", ({ query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						return yield* agents
							.list(caller, {
								...(query.archived === undefined
									? {}
									: { archived: query.archived === "true" }),
								...(query.session === undefined
									? {}
									: { session: query.session }),
								...(query.agent === undefined ? {} : { agent: query.agent }),
							})
							.pipe(Effect.provideContext(services))
					}),
				)
				.handle("createAgent", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* agents
							.create(caller, payload)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "agent.created", agent, {
							name: agent.name,
							shared: agent.owner._tag === "Organization",
						})
						return agent
					}),
				)
				.handle("getAgent", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						access(caller, params.agentId, "agents.read"),
					),
				)
				.handle("updateAgent", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* agents
							.update(caller, params.agentId, payload)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "agent.updated", agent, {
							revision: agent.revision,
						})
						return agent
					}),
				)
				.handle("promoteAgent", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* agents
							.promote(caller, params.agentId, payload.expected, payload.agent)
							.pipe(Effect.provideContext(services))
						// The memory of its delegated Sessions becomes its long-term memory.
						const sessions = yield* backend
							.forCaller(caller)
							.pipe(Effect.mapError(unavailable))
						const worked = yield* sessions
							.list({ agent: agent.id, kind: "delegated" })
							.pipe(Effect.mapError(unavailable))
						for (const row of worked) {
							const memory = yield* sessions
								.memory(row.session.id)
								.pipe(Effect.mapError(unavailable))
							yield* memories.adopt(
								homeOf(caller.organizationId, agent),
								{
									userId: caller.userId,
									organizationId: caller.organizationId,
								},
								row.session.id,
								memory,
							)
						}
						yield* record(caller, "agent.promoted", agent, {})
						return agent
					}),
				)
				.handle("agentMemory", ({ params, query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { home, viewer } = yield* memoryOf(caller, params.agentId)
						const tags =
							query.tags === undefined
								? []
								: query.tags
										.split(",")
										.map((tag) => tag.trim())
										.filter((tag) => tag.length > 0)
						return yield* memories.view(home, viewer, tags)
					}),
				)
				.handle("updateAgentMemory", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { agent, home } = yield* memoryOf(caller, params.agentId)
						const view = yield* memories.edit(
							home,
							{ userId: caller.userId, organizationId: caller.organizationId },
							payload.command,
						)
						yield* record(caller, "agent.memory.updated", agent, {
							command: payload.command._tag,
							...(payload.command._tag === "Forget"
								? { id: payload.command.id }
								: {}),
						})
						return view
					}),
				)
				.handle("agentMemoryLog", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { home, viewer } = yield* memoryOf(caller, params.agentId)
						return yield* memories.log(home, viewer)
					}),
				)
				.handle("purgeAgentMemory", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { agent, home } = yield* ownMemory(caller, params.agentId)
						const removed = yield* memories.purge(home, payload.tag)
						yield* record(caller, "agent.memory.purged", agent, {
							tag: payload.tag,
							removed,
						})
						return { removed }
					}),
				)
				.handle("memoryAgent", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { home } = yield* ownMemory(caller, params.agentId)
						return yield* memoryAgent.settings(home)
					}),
				)
				.handle("updateMemoryAgent", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { agent, home } = yield* ownMemory(caller, params.agentId)
						const settings = yield* memoryAgent.update(home, payload)
						yield* record(caller, "agent.memory_agent.updated", agent, {
							revision: settings.revision,
						})
						return settings
					}),
				)
				.handle("listRules", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.read")
						return yield* rules.list(caller.organizationId, agent.id)
					}),
				)
				.handle("createRule", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.write")
						const rule = yield* rules.create(caller.organizationId, {
							agent: agent.id,
							author: { _tag: "Person", userId: caller.userId },
							text: payload.text,
							status: "active",
						})
						yield* record(caller, "rule.created", agent, { rule: rule.id })
						return rule
					}),
				)
				.handle("updateRule", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.write")
						const rule = yield* rules.update(
							caller.organizationId,
							agent.id,
							params.ruleId,
							payload,
						)
						yield* record(caller, "rule.updated", agent, {
							rule: rule.id,
							status: rule.status,
							version: rule.version,
						})
						return rule
					}),
				)
				.handle("listGrants", ({ params, query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.read")
						return yield* grants.list(
							caller.organizationId,
							agent.id,
							query.status,
						)
					}),
				)
				.handle("createGrant", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.write")
						if (payload.scope === "session")
							return yield* AgentsApi.AgentInvalid.make({
								message:
									"A person gives a Session Grant by answering a request in that Session.",
							})
						const grant = yield* grants.create(caller.organizationId, {
							agent: agent.id,
							capability: payload.capability,
							effect: payload.effect,
							scope: payload.scope,
							grantedBy: { _tag: "Person", userId: caller.userId },
							...(payload.reason === undefined
								? {}
								: { reason: payload.reason }),
						})
						yield* record(caller, "grant.created", agent, {
							grant: grant.id,
							effect: grant.effect,
						})
						return grant
					}),
				)
				.handle("revokeGrant", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.write")
						const revoked = yield* grants.revoke(
							caller.organizationId,
							agent.id,
							params.grantId,
						)
						yield* record(caller, "grant.revoked", agent, {
							grants: revoked.map((grant) => grant.id),
						})
					}),
				)
				.handle("listAgentMembers", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.share")
						return yield* agents.members(caller.organizationId, agent.id)
					}),
				)
				.handle("removeAgentMember", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.share")
						const removed = yield* agents.removeMember(
							caller.organizationId,
							agent.id,
							params.userId,
						)
						if (!removed)
							return yield* AgentsApi.AgentNotFound.make({ agent: agent.id })
						yield* record(caller, "agent_member.removed", agent, {
							userId: params.userId,
						})
					}),
				)
				.handle("createAgentInvitation", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.share")
						if (!shareable(agent))
							return yield* AgentsApi.AgentInvalid.make({
								message:
									"Only a lasting top Agent of this organization that is not archived can be shared.",
							})
						const made =
							payload.email === undefined
								? Option.some(
										yield* InvitationLinks.make.pipe(
											Effect.provideContext(services),
											Effect.mapError(unavailable),
										),
									)
								: Option.none()
						const invitation = yield* organization
							.createAgentInvitation({
								organizationId: caller.organizationId,
								agent: { id: agent.id, name: agent.name },
								invitedBy: caller.userId,
								...(payload.email === undefined
									? {}
									: { email: payload.email }),
								...(payload.expiresAt === undefined
									? {}
									: { expiresAt: payload.expiresAt }),
								...(payload.path === undefined ? {} : { path: payload.path }),
								...Option.match(made, {
									onNone: () => ({}),
									onSome: (made) => ({ link: made.link }),
								}),
							})
							.pipe(
								Effect.mapError((error) =>
									error._tag === "OrganizationUnavailable"
										? unavailable()
										: error,
								),
							)
						yield* record(caller, "invitation.created", agent, {
							invitationId: invitation.id,
							target: "agent",
							...(invitation.email === null ? {} : { email: invitation.email }),
						})
						const secret = Option.match(made, {
							onNone: () => null,
							onSome: (made) => made.secret,
						})
						return {
							invitation,
							secret,
							url: InvitationLinks.urlOf(publicOrigin, invitation.path, secret),
						}
					}),
				)
				.handle("listAgentInvitations", ({ params, query }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.share")
						return yield* organization
							.listAgentInvitations(
								caller.organizationId,
								agent.id,
								query.status,
							)
							.pipe(Effect.mapError(unavailable))
					}),
				)
				.handle("agentInvitationSecret", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.share")
						const { invitation, link } = yield* organization
							.agentInvitation(
								caller.organizationId,
								agent.id,
								params.invitationId,
							)
							.pipe(
								Effect.mapError((error) =>
									error._tag === "OrganizationUnavailable"
										? unavailable()
										: error,
								),
							)
						const secret =
							link === null
								? null
								: yield* InvitationLinks.open(link).pipe(
										Effect.provideContext(services),
										Effect.mapError(unavailable),
									)
						return {
							invitation,
							secret,
							url: InvitationLinks.urlOf(publicOrigin, invitation.path, secret),
						}
					}),
				)
				.handle("revokeAgentInvitation", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const agent = yield* access(caller, params.agentId, "agents.share")
						const invitation = yield* organization
							.revokeAgentInvitation(
								caller.organizationId,
								agent.id,
								params.invitationId,
							)
							.pipe(
								Effect.mapError((error) =>
									error._tag === "OrganizationUnavailable"
										? unavailable()
										: error,
								),
							)
						yield* record(caller, "invitation.revoked", agent, {
							invitationId: invitation.id,
							target: "agent",
						})
					}),
				)
		}),
	)

/** A person accepts an invitation to use an Agent, in an organization of their own. */
export const layerInvitations = HttpApiBuilder.group(
	OpenBotApi,
	"agentInvitations",
	(handlers) =>
		Effect.gen(function* () {
			const agents = yield* Agents
			const organization = yield* Organization
			const audit = yield* AuditLog
			const services = yield* Effect.context<AuthorizationServices>()
			const invalid = (message: string) =>
				OrganizationApi.InvitationInvalid.make({ message })
			return handlers.handle("acceptAgentInvitation", ({ payload }) =>
				Effect.gen(function* () {
					const account = yield* Account
					const by =
						payload.invitation !== undefined
							? ({ _tag: "Email", invitationId: payload.invitation } as const)
							: payload.secret !== undefined
								? ({
										_tag: "Link",
										secretHash: InvitationLinks.hashOf(payload.secret),
									} as const)
								: undefined
					if (by === undefined)
						return yield* invalid("Send `invitation` or `secret`.")
					// The organization where the person uses the Agent. They name it, a user
					// token names it, or it is their only organization.
					const memberships = yield* organization
						.memberships(account.userId)
						.pipe(Effect.mapError(unavailable))
					const chosen =
						payload.organization ??
						account.organizationId ??
						(memberships.length === 1
							? memberships[0]?.organizationId
							: undefined)
					if (chosen === undefined)
						return yield* invalid(
							"Name the organization where you use the Agent in `organization`.",
						)
					const active = yield* organization
						.activeMember(chosen, account.userId)
						.pipe(Effect.mapError(unavailable))
					if (Option.isNone(active))
						return yield* invalid(
							"You must be an active member of the organization where you use the Agent.",
						)
					const taken = yield* organization
						.takeAgentInvitation(account.userId, by)
						.pipe(
							Effect.mapError((error) =>
								error._tag === "OrganizationUnavailable"
									? unavailable()
									: error,
							),
						)
					const source = yield* agents.find(taken.organizationId, taken.agent)
					if (Option.isNone(source) || !shareable(source.value))
						return yield* invalid("This Agent is not shared any more.")
					const caller: Caller = {
						kind: "member",
						organizationId: chosen,
						userId: account.userId,
					}
					const linked = yield* agents
						.link(caller, {
							organizationId: taken.organizationId,
							agent: source.value,
						})
						.pipe(Effect.provideContext(services))
					const actor: Caller = {
						kind: "member",
						organizationId: taken.organizationId,
						userId: account.userId,
					}
					yield* audit
						.record({
							organizationId: taken.organizationId,
							action: "agent_member.joined",
							actor,
							resource: agentKey({
								...source.value,
								organizationId: taken.organizationId,
							}),
							details: {
								invitationId: taken.invitationId,
								organizationId: chosen,
							},
						})
						.pipe(Effect.mapError(unavailable))
					return linked
				}),
			)
		}),
)
