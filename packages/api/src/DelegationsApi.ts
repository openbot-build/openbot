import { Execution, Delegations as Domain } from "@openbot-build/domain"
import { errors as ExecutionErrors } from "./ExecutionsApi.ts"
import { BotAuth } from "./AuthApi.ts"
import { Authorize, GroupRequired, own } from "./Authorization.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"

// tsdown drops star exports from the built API namespace. List the names here.
export {
	ExecutionView,
	DelegationId,
	DelegationResultStatus,
	OpenDelegationStatus,
	DelegationStatus,
	DelegationParent,
	DelegationLimit,
	DelegationLimits,
	DelegationUsage,
	DelegationPause,
	DelegationNotFound,
	DelegationConflict,
	DelegationStorageUnavailable,
} from "@openbot-build/domain/Delegations"
import {
	DelegationId,
	DelegationNotFound,
	DelegationConflict,
	DelegationStorageUnavailable,
} from "@openbot-build/domain/Delegations"

/** Business state and execution state have separate names. */
export const Delegation = Schema.Struct({
	...Domain.Delegation.fields,
	executionId: Execution.Id,
	executionStatus: Execution.Status,
	failure: Schema.NullOr(Execution.Failure),
})
export type Delegation = typeof Delegation.Type

export const DelegationErrors = [
	...ExecutionErrors,
	DelegationNotFound.pipe(HttpApiSchema.status(404)),
	DelegationConflict.pipe(HttpApiSchema.status(409)),
	DelegationStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const delegationParams = { delegationId: DelegationId }

export class DelegationsApi extends HttpApiGroup.make("delegations")
	.add(
		HttpApiEndpoint.get("getDelegation", "/v1/delegations/:delegationId", {
			params: delegationParams,
			success: Delegation,
			error: DelegationErrors,
		}).annotate(
			OpenApi.Description,
			"Reads one piece of work that a Bot gave away, from one of your Chats.",
		),
		HttpApiEndpoint.post(
			"cancelDelegation",
			"/v1/delegations/:delegationId/cancel",
			{
				params: delegationParams,
				payload: Schema.Struct({ commandKey: Execution.CommandKey }),
				success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
				error: DelegationErrors,
			},
		).annotate(
			OpenApi.Description,
			"Asks the execution to stop this work and its child work. Observe the execution until its resources are released.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// A Delegation belongs to a Chat of the caller. The handlers check that it is one.
	.annotate(GroupRequired, {
		read: [own("read", "Chat")],
		write: [own("write", "Chat")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}
