import { Authorization, Document } from "@openbot-build/protocol"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { ReturnTo, NoStore } from "./AuthApi.ts"
import {
	Errors as ConnectionErrors,
	connectionParams,
} from "./ConnectionsApi.ts"
import { Required, own } from "./Authorization.ts"

export const Request = Schema.Struct({
	revision: Schema.Natural,
	scopes: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(50)),
	issuer: Schema.optionalKey(Document.Link),
	returnTo: Schema.optionalKey(ReturnTo),
})
export type Request = typeof Request.Type
export const Started = Schema.TaggedUnion({
	AuthorizationStarted: {
		flowId: Schema.NonEmptyString,
		authorizationUrl: Document.Link,
		issuer: Document.Link,
		scopes: Schema.Array(Schema.String),
	},
	IssuerSelectionRequired: {
		issuers: Schema.NonEmptyArray(Document.Link),
		scopes: Schema.Array(Schema.String),
	},
	AuthorizationNotRequired: {},
})
export type Started = typeof Started.Type
export const State = Schema.Struct({
	flowId: Schema.NonEmptyString,
	connectionId: Schema.NonEmptyString,
	returnTo: ReturnTo,
	expiresAt: Schema.Finite,
	issuer: Document.Link,
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
export const Errors = [
	AppAuthorizationUnavailable.pipe(HttpApiSchema.status(503)),
	...ConnectionErrors,
	AppAuthorizationFailed.pipe(HttpApiSchema.status(422)),
] as const

export const AppAuthorizationApi = HttpApiGroup.make("appAuthorization").add(
	HttpApiEndpoint.post(
		"beginAppAuthorization",
		"/v1/connections/:connectionId/authorization",
		{
			params: connectionParams,
			payload: Request,
			success: Started,
			error: Errors,
		},
	),
	HttpApiEndpoint.get("getAppAuthorization", "/v1/app-authorizations/:flowId", {
		params: { flowId: Schema.NonEmptyString },
		success: State,
		error: Errors,
	}).annotate(Required, [own("read", "Connection")]),
	HttpApiEndpoint.post(
		"completeAppAuthorization",
		"/v1/app-authorizations/:flowId/complete",
		{
			params: { flowId: Schema.NonEmptyString },
			success: State,
			error: Errors,
		},
	).annotate(Required, [own("write", "Connection")]),
	HttpApiEndpoint.delete(
		"revokeAppAuthorization",
		"/v1/connections/:connectionId/authorization",
		{
			params: connectionParams,
			success: Revocation,
			error: Errors,
		},
	),
)
export const AppAuthorizationPublicApi = HttpApiGroup.make(
	"appAuthorizationPublic",
).add(
	HttpApiEndpoint.get("appClientMetadata", "/v1/apps/client-metadata", {
		success: Authorization.ClientMetadata,
	}),
	HttpApiEndpoint.get("appAuthorizationCallback", "/auth/apps/callback", {
		success: HttpApiSchema.Empty(303),
		error: Errors,
	}).middleware(NoStore),
)
