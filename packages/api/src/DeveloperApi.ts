import { errors as ExecutionErrors } from "./ExecutionsApi.ts"
import { AppIndex, Execution, Developers } from "@openbot-build/domain"
import { Schema } from "effect"
import { Discovery, Indexing } from "@openbot-build/protocol"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Check } from "./AppIndexApi.ts"

export const DeveloperInputInvalid = Developers.DeveloperInputInvalid
export type DeveloperInputInvalid = Developers.DeveloperInputInvalid
export const DeveloperNotFound = Developers.DeveloperNotFound
export type DeveloperNotFound = Developers.DeveloperNotFound
export const DeveloperForbidden = Developers.DeveloperForbidden
export type DeveloperForbidden = Developers.DeveloperForbidden
export const DeveloperConflict = Developers.DeveloperConflict
export type DeveloperConflict = Developers.DeveloperConflict
export const DeveloperUnavailable = Developers.DeveloperUnavailable
export type DeveloperUnavailable = Developers.DeveloperUnavailable
export const DeveloperRestricted = Developers.DeveloperRestricted
export type DeveloperRestricted = Developers.DeveloperRestricted
export const Errors = [
	...ExecutionErrors,
	DeveloperRestricted.pipe(HttpApiSchema.status(403)),
	DeveloperInputInvalid.pipe(HttpApiSchema.status(400)),
	DeveloperNotFound.pipe(HttpApiSchema.status(404)),
	DeveloperForbidden.pipe(HttpApiSchema.status(403)),
	DeveloperConflict.pipe(HttpApiSchema.status(409)),
	DeveloperUnavailable.pipe(HttpApiSchema.status(503)),
]
export type Failure = Developers.Failure

export const Issue = Developers.Issue
export type Issue = Developers.Issue
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
	...Developers.ReportState.fields,
	apps: Schema.Array(InspectedApp),
	stages: Schema.Array(Indexing.InspectionStage),
})
export type InspectionReport = typeof InspectionReport.Type
export const ManagementScope = Developers.ManagementScope
export type ManagementScope = Developers.ManagementScope
export const Challenge = Developers.Challenge
export type Challenge = Developers.Challenge
export const Proof = Developers.Proof
export type Proof = Developers.Proof
export const MemberRole = Developers.MemberRole
export type MemberRole = Developers.MemberRole
export const Grant = Developers.Grant
export type Grant = Developers.Grant
export const ManagedApp = Schema.Struct({
	...Developers.ManagedAppState.fields,
	candidate: Discovery.Candidate,
})
export type ManagedApp = typeof ManagedApp.Type
export const Invitation = Developers.Invitation
export type Invitation = Developers.Invitation
export const Member = Developers.Member
export type Member = Developers.Member
export const SavedReport = Schema.Struct({
	...Developers.SavedReportState.fields,
	report: InspectionReport,
})
export type SavedReport = typeof SavedReport.Type
export const PersonalReport = Developers.PersonalReport
export type PersonalReport = Developers.PersonalReport
export const ReportDiff = Developers.ReportDiff
export type ReportDiff = Developers.ReportDiff
export const TestStage = Developers.TestStage
export type TestStage = Developers.TestStage
export const TestAuthorization = Developers.TestAuthorization
export type TestAuthorization = Developers.TestAuthorization
/** How far the cleanup of a connection test has come. */
export const CleanupProgress = Developers.CleanupProgress
export type CleanupProgress = Developers.CleanupProgress
export const ConnectionTest = Schema.Struct({
	...Developers.TestState.fields,
	candidate: Discovery.Candidate,
})
export type ConnectionTest = typeof ConnectionTest.Type
export const IndexJobStatus = AppIndex.JobStatus
export type IndexJobStatus = AppIndex.JobStatus
export const IndexRequest = Developers.IndexRequest
export type IndexRequest = Developers.IndexRequest
export const Subscription = Developers.Subscription
export type Subscription = Developers.Subscription
export const Notice = Developers.Notice
export type Notice = Developers.Notice
const Uuid = Schema.String.check(Schema.isUUID())
const UuidId = { id: Uuid }
const Id = { id: Schema.String }
const Card = { cardUrl: Schema.String }
const Page = { before: Schema.optionalKey(Uuid) }
export class DeveloperApi extends HttpApiGroup.make("developer")
	.add(
		HttpApiEndpoint.get("personalReports", "/v1/developer/personal-reports", {
			query: Page,
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
			payload: Schema.Struct({
				cardUrl: Schema.String,
				commandKey: Execution.CommandKey,
			}),
			success: IndexRequest,
			error: [...Errors, ...ExecutionErrors],
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
			params: UuidId,
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
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cancelTest", "/v1/developer/tests/:id/cancel", {
			params: Id,
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cleanupTest", "/v1/developer/tests/:id/cleanup", {
			params: Id,
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteTest", "/v1/developer/tests/:id", {
			params: Id,
			query: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
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
					commandKey: Execution.CommandKey,
					issuer: Schema.optionalKey(Schema.String),
					scopes: Schema.Array(Schema.String),
				}),
				success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
				error: Errors,
			},
		),
	)
	.add(
		HttpApiEndpoint.post(
			"completeTestAuthorization",
			"/v1/developer/tests/:id/authorization/complete",
			{
				params: Id,
				payload: Schema.Struct({ commandKey: Execution.CommandKey }),
				success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
				error: Errors,
			},
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
			params: UuidId,
			success: Challenge,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("verifyClaim", "/v1/developer/claims/:id/verify", {
			params: UuidId,
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("revokeClaim", "/v1/developer/claims/:id/revoke", {
			params: UuidId,
			success: Challenge,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("getProof", "/v1/developer/proofs/:id", {
			params: UuidId,
			success: Proof,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("verifyProof", "/v1/developer/proofs/:id/verify", {
			params: UuidId,
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("relinquish", "/v1/developer/proofs/:id/relinquish", {
			params: UuidId,
			success: Proof,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("members", "/v1/developer/proofs/:id/members", {
			params: UuidId,
			success: Schema.Struct({
				members: Schema.Array(Member),
				invitations: Schema.Array(Invitation),
			}),
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("invite", "/v1/developer/proofs/:id/invitations", {
			params: UuidId,
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
			params: UuidId,
			payload: Schema.Struct({ role: MemberRole }),
			success: Member,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("removeMember", "/v1/developer/members/:id", {
			params: UuidId,
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
			params: UuidId,
			success: SavedReport,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.get("compare", "/v1/developer/reports/:id/compare", {
			params: UuidId,
			query: { other: Uuid },
			success: ReportDiff,
			error: Errors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteReport", "/v1/developer/reports/:id", {
			params: UuidId,
			success: Schema.Void,
			error: Errors,
		}),
	) {}
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
