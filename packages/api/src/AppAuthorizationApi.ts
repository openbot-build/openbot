import { AppAuthorizations, Execution } from "@openbot-build/domain"
import { errors as ExecutionErrors } from "./ExecutionsApi.ts"
import { SettingsUnavailable } from "./SettingsErrors.ts"
import { Authorization, Document } from "@openbot-build/protocol"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { NoStore } from "./AuthApi.ts"
import {
	Errors as ConnectionErrors,
	connectionParams,
} from "./ConnectionsApi.ts"
import { Required, own } from "./Authorization.ts"

export const Request = Schema.Struct({
	...AppAuthorizations.Begin.fields,
	issuer: Schema.optionalKey(Document.Link),
	commandKey: Execution.CommandKey,
})
export type Request = typeof Request.Type
export const Started = AppAuthorizations.Started
export type Started = AppAuthorizations.Started
export const State = AppAuthorizations.State
export type State = AppAuthorizations.State
export const Revocation = AppAuthorizations.Revocation
export type Revocation = AppAuthorizations.Revocation
export const Action = AppAuthorizations.Action
export type Action = AppAuthorizations.Action
export const AppAuthorizationFailed = AppAuthorizations.AppAuthorizationFailed
export type AppAuthorizationFailed = AppAuthorizations.AppAuthorizationFailed
export const AppAuthorizationUnavailable =
	AppAuthorizations.AppAuthorizationUnavailable
export type AppAuthorizationUnavailable =
	AppAuthorizations.AppAuthorizationUnavailable
export const Errors = [
	...ExecutionErrors,
	AppAuthorizationUnavailable.pipe(HttpApiSchema.status(503)),
	...ConnectionErrors,
	AppAuthorizationFailed.pipe(HttpApiSchema.status(422)),
] as const

export const AppAuthorizationApi = HttpApiGroup.make("appAuthorization").add(
	HttpApiEndpoint.get(
		"getAppAuthorizationAction",
		"/v1/app-authorization-actions/:executionId",
		{ params: { executionId: Execution.Id }, success: Action, error: Errors },
	).annotate(Required, [own("read", "Connection")]),
	HttpApiEndpoint.post(
		"beginAppAuthorization",
		"/v1/connections/:connectionId/authorization",
		{
			params: connectionParams,
			payload: Request,
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
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
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: Errors,
		},
	).annotate(Required, [own("write", "Connection")]),
	HttpApiEndpoint.delete(
		"revokeAppAuthorization",
		"/v1/connections/:connectionId/authorization",
		{
			params: connectionParams,
			payload: Schema.Struct({ commandKey: Execution.CommandKey }),
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: Errors,
		},
	),
)
export const AppAuthorizationPublicApi = HttpApiGroup.make(
	"appAuthorizationPublic",
).add(
	HttpApiEndpoint.get("appClientMetadata", "/v1/apps/client-metadata", {
		success: Authorization.ClientMetadata,
		error: SettingsUnavailable.pipe(HttpApiSchema.status(503)),
	}),
	HttpApiEndpoint.get("appAuthorizationCallback", "/auth/apps/callback", {
		success: HttpApiSchema.Empty(303),
		error: Errors,
	}).middleware(NoStore),
)
