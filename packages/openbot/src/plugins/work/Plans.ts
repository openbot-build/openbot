import { PlanApproval } from "@openbot-build/api"
import type { BotsApi } from "@openbot-build/api"
import { Effect } from "effect"
import type { Settings } from "../../settings/Settings.ts"
import type * as ChatHost from "../../chats/ChatHost.ts"

/**
 * How a plan in this Chat is approved. The most specific setting wins:
 * the Chat, then its Bot, then the member, then the organization.
 * A more specific setting may be looser than a less specific one.
 */
export const approvalFor = (input: {
	readonly settings: typeof Settings.Service
	readonly state: ChatHost.ChatHostState
	/** Who the current Turn works for. Their own setting counts, not the owner's. */
	readonly chain: ChatHost.Chain
	readonly bot: BotsApi.Bot
}) =>
	Effect.gen(function* () {
		if (input.state.planApproval !== undefined) return input.state.planApproval
		if (input.bot.planApproval !== undefined) return input.bot.planApproval
		const settings = input.settings
		const member = yield* settings.member(
			input.chain.organizationId,
			input.chain.userId,
		)
		if (member.document.planApproval !== null)
			return member.document.planApproval
		const organization = yield* settings.organization(
			input.chain.organizationId,
		)
		return organization.document.planApproval
	}).pipe(
		// Without the settings, the plan waits for the decider above, and stays a plan.
		Effect.orElseSucceed(() => PlanApproval.defaults),
	)
