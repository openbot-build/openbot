import {
	AppAuthorizations,
	AppConnections,
	Execution,
} from "@openbot-build/domain"
import { errors as ExecutionErrors } from "./ExecutionsApi.ts"
import { AppIndex } from "@openbot-build/domain"
import { ConnectionId } from "./ConnectionId.ts"
export { ConnectionId } from "./ConnectionId.ts"
import { Discovery, Document } from "@openbot-build/protocol"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { AppDiscoveryFailed, AppDiscoveryResult } from "./AppsApi.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { AuthorizationErrors, Required, own } from "./Authorization.ts"

export const ConnectionName = AppConnections.ConnectionName
export const Values = Schema.Record(Schema.String, Schema.String)
export const ConnectionDraft = Schema.Struct({
	...AppConnections.DraftState.fields,
	discovery: AppDiscoveryResult,
})
export type ConnectionDraft = typeof ConnectionDraft.Type
export const Availability = AppConnections.Availability
const HeaderName = Schema.String.check(
	Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
)
const HeaderValue = Schema.String.check(Schema.isPattern(/^[^\r\n]*$/))
export const ManualConfiguration = Schema.Struct({
	...AppConnections.ManualConfiguration.fields,
	url: Document.Link,
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
	draftId: AppConnections.DraftId,
	revision: Schema.Natural,
	cardUrl: Document.Link,
	remoteIndex: Schema.Natural,
	name: ConnectionName,
	values: Values,
	confirmed: Schema.Literal(true),
})
export type ConnectionRequest = typeof ConnectionRequest.Type
export const ConnectionUpdate = AppConnections.Update
export type ConnectionUpdate = typeof ConnectionUpdate.Type
export const RevalidationRequest = AppConnections.Revalidation
export type RevalidationRequest = typeof RevalidationRequest.Type

export const ConnectionConflict = AppConnections.ConnectionConflict
export type ConnectionConflict = AppConnections.ConnectionConflict
export const ConnectionConfigurationInvalid =
	AppConnections.ConnectionConfigurationInvalid
export type ConnectionConfigurationInvalid =
	AppConnections.ConnectionConfigurationInvalid
export const AppRestricted = AppIndex.AppRestricted
export type AppRestricted = AppIndex.AppRestricted
export const ConnectionCleanupPending = AppConnections.ConnectionCleanupPending
export type ConnectionCleanupPending = AppConnections.ConnectionCleanupPending
export const Errors = [
	ConnectionCleanupPending.pipe(HttpApiSchema.status(409)),
	AppRestricted.pipe(HttpApiSchema.status(403)),
	...ExperienceErrors,
	AppDiscoveryFailed.pipe(HttpApiSchema.status(422)),
	ConnectionConflict.pipe(HttpApiSchema.status(409)),
	ConnectionConfigurationInvalid.pipe(HttpApiSchema.status(422)),
] as const
export const ConnectionExecution = Schema.Struct({
	execution: Execution.Record,
	result: Schema.NullOr(AppConnections.Result),
})
export type ConnectionExecution = typeof ConnectionExecution.Type
export const connectionParams = { connectionId: ConnectionId }
export class ConnectionsApi extends HttpApiGroup.make("connections").add(
	HttpApiEndpoint.get(
		"getConnectionExecution",
		"/v1/connections/:connectionId/executions/:executionId",
		{
			params: { ...connectionParams, executionId: Execution.Id },
			success: ConnectionExecution,
			error: [...Errors, ...ExecutionErrors],
		},
	),
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
			payload: Schema.Struct({
				...ManualConnectionUpdate.fields,
				commandKey: Execution.CommandKey,
			}),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [...Errors, ...ExecutionErrors],
		},
	),
	HttpApiEndpoint.post(
		"verifyConnection",
		"/v1/connections/:connectionId/verify",
		{
			params: connectionParams,
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [...Errors, ...ExecutionErrors],
		},
	),
	HttpApiEndpoint.post(
		"refreshConnectionAuthorization",
		"/v1/connections/:connectionId/refresh",
		{
			params: connectionParams,
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [
				...Errors,
				...ExecutionErrors,
				AppAuthorizations.AppAuthorizationFailed.pipe(
					HttpApiSchema.status(422),
				),
			],
		},
	),
	HttpApiEndpoint.post(
		"revalidateConnection",
		"/v1/connections/:connectionId/revalidate",
		{
			params: connectionParams,
			payload: Schema.Struct({
				...RevalidationRequest.fields,
				commandKey: Execution.CommandKey,
			}),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: [...Errors, ...ExecutionErrors],
		},
	),
	HttpApiEndpoint.get("listConnections", "/v1/connections", {
		success: Schema.Array(Connection),
		error: [...Errors, ...AuthorizationErrors],
	}).annotate(Required, []),
	HttpApiEndpoint.post("prepareConnection", "/v1/connection-drafts", {
		payload: Schema.Struct({ input: Schema.NonEmptyString }),
		success: ConnectionDraft.pipe(HttpApiSchema.status(201)),
		error: Errors,
	}).annotate(Required, [own("write", "Connection")]),
	HttpApiEndpoint.get("getConnectionDraft", "/v1/connection-drafts/:draftId", {
		params: { draftId: AppConnections.DraftId },
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
		payload: Schema.Struct({
			...ConnectionUpdate.fields,
			commandKey: Execution.CommandKey,
		}),
		success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
		error: [...Errors, ...ExecutionErrors],
	}),
	HttpApiEndpoint.delete("deleteConnection", "/v1/connections/:connectionId", {
		params: connectionParams,
		payload: Schema.Struct({ commandKey: Execution.CommandKey }),
		success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
		error: [
			...Errors,
			...ExecutionErrors,
			AppAuthorizations.AppAuthorizationFailed.pipe(HttpApiSchema.status(422)),
		],
	}),
) {}
