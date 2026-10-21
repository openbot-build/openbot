import { DeveloperApi as Api } from "@openbot-build/api"
import { Discovery } from "@openbot-build/protocol"
import { Context, Effect, type Option, Schema } from "effect"

export const ClaimRecord = Schema.Struct({
	owner: Schema.String,
	value: Api.Challenge,
})
export type ClaimRecord = typeof ClaimRecord.Type
export const ProofRecord = Schema.Struct({
	owner: Schema.String,
	token: Schema.String,
	value: Api.Proof,
})
export type ProofRecord = typeof ProofRecord.Type
export const InvitationRecord = Schema.Struct({
	owner: Schema.String,
	acceptedBy: Schema.NullOr(Schema.String),
	value: Api.Invitation,
})
export type InvitationRecord = typeof InvitationRecord.Type
export const MemberRecord = Schema.Struct({
	owner: Schema.String,
	value: Api.Member,
})
export type MemberRecord = typeof MemberRecord.Type
export const AppRecord = Schema.Struct({
	candidate: Discovery.Candidate,
	nextCheckAt: Schema.Finite,
	leaseUntil: Schema.optionalKey(Schema.Finite),
	monitorToken: Schema.optionalKey(Schema.String),
})
export type AppRecord = typeof AppRecord.Type
export const ReportRecord = Schema.Struct({
	owner: Schema.String,
	value: Api.SavedReport,
})
export type ReportRecord = typeof ReportRecord.Type
export const TestRecord = Schema.Struct({
	owner: Schema.String,
	value: Api.ConnectionTest,
	resourceMetadataUrl: Schema.optionalKey(Schema.String),
	cleanupToken: Schema.optionalKey(Schema.String),
	cleanupLeaseUntil: Schema.optionalKey(Schema.Finite),
})
export type TestRecord = typeof TestRecord.Type
export const SecretRecord = Schema.Struct({
	owner: Schema.String,
	body: Schema.String,
})
export type SecretRecord = typeof SecretRecord.Type
export const TestFlowRecord = Schema.Struct({
	owner: Schema.String,
	testId: Schema.String,
	value: Api.TestAuthorization,
	body: Schema.String,
	callback: Schema.NullOr(Schema.String),
	consumed: Schema.Boolean,
})
export type TestFlowRecord = typeof TestFlowRecord.Type
export const IndexRequestRecord = Schema.Struct({
	owner: Schema.String,
	value: Api.IndexRequest,
})
export type IndexRequestRecord = typeof IndexRequestRecord.Type
export const SubscriptionRecord = Schema.Struct({
	owner: Schema.String,
	value: Api.Subscription,
})
export type SubscriptionRecord = typeof SubscriptionRecord.Type
export const NoticeRecord = Schema.Struct({
	owner: Schema.String,
	value: Api.Notice,
})
export type NoticeRecord = typeof NoticeRecord.Type
export const MonitorRecord = Schema.Struct({
	cardUrl: Schema.String,
	revision: Schema.Natural,
	issues: Schema.Array(Api.Issue),
})
export type MonitorRecord = typeof MonitorRecord.Type
export interface Collection<A> {
	/** Read one record. Fail with `DeveloperNotFound` when it does not exist. */
	readonly get: (
		id: string,
	) => Effect.Effect<A, Api.DeveloperNotFound | Api.DeveloperUnavailable>
	/** Read one record. Give `None` when it does not exist. */
	readonly find: (
		id: string,
	) => Effect.Effect<Option.Option<A>, Api.DeveloperUnavailable>
	readonly list: (filter?: {
		readonly owner?: string
		readonly scope?: string
	}) => Effect.Effect<ReadonlyArray<A>, Api.DeveloperUnavailable>
	readonly put: (
		id: string,
		owner: string,
		scope: string,
		value: A,
	) => Effect.Effect<void, Api.DeveloperUnavailable>
	readonly remove: (id: string) => Effect.Effect<void, Api.DeveloperUnavailable>
}
export class DeveloperRepository extends Context.Service<
	DeveloperRepository,
	{
		readonly claims: Collection<ClaimRecord>
		readonly proofs: Collection<ProofRecord>
		readonly invitations: Collection<InvitationRecord>
		readonly members: Collection<MemberRecord>
		readonly apps: Collection<AppRecord>
		readonly reports: Collection<ReportRecord>
		readonly tests: Collection<TestRecord>
		readonly secrets: Collection<SecretRecord>
		readonly flows: Collection<TestFlowRecord>
		readonly indexing: Collection<IndexRequestRecord>
		readonly subscriptions: Collection<SubscriptionRecord>
		readonly notices: Collection<NoticeRecord>
		readonly monitors: Collection<MonitorRecord>
		readonly transaction: <A, E, R>(
			key: string,
			operation: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E | Api.DeveloperUnavailable, R>
	}
>()("@openbot-build/openbot/apps/DeveloperRepository") {}
