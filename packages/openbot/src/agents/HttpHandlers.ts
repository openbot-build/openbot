import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import {
	AgentsApi,
	type Caller,
	Identity,
	type OrganizationApi,
	OpenBotApi,
} from "@openbot-build/api"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Backend } from "../app/Backend.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { agentKey } from "../authorization/Policy.ts"
import { Grants } from "../capabilities/Grants.ts"
import { Rules } from "../capabilities/Rules.ts"
import { AgentMemories } from "./AgentMemories.ts"
import { Agents } from "./Agents.ts"

const unavailable = () => AgentsApi.AgentStorageUnavailable.make({})

export const layer = HttpApiBuilder.group(OpenBotApi, "agents", (handlers) =>
	Effect.gen(function* () {
		const agents = yield* Agents
		const memories = yield* AgentMemories
		const rules = yield* Rules
		const grants = yield* Grants
		const audit = yield* AuditLog
		const backend = yield* Backend
		const services = yield* Effect.context<AuthorizationServices>()
		const access = (
			caller: Caller,
			id: string,
			permission: "agents.read" | "agents.write",
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
							caller.organizationId,
							agent.id,
							row.session.id,
							memory,
						)
					}
					yield* record(caller, "agent.promoted", agent, {})
					return agent
				}),
			)
			.handle("agentMemory", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const agent = yield* access(caller, params.agentId, "agents.read")
					return yield* memories.get(caller.organizationId, agent.id)
				}),
			)
			.handle("updateAgentMemory", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const agent = yield* access(caller, params.agentId, "agents.write")
					const state = yield* memories.edit(
						caller.organizationId,
						agent.id,
						payload,
					)
					yield* record(caller, "agent.memory.updated", agent, {
						command: payload.command._tag,
						key: payload.command.key,
					})
					return state
				}),
			)
			.handle("agentMemoryLog", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const agent = yield* access(caller, params.agentId, "agents.read")
					return yield* memories.log(caller.organizationId, agent.id)
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
						...(payload.reason === undefined ? {} : { reason: payload.reason }),
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
	}),
)
