import type { Capability } from "@openbot-build/domain/Bots"
import type { LimitControl } from "@openbot-build/domain/Delegations"
import { type AppCalls, type Execution } from "@openbot-build/domain"
import type {
	Bots as BotsApi,
	Computers as ComputersApi,
} from "@openbot-build/domain"
import type { CodeRuns as CodeDomain } from "@openbot-build/domain"
import { Context, Data, type Effect, type Option } from "effect"
import type { Ask } from "./Requests.ts"
import { Work } from "./Work.ts"
import { type Fence } from "@openbot-build/server-execution/Store"

/**
 * What a tool call does after the check. `Allow` runs it now. `Deny` does not run it,
 * and the Bot gets the reason. `Pending` waits for a decider: the Bot goes on at once,
 * and the answer comes back to its Chat later.
 */
export type Answer = Data.TaggedEnum<{
	Allow: {}
	Deny: { readonly request?: string; readonly reason: string }
	Pending: { readonly request: string; readonly executionId?: Execution.Id }
}>

export const Answer = Data.taggedEnum<Answer>()

export interface Attempt {
	readonly capability: Capability
	/** Why the Bot wants it, in its own words. */
	readonly reason: string
	readonly site: Execution.CallSite
	/** The target Bot, for actions on a Bot. */
	readonly target?: BotsApi.Bot
	/** The owner of the target Computer or Computer provider, for actions on Computers. */
	readonly computerOwner?: ComputersApi.ComputerOwner
	/** The deployment owner allows this without asking, for example a read-only App tool. */
	readonly implicit?: boolean
	readonly app?: AppCalls.Invocation
	/** The Code Mode program that makes the call. Deciders see it with the request. */
	readonly code?: CodeDomain.RequestCode
	/** How the request waits, when the attempt needs one. */
	readonly ask?: Ask
}

/**
 * Checks each attempt of a Bot to use a capability. Bots have no limits that they know of.
 * The steps are: the policy of the member, Grants, Rules with the judge, and then a request
 * to the decider above the Bot. The Grants of a Bot are an ability policy, see `Policy.ts`.
 */
export class Gate extends Context.Service<
	Gate,
	{
		/**
		 * A failed check denies the call. If its answer cannot be kept, the current
		 * scope stops, so approval cannot fall back to another policy.
		 */
		readonly check: (attempt: Attempt) => Effect.Effect<Answer>
		/** Keep a tool's own denial for the approval callback of this call. */
		readonly remember: (callId: string, answer: Answer) => Effect.Effect<void>
		/** Read only the answer for the current saved call occurrence. */
		readonly answer: (callId: string) => Effect.Effect<Option.Option<Answer>>
	}
>()("@openbot-build/conversation-contract/capabilities/Gate") {}

/** Bound before tool approval checks, so a model cannot choose an execution or actor. */
export type Frame = Pick<typeof Work.Service, "identity" | "chat" | "turn">

/**
 * Makes the Gate of one execution. The Gate checks the attempts of the Bot that
 * runs in `work`, and keeps its answers with the execution of `fence`.
 */
export class Gates extends Context.Service<
	Gates,
	{
		readonly durable: (
			fence: Fence,
			work: Frame,
			continuation?: "chat" | "workflow",
			control?: LimitControl,
		) => Effect.Effect<Gate["Service"]>
	}
>()("@openbot-build/conversation-contract/capabilities/Gate/Gates") {}
