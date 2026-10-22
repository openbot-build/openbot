import { PlanApproval } from "@openbot-build/api"
import type { AgentsApi } from "@openbot-build/api"
import { Effect } from "effect"
import type { Settings } from "../../settings/Settings.ts"
import type * as SessionHost from "../../sessions/SessionHost.ts"

/**
 * How a plan in this Session is approved. The most specific setting wins:
 * the Session, then its Agent, then the member, then the organization.
 * A more specific setting may be looser than a less specific one.
 */
export const approvalFor = (input: {
	readonly settings: typeof Settings.Service
	readonly state: SessionHost.SessionHostState
	readonly agent: AgentsApi.Agent
}) =>
	Effect.gen(function* () {
		if (input.state.planApproval !== undefined) return input.state.planApproval
		if (input.agent.planApproval !== undefined) return input.agent.planApproval
		const settings = input.settings
		const member = yield* settings.member(
			input.state.chain.organizationId,
			input.state.chain.userId,
		)
		if (member.document.planApproval !== null)
			return member.document.planApproval
		const organization = yield* settings.organization(
			input.state.chain.organizationId,
		)
		return organization.document.planApproval
	}).pipe(
		// Without the settings, the plan waits for the decider above, and stays a plan.
		Effect.orElseSucceed(() => PlanApproval.defaults),
	)
