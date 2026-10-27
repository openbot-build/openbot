import { Schema, String as Str } from "effect"
import { ConnectionId } from "./ConnectionId.ts"
import { Restriction } from "./AppIndex.ts"

export const CleanupStage = Schema.Literals(["Credentials", "Connection"])

export const ConnectionName = Schema.String.check(
	Schema.isMaxLength(80),
	Schema.makeFilter(
		(value) => Str.isNonEmpty(Str.trim(value)) || "Enter a connection name.",
	),
)

export const Availability = Schema.TaggedUnion({
	PendingConfiguration: {},
	PendingAuthorization: { scopes: Schema.Array(Schema.String) },
	Unverified: {},
	Available: { checkedAt: Schema.Finite, revision: Schema.Natural },
	AuthorizationExpired: {},
	ConnectionFailed: { message: Schema.String },
	NeedsRevalidation: {},
	CleanupPending: { stage: CleanupStage },
	Restricted: { restriction: Restriction },
})

export class ConnectionConflict extends Schema.TaggedError<
	ConnectionConflict,
	{ readonly brand: unique symbol }
>()("ConnectionConflict", {
	reason: Schema.Literals([
		"CandidateChanged",
		"RevisionChanged",
		"DraftExpired",
		"AlreadyAdded",
		"LimitReached",
	]),
	message: Schema.String,
}) {}

export class ConnectionConfigurationInvalid extends Schema.TaggedError<
	ConnectionConfigurationInvalid,
	{ readonly brand: unique symbol }
>()("ConnectionConfigurationInvalid", {
	message: Schema.String,
	keys: Schema.Array(Schema.String),
}) {}

export class ConnectionCleanupPending extends Schema.TaggedError<
	ConnectionCleanupPending,
	{ readonly brand: unique symbol }
>()("ConnectionCleanupPending", {
	connectionId: ConnectionId,
	stage: CleanupStage,
	message: Schema.String,
}) {}

export const DraftState = Schema.Struct({
	id: Schema.NonEmptyString,
	revision: Schema.Natural,
	input: Schema.NonEmptyString,
	expiresAt: Schema.Finite,
	imported: Schema.optionalKey(
		Schema.Struct({ name: ConnectionName, remoteIndex: Schema.Natural }),
	),
})

/** A change keeps the revision that the caller read. */
export const Update = Schema.Struct({
	revision: Schema.Natural,
	name: ConnectionName,
	enabled: Schema.Boolean,
})
export type Update = typeof Update.Type
export const ManualUpdate = Schema.Struct({
	revision: Schema.Natural,
	name: ConnectionName,
	url: Schema.NonEmptyString,
	transport: Schema.Literal("streamable-http"),
	headers: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
})
export type ManualUpdate = typeof ManualUpdate.Type
export const Revalidation = Schema.Struct({
	revision: Schema.Natural,
	draftId: Schema.NonEmptyString,
	remoteIndex: Schema.Natural,
	values: Schema.Record(Schema.String, Schema.String),
	confirmed: Schema.Literal(true),
})
export type Revalidation = typeof Revalidation.Type
export const CapabilityLists = Schema.Struct({
	protocolVersion: Schema.String,
	tools: Schema.Array(Schema.JsonObject),
	resources: Schema.Array(Schema.JsonObject),
	resourceTemplates: Schema.Array(Schema.JsonObject),
	prompts: Schema.Array(Schema.JsonObject),
})
export type CapabilityLists = typeof CapabilityLists.Type
export const Result = Schema.TaggedUnion({
	Updated: { connectionId: ConnectionId, revision: Schema.Natural },
	Verified: {
		connectionId: ConnectionId,
		revision: Schema.Natural,
		capabilities: CapabilityLists,
	},
	Unavailable: { connectionId: ConnectionId, revision: Schema.Natural },
})
export type Result = typeof Result.Type

export const ManualConfiguration = Schema.Struct({
	name: ConnectionName,
	url: Schema.NonEmptyString,
	transport: Schema.Literal("streamable-http"),
	headers: Schema.Record(Schema.String, Schema.String),
})
export type ManualConfiguration = typeof ManualConfiguration.Type
export const ManualConnectionRequest = Schema.Struct({
	id: ConnectionId,
	...ManualConfiguration.fields,
})
export type ManualConnectionRequest = typeof ManualConnectionRequest.Type

/** Connection exports hold the description, without account secrets. */
export const Entry = Schema.Struct({
	name: ConnectionName,
	cardUrl: Schema.NonEmptyString,
	remoteIndex: Schema.Natural,
})
export const Transfer = Schema.Struct({
	format: Schema.Literal("openbot-apps-v1"),
	apps: Schema.Array(Entry).check(Schema.isMaxLength(30)),
})
export type Transfer = typeof Transfer.Type
