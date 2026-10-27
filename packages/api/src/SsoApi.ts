import { Schema, SchemaTransformation } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { AuthorizationErrors } from "./Authorization.ts"
import {
	EmailDomain,
	Domain,
	AddDomainRequest,
	SsoConnection,
	CreateSsoConnectionRequest,
	UpdateSsoConnectionRequest,
	DomainNotFound,
	DomainTaken,
	DomainNotVerified,
	DomainInUse,
	SsoConnectionNotFound,
	SsoConnectionConflict,
	SsoConnectionInvalid,
	SsoUnavailable,
} from "@openbot-build/domain/Sso"
export {
	EmailDomain,
	Domain,
	AddDomainRequest,
	SsoConnection,
	CreateSsoConnectionRequest,
	UpdateSsoConnectionRequest,
	DomainNotFound,
	DomainTaken,
	DomainNotVerified,
	DomainInUse,
	SsoConnectionNotFound,
	SsoConnectionConflict,
	SsoConnectionInvalid,
	SsoUnavailable,
} from "@openbot-build/domain/Sso"

const errors = [
	...AuthorizationErrors,
	DomainNotFound.pipe(HttpApiSchema.status(404)),
	DomainTaken.pipe(HttpApiSchema.status(409)),
	DomainNotVerified.pipe(HttpApiSchema.status(409)),
	DomainInUse.pipe(HttpApiSchema.status(409)),
	SsoConnectionNotFound.pipe(HttpApiSchema.status(404)),
	SsoConnectionConflict.pipe(HttpApiSchema.status(409)),
	SsoConnectionInvalid.pipe(HttpApiSchema.status(400)),
	SsoUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const DomainParams = {
	domain: Schema.String.pipe(
		Schema.decodeTo(EmailDomain, SchemaTransformation.toLowerCase()),
	),
}
const ConnectionParams = { connectionId: Schema.String }

export class SsoApi extends HttpApiGroup.make("sso").add(
	HttpApiEndpoint.get("listDomains", "/v1/organization/domains", {
		success: Schema.Struct({ items: Schema.Array(Domain) }),
		error: errors,
	}),
	HttpApiEndpoint.post("addDomain", "/v1/organization/domains", {
		payload: AddDomainRequest,
		success: Domain,
		error: errors,
	}).annotate(
		OpenApi.Description,
		"Adds an email domain. Then add the TXT record that the answer names, and call the verify endpoint.",
	),
	HttpApiEndpoint.post(
		"verifyDomain",
		"/v1/organization/domains/:domain/verify",
		{ params: DomainParams, success: Domain, error: errors },
	).annotate(
		OpenApi.Description,
		"Looks up the TXT record of the domain. When it is right, the domain becomes verified.",
	),
	HttpApiEndpoint.delete("removeDomain", "/v1/organization/domains/:domain", {
		params: DomainParams,
		success: HttpApiSchema.NoContent,
		error: errors,
	}),
	HttpApiEndpoint.get(
		"listSsoConnections",
		"/v1/organization/sso_connections",
		{
			success: Schema.Struct({ items: Schema.Array(SsoConnection) }),
			error: errors,
		},
	),
	HttpApiEndpoint.get(
		"getSsoConnection",
		"/v1/organization/sso_connections/:connectionId",
		{ params: ConnectionParams, success: SsoConnection, error: errors },
	),
	HttpApiEndpoint.post(
		"createSsoConnection",
		"/v1/organization/sso_connections",
		{
			payload: CreateSsoConnectionRequest,
			success: SsoConnection,
			error: errors,
		},
	).annotate(
		OpenApi.Description,
		"Adds an OpenID Connect provider for people with an email in verified domains of the organization.",
	),
	HttpApiEndpoint.patch(
		"updateSsoConnection",
		"/v1/organization/sso_connections/:connectionId",
		{
			params: ConnectionParams,
			payload: UpdateSsoConnectionRequest,
			success: SsoConnection,
			error: errors,
		},
	),
	HttpApiEndpoint.delete(
		"deleteSsoConnection",
		"/v1/organization/sso_connections/:connectionId",
		{
			params: ConnectionParams,
			success: HttpApiSchema.NoContent,
			error: errors,
		},
	),
) {}
