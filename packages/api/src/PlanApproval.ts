import { Schema } from "effect"

/** How long a plan waits for an answer: 1 second to 7 days, in milliseconds. */
export const Timeout = Schema.Int.check(
	Schema.isBetween({ minimum: 1000, maximum: 7 * 24 * 60 * 60 * 1000 }),
)

/**
 * What happens when a Bot in plan mode asks to carry out its plan.
 * `approver`: `chain` asks the decider above the Bot, like any capability, so a Grant
 * or a Rule can answer. `person` always asks the person that the work is for.
 * `onTimeout`: when nobody answers in time, `run` carries out the plan, and `stay`
 * keeps the Chat in plan mode.
 *
 * It can be set for a Chat, a Bot, a member and the organization. The most specific
 * one that is set wins, so a person can make it looser for one Bot or one Chat.
 */
export const PlanApproval = Schema.Struct({
	approver: Schema.Literals(["chain", "person"]),
	timeoutMs: Timeout,
	onTimeout: Schema.Literals(["run", "stay"]),
})
export type PlanApproval = typeof PlanApproval.Type

/** A plan waits for the decider above the Bot for one day, and then stays a plan. */
export const defaults: PlanApproval = {
	approver: "chain",
	timeoutMs: 24 * 60 * 60 * 1000,
	onTimeout: "stay",
}
