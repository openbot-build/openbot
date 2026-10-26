import { ConnectionId } from "./ConnectionId.ts"
export { ConnectionId } from "./ConnectionId.ts"
import { App, Discovery, Document } from "@openbot-build/protocol"
import { Schema, String as Str } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { AppDiscoveryFailed, AppDiscoveryResult } from "./AppsApi.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { Restriction } from "./AppIndexApi.ts"
import { Required, own } from "./Authorization.ts"

export const ConnectionName = Schema.String.check(
	Schema.isMaxLength(80),
	Schema.makeFilter(
		(value) => Str.isNonEmpty(Str.trim(value)) || "Enter a connection name.",
	),
)
export const Values = Schema.Record(Schema.String, Schema.String)
export const ConnectionDraft = Schema.Struct({
	id: Schema.NonEmptyString,
	revision: Schema.Natural,
	input: Schema.NonEmptyString,
	discovery: AppDiscoveryResult,
	expiresAt: Schema.Finite,
	imported: Schema.optionalKey(
		Schema.Struct({ name: ConnectionName, remoteIndex: Schema.Natural }),
	),
})
export type ConnectionDraft = typeof ConnectionDraft.Type
export const Availability = Schema.TaggedUnion({
	PendingConfiguration: {},
	PendingAuthorization: { scopes: Schema.Array(Schema.String) },
	Unverified: {},
	Available: { checkedAt: Schema.Finite, revision: Schema.Natural },
	AuthorizationExpired: {},
	ConnectionFailed: { message: Schema.String },
	NeedsRevalidation: {},
	CleanupPending: { stage: App.CleanupStage },
	Restricted: { restriction: Restriction },
})
const HeaderName = Schema.String.check(
	Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
)
const HeaderValue = Schema.String.check(Schema.isPattern(/^[^\r\n]*$/))
export const ManualConfiguration = Schema.Struct({
	name: ConnectionName,
	url: Document.Link,
	transport: Schema.Literal("streamable-http"),
	headers: Schema.Record(HeaderName, HeaderValue),
})
export type ManualConfiguration = typeof ManualConfiguration.Type
export const ManualConnectionRequest = Schema.Struct({
	id: ConnectionId.check(Schema.isUUID()),
	...ManualConfiguration.fields,
})
export type ManualConnectionRequest = typeof ManualConnectionRequest.Type
export const ManualConnectionUpdate = Schema.Struct({
	revision: Schema.Natural,
	...ManualConfiguration.fields,
	headers: Schema.Record(HeaderName, Schema.NullOr(HeaderValue)),
})
export type ManualConnectionUpdate = typeof ManualConnectionUpdate.Type
const ManualIdentity = Schema.String.check(
	Schema.isPattern(/^urn:openbot:manual:[0-9a-f-]{36}$/i),
)
export const Connection = Schema.Struct({
	id: ConnectionId,
	name: ConnectionName,
	cardUrl: Schema.Union([Document.Link, ManualIdentity]),
	card: Document.ServerCard,
	endpoint: Schema.String,
	remoteIndex: Schema.Natural,
	sources: Schema.Array(Discovery.Source),
	configuration: Values,
	enabled: Schema.Boolean,
	revision: Schema.Natural,
	availability: Availability,
})
export type Connection = typeof Connection.Type
export const ConnectionRequest = Schema.Struct({
	draftId: Schema.NonEmptyString,
	revision: Schema.Natural,
	cardUrl: Document.Link,
	remoteIndex: Schema.Natural,
	name: ConnectionName,
	values: Values,
	confirmed: Schema.Literal(true),
})
export type ConnectionRequest = typeof ConnectionRequest.Type
export const ConnectionUpdate = Schema.Struct({
	revision: Schema.Natural,
	name: ConnectionName,
	enabled: Schema.Boolean,
})
export type ConnectionUpdate = typeof ConnectionUpdate.Type
export const Capabilities = Schema.Struct({
	connection: Connection,
	protocolVersion: Schema.String,
	tools: Schema.Array(Schema.JsonObject),
	resources: Schema.Array(Schema.JsonObject),
	resourceTemplates: Schema.Array(Schema.JsonObject),
	prompts: Schema.Array(Schema.JsonObject),
})
export type Capabilities = typeof Capabilities.Type
export const Verification = Schema.TaggedUnion({
	Verified: { capabilities: Capabilities },
	Unavailable: { connection: Connection },
})
export type Verification = typeof Verification.Type
export const RevalidationRequest = Schema.Struct({
	revision: Schema.Natural,
	draftId: Schema.NonEmptyString,
	remoteIndex: Schema.Natural,
	values: Values,
	confirmed: Schema.Literal(true),
})
export type RevalidationRequest = typeof RevalidationRequest.Type

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
export class AppRestricted extends Schema.TaggedError<
	AppRestricted,
	{ readonly brand: unique symbol }
>()("AppRestricted", { restriction: Restriction }) {}
export class ConnectionCleanupPending extends Schema.TaggedError<
	ConnectionCleanupPending,
	{ readonly brand: unique symbol }
>()("ConnectionCleanupPending", {
	connectionId: ConnectionId,
	stage: App.CleanupStage,
	message: Schema.String,
}) {}
export const Errors = [
	ConnectionCleanupPending.pipe(HttpApiSchema.status(409)),
	AppRestricted.pipe(HttpApiSchema.status(403)),
	...ExperienceErrors,
	AppDiscoveryFailed.pipe(HttpApiSchema.status(422)),
	ConnectionConflict.pipe(HttpApiSchema.status(409)),
	ConnectionConfigurationInvalid.pipe(HttpApiSchema.status(422)),
] as const
export const connectionParams = { connectionId: ConnectionId }
export class ConnectionsApi extends HttpApiGroup.make("connections").add(
	HttpApiEndpoint.post("createManualConnection", "/v1/connections/manual", {
		payload: ManualConnectionRequest,
		success: Connection.pipe(HttpApiSchema.status(201)),
		error: Errors,
	}).annotate(Required, [own("write", "Connection")]),
	HttpApiEndpoint.put(
		"updateManualConnection",
		"/v1/connections/:connectionId/manual",
		{
			params: connectionParams,
			payload: ManualConnectionUpdate,
			success: Connection,
			error: Errors,
		},
	),
	HttpApiEndpoint.post(
		"verifyConnection",
		"/v1/connections/:connectionId/verify",
		{
			params: connectionParams,
			success: Verification,
			error: Errors,
		},
	),
	HttpApiEndpoint.post(
		"refreshConnectionAuthorization",
		"/v1/connections/:connectionId/refresh",
		{
			params: connectionParams,
			success: Connection,
			error: Errors,
		},
	),
	HttpApiEndpoint.post(
		"revalidateConnection",
		"/v1/connections/:connectionId/revalidate",
		{
			params: connectionParams,
			payload: RevalidationRequest,
			success: Connection,
			error: Errors,
		},
	),
	HttpApiEndpoint.get("listConnections", "/v1/connections", {
		success: Schema.Array(Connection),
		error: Errors,
	}).annotate(Required, [own("read", "Connection")]),
	HttpApiEndpoint.post("prepareConnection", "/v1/connection-drafts", {
		payload: Schema.Struct({ input: Schema.NonEmptyString }),
		success: ConnectionDraft.pipe(HttpApiSchema.status(201)),
		error: Errors,
	}).annotate(Required, [own("write", "Connection")]),
	HttpApiEndpoint.get("getConnectionDraft", "/v1/connection-drafts/:draftId", {
		params: { draftId: Schema.NonEmptyString },
		success: ConnectionDraft,
		error: Errors,
	}).annotate(Required, [own("read", "Connection")]),
	HttpApiEndpoint.post("createConnection", "/v1/connections", {
		payload: ConnectionRequest,
		success: Connection.pipe(HttpApiSchema.status(201)),
		error: Errors,
	}).annotate(Required, [own("write", "Connection")]),
	HttpApiEndpoint.get("getConnection", "/v1/connections/:connectionId", {
		params: connectionParams,
		success: Connection,
		error: Errors,
	}),
	HttpApiEndpoint.put("updateConnection", "/v1/connections/:connectionId", {
		params: connectionParams,
		payload: ConnectionUpdate,
		success: Connection,
		error: Errors,
	}),
	HttpApiEndpoint.delete("deleteConnection", "/v1/connections/:connectionId", {
		params: connectionParams,
		success: HttpApiSchema.NoContent,
		error: Errors,
	}),
) {}
