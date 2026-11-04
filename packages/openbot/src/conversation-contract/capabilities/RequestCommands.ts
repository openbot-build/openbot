import {
	type MemberExecution,
	type Key,
	type Fence,
} from "../../server-execution/execution/Store.ts"
import * as PolicyOrigin from "./PolicyOrigin.ts"
import {
	Bots as BotDomain,
	Caller,
	Execution,
	Requests as RequestDomain,
} from "@openbot-build/domain"
import { Context, Effect, Option, Schema } from "effect"
import {
	type Authorize,
	type DecisionCommand,
} from "../../server-execution/execution/Engine.ts"
import { Stored } from "./Requests.ts"

export const workflowName = "openbot.capability-request"

export const Continuation = Schema.Literals(["chat", "workflow"])

/** Data for the domain change stays in the sealed command record. */
export const Details = Schema.Struct({
	scope: Schema.optionalKey(BotDomain.GrantScope),
	reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
	rule: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
	),
})

/** The saved Turn supplies identity and the Bot owner chain. */
export const Input = Schema.Struct({
	control: Schema.optionalKey(PolicyOrigin.Control),
	/** A workflow consumes its own result. Other requests send a Chat reply. */
	continuation: Continuation,
	capability: RequestDomain.CapabilityRequest.fields.capability,
	reason: Schema.String,
	toolCallId: Schema.String,
	app: RequestDomain.CapabilityRequest.fields.app,
	code: RequestDomain.CapabilityRequest.fields.code,
	call: Stored.fields.call,
	ask: Schema.optionalKey(
		Schema.Struct({
			person: Schema.optionalKey(Schema.Boolean),
			timeoutMs: Schema.optionalKey(
				Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
			),
			onExpire: RequestDomain.CapabilityRequest.fields.onExpire,
		}),
	),
})

export type Input = typeof Input.Type

/** A policy result is saved on first submit. It is not part of the command's identity. */
export interface PolicyDecision {
	readonly allow: boolean
	readonly by: BotDomain.Decider
	readonly reason?: string
}

export type End =
	| { readonly status: "completed" }
	| { readonly status: "cancelled"; readonly epoch: number }
	| { readonly status: "failed"; readonly failure: Execution.Failure }

export interface Service {
	readonly admit: (
		source: Fence,
		commandKey: Execution.CommandKey,
		input: Input,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly submit: (
		source: Fence,
		commandKey: Execution.CommandKey,
		input: Input,
		decided?: PolicyDecision | undefined,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly submitted: (
		source: Fence,
		commandKey: Execution.CommandKey,
		input: Input,
	) => Effect.Effect<
		| Option.None<
				| { readonly _tag: "Allowed" }
				| {
						readonly _tag: "Requested"
						readonly stored: Stored
						readonly executionId: Execution.Id
				  }
		  >
		| Option.Some<
				| { readonly _tag: "Allowed" }
				| {
						readonly _tag: "Requested"
						readonly stored: Stored
						readonly executionId: Execution.Id
				  }
		  >,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly load: (key: Key) => Effect.Effect<
		{
			execution: MemberExecution
			sourceKey: { namespace: string; id: Execution.Id }
			originKey: Key | { namespace: string; id: Execution.Id }
			control: PolicyOrigin.Control | undefined
			stored: Stored
			continuation: "chat" | "workflow"
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly waiting: (
		fence: Fence,
	) => Effect.Effect<
		Option.None<Stored> | Option.Some<Stored>,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly expire: (
		fence: Fence,
	) => Effect.Effect<
		Stored,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly pass: (
		fence: Fence,
		revision: number,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly finish: (
		fence: Fence,
		end: End,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly authorize: Authorize
	readonly decide: (
		key: Key,
		actor: Caller,
		input: DecisionCommand & { readonly details?: typeof Details.Type },
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
}

export class RequestCommands extends Context.Service<
	RequestCommands,
	Service
>()(
	"@openbot-build/openbot/conversation-contract/capabilities/RequestCommands",
) {}
