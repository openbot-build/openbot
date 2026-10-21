import { AgentsApi } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import * as AgentLayers from "../src/agents/AgentLayers.ts"
import * as Judge from "../src/capabilities/Judge.ts"

/** A Main Agent for tests that use Sessions without the Agent services. */
export const agent: AgentsApi.Agent = {
	id: AgentsApi.AgentId.make("agt_test"),
	kind: "main",
	owner: { _tag: "Member", userId: "test-user" },
	name: "Main",
	role: "Main Agent",
	instructions: "",
	archived: false,
	revision: 0,
	createdAt: 0,
	updatedAt: 0,
}

/** What a direct Session needs, for the test agent and member. */
export const direct = (
	member: { readonly organizationId?: string; readonly userId?: string } = {},
) => ({
	agent,
	kind: "direct" as const,
	chain: {
		organizationId: member.organizationId ?? "test-organization",
		userId: member.userId ?? "test-user",
		agents: [agent.id],
		sessions: [],
	},
})

/** A helper model that is not there. The judge then answers no_match, and memory learns nothing. */
export const layerNoHelper = Layer.succeed(Judge.HelperModel, {
	model: () =>
		Effect.fail(
			new Judge.HelperModelUnavailable({
				message: "No helper model in this test.",
			}),
		),
})

/** The Agent services for tests that serve the HTTP API without a coordinator. */
export const layerAgentServices = AgentLayers.layer({ helper: layerNoHelper })
