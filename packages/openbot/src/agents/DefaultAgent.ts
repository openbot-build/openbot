import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { AgentsApi, type Caller } from "@openbot-build/api"
import { Effect } from "effect"
import { Settings } from "../settings/Settings.ts"
import { Agents, type Failure } from "./Agents.ts"

/** The services that the default Agent needs. */
export type Services = Agents | Settings

/**
 * Checks that the caller can make an Agent their default Agent.
 * It must be a lasting top Agent: one of the caller's own, or a shared one.
 * The caller must be able to give it work.
 */
export const check = (
	caller: Caller,
	id: string,
): Effect.Effect<AgentsApi.Agent, Failure, Agents | AuthorizationServices> =>
	Effect.gen(function* () {
		const agents = yield* Agents
		const agent = yield* agents.access(caller, id, "agents.delegate")
		const top =
			agent.owner._tag === "Organization" ||
			(agent.owner._tag === "Member" && agent.owner.userId === caller.userId)
		if (agent.kind !== "persistent" || !top)
			return yield* AgentsApi.AgentInvalid.make({
				message:
					"A default Agent must be one of your own top Agents or a shared Agent.",
			})
		if (agent.archived)
			return yield* AgentsApi.AgentInvalid.make({
				message: "An archived Agent cannot be your default Agent.",
			})
		return agent
	})

/** The default Agent of the caller, from their member settings. */
export const resolve = (
	caller: Caller,
): Effect.Effect<AgentsApi.Agent, Failure, Services | AuthorizationServices> =>
	Effect.gen(function* () {
		const settings = yield* Settings
		const { document } = yield* settings
			.member(caller.organizationId, caller.userId)
			.pipe(Effect.mapError(() => AgentsApi.AgentStorageUnavailable.make({})))
		const id = document.defaultAgent ?? null
		if (id === null)
			return yield* AgentsApi.AgentInvalid.make({
				message:
					"You have no default Agent. Name an Agent, or set a default Agent in your settings.",
			})
		return yield* check(caller, id)
	})
