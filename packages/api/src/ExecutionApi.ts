import { Schema } from "effect"

/** Private runtime control contract. A deployment must not route this path publicly. */
export const DrainRequest = Schema.Struct({
	accountId: Schema.NonEmptyString,
	sourceTenantId: Schema.NonEmptyString,
	migrationId: Schema.NonEmptyString,
	epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export const DrainResponse = Schema.Struct({
	...DrainRequest.fields,
	drained: Schema.Boolean,
	activeExecutions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export const DrainPath = "/internal/execution/drain"

/** Instance admission must stop before a stateful runtime is replaced. */
export const QuiescePath = "/internal/execution/quiesce"
export const ResumePath = "/internal/execution/resume"
export const StatusPath = "/internal/execution/status"
export const InstanceStatus = Schema.Struct({
	quiesced: Schema.Boolean,
	drained: Schema.Boolean,
	activeLeases: Schema.Natural,
	persistedPending: Schema.Natural,
	activeExecutions: Schema.Natural,
})

/** Resolve an App OAuth callback only from a server-stored authorization flow. */
export const AuthorizationOwnerPath = "/internal/apps/authorization-owner"
export const AuthorizationOwnerRequest = Schema.Struct({
	kind: Schema.optionalKey(Schema.Literals(["app", "developer"])),
	flowId: Schema.NonEmptyString,
})
export const AuthorizationOwnerResponse = Schema.Struct({
	accountId: Schema.NonEmptyString,
})
