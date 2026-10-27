import { Schema } from "effect"
import { Check, JobStatus, Restriction } from "./AppIndex.ts"
import * as Execution from "./Execution.ts"

export class DeveloperInputInvalid extends Schema.TaggedError<
	DeveloperInputInvalid,
	{ readonly brand: unique symbol }
>()("DeveloperInputInvalid", {
	message: Schema.String,
	keys: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}
export class DeveloperNotFound extends Schema.TaggedError<
	DeveloperNotFound,
	{ readonly brand: unique symbol }
>()("DeveloperNotFound", {}) {}
export class DeveloperForbidden extends Schema.TaggedError<
	DeveloperForbidden,
	{ readonly brand: unique symbol }
>()("DeveloperForbidden", {}) {}
export class DeveloperConflict extends Schema.TaggedError<
	DeveloperConflict,
	{ readonly brand: unique symbol }
>()("DeveloperConflict", { reason: Schema.String }) {}
export class DeveloperUnavailable extends Schema.TaggedError<
	DeveloperUnavailable,
	{ readonly brand: unique symbol }
>()("DeveloperUnavailable", {}) {}
export class DeveloperRestricted extends Schema.TaggedError<
	DeveloperRestricted,
	{ readonly brand: unique symbol }
>()("DeveloperRestricted", { restriction: Restriction }) {}
export type StorageFailure = Execution.StorageError | Schema.SchemaError
export type Failure =
	| StorageFailure
	| Execution.Conflict
	| Execution.Forbidden
	| Execution.NotFound
	| Execution.KeyConflict
	| DeveloperRestricted
	| DeveloperInputInvalid
	| DeveloperNotFound
	| DeveloperForbidden
	| DeveloperConflict
	| DeveloperUnavailable

export const Issue = Schema.Struct({
	code: Schema.String,
	impacts: Schema.optionalKey(
		Schema.Array(Schema.Literals(["discovery", "indexing", "connection"])),
	),
	stage: Schema.Literals(["publication", "catalog", "card", "indexing"]),
	severity: Schema.Literals(["blocking", "suggestion"]),
	source: Schema.String,
	fieldPath: Schema.optionalKey(Schema.String),
	message: Schema.String,
	repair: Schema.String,
})
export type Issue = typeof Issue.Type
export const ManagementScope = Schema.TaggedUnion({
	PublisherHostname: { hostname: Schema.NonEmptyString },
	AppCard: { cardUrl: Schema.NonEmptyString },
})
export type ManagementScope = typeof ManagementScope.Type
export const Challenge = Schema.Struct({
	id: Schema.String,
	scope: ManagementScope,
	token: Schema.String,
	createdAt: Schema.Finite,
	expiresAt: Schema.Finite,
	status: Schema.Literals(["Pending", "Confirmed", "Revoked", "Expired"]),
})
export type Challenge = typeof Challenge.Type
export const Proof = Schema.Struct({
	id: Schema.String,
	transition: Schema.Natural,
	scope: ManagementScope,
	status: Schema.Literals([
		"Confirmed",
		"Unconfirmed",
		"Suspended",
		"Relinquished",
	]),
	confirmedAt: Schema.NullOr(Schema.Finite),
	validUntil: Schema.Finite,
	nextVerificationAt: Schema.Finite,
	reason: Schema.NullOr(Schema.String),
})
export type Proof = typeof Proof.Type
export const MemberRole = Schema.Literals(["maintainer", "viewer"])
export type MemberRole = typeof MemberRole.Type
export const Grant = Schema.Struct({
	proofId: Schema.String,
	memberId: Schema.optionalKey(Schema.String),
	scope: ManagementScope,
	role: Schema.Literals(["administrator", ...MemberRole.literals]),
})
export type Grant = typeof Grant.Type
export const Subscription = Schema.Struct({
	cardUrl: Schema.String,
	enabled: Schema.Boolean,
})
export type Subscription = typeof Subscription.Type
export const Notice = Schema.Struct({
	id: Schema.String,
	cardUrl: Schema.NullOr(Schema.String),
	kind: Schema.Literals(["IssueAppeared", "IssueResolved", "AccessChanged"]),
	issue: Schema.NullOr(Issue),
	reason: Schema.NullOr(Schema.String),
	reportId: Schema.NullOr(Schema.String),
	createdAt: Schema.Finite,
	readAt: Schema.NullOr(Schema.Finite),
})
export type Notice = typeof Notice.Type

/** A read of public proof evidence. A failed read keeps the sealed cause by ID. */
export const ProofEvidence = Schema.TaggedUnion({
	Matched: {},
	Missing: {},
	Unavailable: { failure: Execution.Failure },
})
export type ProofEvidence = typeof ProofEvidence.Type

/** A failed read keeps the old grant only until its saved end time. */
export const assessProof = (
	current: Proof,
	evidence: ProofEvidence,
	now: number,
): Proof => {
	if (current.status === "Relinquished") return current
	const next =
		evidence._tag === "Unavailable"
			? {
					...current,
					status:
						current.validUntil > now
							? ("Unconfirmed" as const)
							: ("Suspended" as const),
					nextVerificationAt: now + 60000,
					reason: "VerificationUnavailable",
				}
			: {
					...current,
					status:
						evidence._tag === "Matched"
							? ("Confirmed" as const)
							: ("Suspended" as const),
					confirmedAt: evidence._tag === "Matched" ? now : current.confirmedAt,
					validUntil: evidence._tag === "Matched" ? now + 7 * 86400000 : now,
					nextVerificationAt: now + 86400000,
					reason: evidence._tag === "Matched" ? null : "ProofRemoved",
				}
	return {
		...next,
		transition: current.transition + (next.status === current.status ? 0 : 1),
	}
}

export const Invitation = Schema.Struct({
	id: Schema.String,
	proofId: Schema.String,
	scope: ManagementScope,
	role: MemberRole,
	expiresAt: Schema.Finite,
	status: Schema.Literals(["Pending", "Accepted", "Revoked"]),
})
export type Invitation = typeof Invitation.Type

export const Member = Schema.Struct({
	id: Schema.String,
	proofId: Schema.String,
	identity: Schema.Struct({
		organizationId: Schema.String,
		userId: Schema.String,
	}),
	role: MemberRole,
})
export type Member = typeof Member.Type

export const PersonalReport = Schema.Struct({
	id: Schema.String,
	cardUrl: Schema.String,
	checkedAt: Schema.Finite,
})
export type PersonalReport = typeof PersonalReport.Type

export const ReportDiff = Schema.Struct({
	introduced: Schema.Array(Issue),
	resolved: Schema.Array(Issue),
	persisting: Schema.Array(Issue),
})
export type ReportDiff = typeof ReportDiff.Type

export const TestStage = Schema.Struct({
	name: Schema.Literals([
		"configuration",
		"negotiation",
		"tools",
		"resources",
		"resourceTemplates",
		"prompts",
	]),
	status: Schema.Literals(["Passed", "Failed", "NotAdvertised", "NotChecked"]),
	items: Schema.Array(Schema.JsonObject),
	reason: Schema.NullOr(Schema.String),
})
export type TestStage = typeof TestStage.Type

export const TestAuthorization = Schema.Struct({
	flowId: Schema.String,
	status: Schema.Literals([
		"Waiting",
		"Received",
		"Exchanging",
		"Succeeded",
		"Failed",
		"Cancelled",
		"Expired",
	]),
	issuer: Schema.String,
	resource: Schema.String,
	scopes: Schema.Array(Schema.String),
	expiresAt: Schema.Finite,
	authorizationUrl: Schema.String,
})
export type TestAuthorization = typeof TestAuthorization.Type

export const CleanupProgress = Schema.Literals([
	"NotRequired",
	"Pending",
	"Complete",
])
export type CleanupProgress = typeof CleanupProgress.Type

export const IndexRequest = Schema.Struct({
	id: Schema.String,
	executionId: Execution.Id,
	cardUrl: Schema.String,
	generation: Schema.String,
	acceptedAt: Schema.Finite,
	status: Schema.Literals(["Accepted", ...JobStatus.literals]),
	check: Schema.NullOr(Check),
	restriction: Schema.NullOr(Restriction),
})
export type IndexRequest = typeof IndexRequest.Type

export const TestState = Schema.Struct({
	id: Schema.String,
	/** The last test operation. A new test has no execution. */
	executionId: Schema.optionalKey(Execution.Id),
	/** The service that owns expiry and private data cleanup. */
	cleanupExecutionId: Schema.optionalKey(Execution.Id),
	cardUrl: Schema.String,
	remoteIndex: Schema.Natural,
	endpoint: Schema.NullOr(Schema.String),
	configurationKeys: Schema.Array(Schema.String),
	issuers: Schema.Array(Schema.String),
	requestedScopes: Schema.Array(Schema.String),
	createdAt: Schema.Finite,
	expiresAt: Schema.Finite,
	status: Schema.Literals([
		"Queued",
		"Running",
		"AwaitingConfiguration",
		"AwaitingAuthorization",
		"PreparingAuthorization",
		"ExchangingAuthorization",
		"Succeeded",
		"Failed",
		"Cancelling",
		"Cancelled",
		"Interrupted",
	]),
	checkedAt: Schema.NullOr(Schema.Finite),
	stages: Schema.Array(TestStage),
	cleanup: CleanupProgress,
	cleanupRemote: Schema.Literals([...CleanupProgress.literals, "LocalOnly"]),
	cleanupLocal: CleanupProgress.pick(["Pending", "Complete"]),
	authorization: Schema.NullOr(TestAuthorization),
	reason: Schema.NullOr(Schema.String),
})
export type TestState = typeof TestState.Type

export const ReportState = Schema.Struct({
	input: Schema.String,
	checkedAt: Schema.Finite,
	issues: Schema.Array(Issue),
})
export type ReportState = typeof ReportState.Type

export const SavedReportState = Schema.Struct({
	id: Schema.String,
	cardUrl: Schema.String,
	createdBy: Schema.String,
})
export type SavedReportState = typeof SavedReportState.Type

export const ManagedAppState = Schema.Struct({
	cardUrl: Schema.String,
	grants: Schema.Array(Grant),
})
export type ManagedAppState = typeof ManagedAppState.Type
