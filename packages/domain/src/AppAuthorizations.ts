import { Schema } from "effect"
import { ConnectionId } from "./ConnectionId.ts"
import { ReturnTo } from "./ReturnTo.ts"
import * as Execution from "./Execution.ts"

export const Begin = Schema.Struct({
	revision: Schema.Natural,
	scopes: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(50)),
	issuer: Schema.optionalKey(Schema.String),
	returnTo: Schema.optionalKey(ReturnTo),
})
export type Begin = typeof Begin.Type
export const Started = Schema.TaggedUnion({
	AuthorizationStarted: {
		flowId: Schema.NonEmptyString,
		authorizationUrl: Schema.String,
		issuer: Schema.String,
		scopes: Schema.Array(Schema.String),
	},
	IssuerSelectionRequired: {
		issuers: Schema.NonEmptyArray(Schema.String),
		scopes: Schema.Array(Schema.String),
	},
	AuthorizationNotRequired: {},
})
export type Started = typeof Started.Type
export const State = Schema.Struct({
	flowId: Schema.NonEmptyString,
	connectionId: ConnectionId,
	executionId: Schema.NullOr(Execution.Id),
	returnTo: ReturnTo,
	expiresAt: Schema.Finite,
	issuer: Schema.String,
	resource: Schema.String,
	scopes: Schema.Array(Schema.String),
	status: Schema.Literals([
		"Waiting",
		"Received",
		"Processing",
		"Succeeded",
		"Cancelled",
		"Failed",
	]),
	reason: Schema.NullOr(Schema.String),
})
export type State = typeof State.Type
export const Revocation = Schema.TaggedUnion({ Revoked: {}, LocalOnly: {} })
export type Revocation = typeof Revocation.Type
export const ActionResult = Schema.Union([
	Schema.TaggedStruct("Removed", { connectionId: ConnectionId }),
	Started,
	Schema.TaggedStruct("Refreshed", { connectionId: ConnectionId }),
	Revocation,
	Schema.TaggedStruct("RevocationPending", {}),
	Schema.TaggedStruct("Authorized", {
		flowId: Schema.String,
		connectionId: ConnectionId,
	}),
])
export type ActionResult = typeof ActionResult.Type
export const Action = Schema.Struct({
	execution: Execution.Record,
	cleanupExecutions: Schema.Array(Execution.Record),
	result: Schema.NullOr(ActionResult),
})
export type Action = typeof Action.Type
export class AppAuthorizationFailed extends Schema.TaggedError<
	AppAuthorizationFailed,
	{ readonly brand: unique symbol }
>()("AppAuthorizationFailed", {
	reason: Schema.String,
	message: Schema.String,
}) {}
export class AppAuthorizationUnavailable extends Schema.TaggedError<
	AppAuthorizationUnavailable,
	{ readonly brand: unique symbol }
>()("AppAuthorizationUnavailable", {}) {}
