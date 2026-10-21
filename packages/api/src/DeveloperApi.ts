import { Schema } from "effect"
import { Discovery, Indexing } from "@openbot-build/protocol"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Check, Restriction } from "./AppIndexApi.ts"

export class DeveloperInputInvalid extends Schema.TaggedError<DeveloperInputInvalid>()(
	"DeveloperInputInvalid",
	{
		message: Schema.String,
		keys: Schema.optionalKey(Schema.Array(Schema.String)),
	},
) {}
export class DeveloperNotFound extends Schema.TaggedError<DeveloperNotFound>()(
	"DeveloperNotFound",
	{},
) {}
export class DeveloperForbidden extends Schema.TaggedError<DeveloperForbidden>()(
	"DeveloperForbidden",
	{},
) {}
export class DeveloperConflict extends Schema.TaggedError<DeveloperConflict>()(
	"DeveloperConflict",
	{ reason: Schema.String },
) {}
export class DeveloperUnavailable extends Schema.TaggedError<DeveloperUnavailable>()(
	"DeveloperUnavailable",
	{},
) {}
export class DeveloperRestricted extends Schema.TaggedError<DeveloperRestricted>()(
	"DeveloperRestricted",
	{ restriction: Restriction },
) {}
export const Errors = [
	DeveloperRestricted.pipe(HttpApiSchema.status(403)),
	DeveloperInputInvalid.pipe(HttpApiSchema.status(400)),
	DeveloperNotFound.pipe(HttpApiSchema.status(404)),
	DeveloperForbidden.pipe(HttpApiSchema.status(403)),
	DeveloperConflict.pipe(HttpApiSchema.status(409)),
	DeveloperUnavailable.pipe(HttpApiSchema.status(503)),
]
export type Failure =
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
export const StoredIndex = Schema.TaggedUnion({
	Known: { check: Schema.NullOr(Check) },
	Unknown: {},
})
export const InspectedApp = Schema.Struct({
	candidate: Discovery.Candidate,
	eligibility: Indexing.InspectionResult,
	stored: StoredIndex,
})
export const InspectionReport = Schema.Struct({
	input: Schema.String,
	checkedAt: Schema.Finite,
	apps: Schema.Array(InspectedApp),
	issues: Schema.Array(Issue),
	stages: Schema.Array(Indexing.InspectionStage),
})
export type InspectionReport = typeof InspectionReport.Type
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
export const ManagedApp = Schema.Struct({
	cardUrl: Schema.String,
	candidate: Discovery.Candidate,
	grants: Schema.Array(Grant),
})
export type ManagedApp = typeof ManagedApp.Type
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
export const SavedReport = Schema.Struct({
	id: Schema.String,
	cardUrl: Schema.String,
	createdBy: Schema.String,
	report: InspectionReport,
})
export type SavedReport = typeof SavedReport.Type
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
/** How far the cleanup of a connection test has come. */
export const CleanupProgress = Schema.Literals([
	"NotRequired",
	"Pending",
	"Complete",
])
export type CleanupProgress = typeof CleanupProgress.Type
export const ConnectionTest = Schema.Struct({
	id: Schema.String,
	cardUrl: Schema.String,
	candidate: Discovery.Candidate,
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
		"Succeeded",
		"Failed",
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
export type ConnectionTest = typeof ConnectionTest.Type
/** The status of index work after OpenBot accepts an index request. */
export const IndexJobStatus = Schema.Literals([
	"Waiting",
	"Verifying",
	"Completed",
])
export type IndexJobStatus = typeof IndexJobStatus.Type
export const IndexRequest = Schema.Struct({
	id: Schema.String,
	cardUrl: Schema.String,
	generation: Schema.String,
	acceptedAt: Schema.Finite,
	status: Schema.Literals(["Accepted", ...IndexJobStatus.literals]),
	check: Schema.NullOr(Check),
	restriction: Schema.NullOr(Restriction),
})
export type IndexRequest = typeof IndexRequest.Type
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
const Id = { id: Schema.String }
const Card = { cardUrl: Schema.String }
const Page = { before: Schema.optionalKey(Schema.String) }
export const DeveloperApi = HttpApiGroup.make("developer")
	.add(
		HttpApiEndpoint.get("personalReports", "/v1/developer/personal-reports", {
			query: { before: Schema.optionalKey(Schema.String) },
			success: Schema.Array(PersonalReport),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("notifications", "/v1/developer/notifications", {
			query: { before: Schema.optionalKey(Schema.String) },
			success: Schema.Array(Notice),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post(
			"readNotification",
			"/v1/developer/notifications/:id/read",
			{ params: Id, success: Notice, error: Errors },
		),
	)
	.add(
		HttpApiEndpoint.get("subscriptions", "/v1/developer/subscriptions", {
			success: Schema.Array(Subscription),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.put("subscribe", "/v1/developer/subscriptions", {
			payload: Subscription,
			success: Subscription,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("requestIndexing", "/v1/developer/indexing", {
			payload: Schema.Struct({ cardUrl: Schema.String }),
			success: IndexRequest,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("indexingRequests", "/v1/developer/indexing", {
			query: { cardUrl: Schema.optionalKey(Schema.String) },
			success: Schema.Array(IndexRequest),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("indexingRequest", "/v1/developer/indexing/:id", {
			params: Id,
			success: IndexRequest,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("createTest", "/v1/developer/tests", {
			payload: Schema.Struct({
				id: Schema.String.check(Schema.isUUID()),
				cardUrl: Schema.String,
				remoteIndex: Schema.Natural,
			}),
			success: ConnectionTest,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("tests", "/v1/developer/tests", {
			success: Schema.Array(ConnectionTest),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("test", "/v1/developer/tests/:id", {
			params: Id,
			success: ConnectionTest,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.put(
			"configureTest",
			"/v1/developer/tests/:id/configuration",
			{
				params: Id,
				payload: Schema.Record(Schema.String, Schema.String),
				success: ConnectionTest,
				error: Errors,
			},
		),
	)
	.add(
		HttpApiEndpoint.post("runTest", "/v1/developer/tests/:id/run", {
			params: Id,
			success: ConnectionTest,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cancelTest", "/v1/developer/tests/:id/cancel", {
			params: Id,
			success: ConnectionTest,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cleanupTest", "/v1/developer/tests/:id/cleanup", {
			params: Id,
			success: ConnectionTest,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteTest", "/v1/developer/tests/:id", {
			params: Id,
			success: Schema.Void,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post(
			"authorizeTest",
			"/v1/developer/tests/:id/authorization",
			{
				params: Id,
				payload: Schema.Struct({
					issuer: Schema.optionalKey(Schema.String),
					scopes: Schema.Array(Schema.String),
				}),
				success: ConnectionTest,
				error: Errors,
			},
		),
	)
	.add(
		HttpApiEndpoint.post(
			"completeTestAuthorization",
			"/v1/developer/tests/:id/authorization/complete",
			{ params: Id, success: ConnectionTest, error: Errors },
		),
	)
	.add(
		HttpApiEndpoint.get("overview", "/v1/developer", {
			success: Schema.Struct({
				apps: Schema.Array(ManagedApp),
				proofs: Schema.Array(Proof),
				grants: Schema.Array(Grant),
			}),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("startClaim", "/v1/developer/claims", {
			payload: ManagementScope,
			success: Challenge,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("getClaim", "/v1/developer/claims/:id", {
			params: Id,
			success: Challenge,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("verifyClaim", "/v1/developer/claims/:id/verify", {
			params: Id,
			success: Proof,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("revokeClaim", "/v1/developer/claims/:id/revoke", {
			params: Id,
			success: Challenge,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("verifyProof", "/v1/developer/proofs/:id/verify", {
			params: Id,
			success: Proof,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("relinquish", "/v1/developer/proofs/:id/relinquish", {
			params: Id,
			success: Proof,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("members", "/v1/developer/proofs/:id/members", {
			params: Id,
			success: Schema.Struct({
				members: Schema.Array(Member),
				invitations: Schema.Array(Invitation),
			}),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("invite", "/v1/developer/proofs/:id/invitations", {
			params: Id,
			payload: Schema.Struct({ role: MemberRole }),
			success: Invitation,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("invitation", "/v1/developer/invitations/:id", {
			params: Id,
			success: Invitation,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post(
			"acceptInvitation",
			"/v1/developer/invitations/:id/accept",
			{ params: Id, success: Grant, error: Errors },
		),
	)
	.add(
		HttpApiEndpoint.post(
			"revokeInvitation",
			"/v1/developer/invitations/:id/revoke",
			{ params: Id, success: Invitation, error: Errors },
		),
	)
	.add(
		HttpApiEndpoint.put("changeMember", "/v1/developer/members/:id", {
			params: Id,
			payload: Schema.Struct({ role: MemberRole }),
			success: Member,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("removeMember", "/v1/developer/members/:id", {
			params: Id,
			success: Schema.Void,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("saveInspection", "/v1/developer/reports", {
			payload: Schema.Struct(Card),
			success: SavedReport,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("reports", "/v1/developer/reports", {
			query: { ...Card, ...Page },
			success: Schema.Array(SavedReport),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("report", "/v1/developer/reports/:id", {
			params: Id,
			success: SavedReport,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("compare", "/v1/developer/reports/:id/compare", {
			params: Id,
			query: { other: Schema.String },
			success: ReportDiff,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteReport", "/v1/developer/reports/:id", {
			params: Id,
			success: Schema.Void,
			error: Errors,
		}),
	)
export const DeveloperPublicApi = HttpApiGroup.make("developerPublic").add(
	HttpApiEndpoint.get(
		"authorizationCallback",
		"/auth/developer/apps/callback",
		{ success: Schema.Void, error: Errors },
	),
	HttpApiEndpoint.post("inspect", "/v1/developer/inspect", {
		payload: Schema.Struct({
			input: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
		}),
		success: InspectionReport,
		error: Errors,
	}),
)
