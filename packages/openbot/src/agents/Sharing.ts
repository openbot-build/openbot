import type { AgentsApi } from "@openbot-build/api"

/**
 * Only a lasting top Agent of its own organization can be shared: one that a member or
 * the organization owns, that is not archived, and that is not itself a linked Agent.
 * Above it there is only the person, so in another organization it works like their own Agent.
 */
export const shareable = (agent: AgentsApi.Agent) =>
	agent.kind === "persistent" &&
	!agent.archived &&
	agent.source === undefined &&
	(agent.owner._tag === "Member" || agent.owner._tag === "Organization")
