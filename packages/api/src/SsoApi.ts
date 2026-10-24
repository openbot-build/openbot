import { Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { AuthorizationErrors } from "./Authorization.ts"
import {
	ClientId,
	Issuer,
	SecretInput,
	SecretState,
	Version,
} from "./Settings.ts"

export const EmailDomain = Schema.String.check(
	Schema.isPattern(/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/),
)

/**
 * An email domain of the organization. It must be verified with a DNS TXT record
 * before it does anything. One domain can belong to only one organization.
 */
export const Domain = Schema.Struct({
	domain: EmailDomain,
	/** Add a TXT record with this name. */
	recordName: Schema.String,
	/** Put this value in the TXT record. */
	recordValue: Schema.String,
	verifiedAt: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
})
export type Domain = typeof Domain.Type
export const AddDomainRequest = Schema.Struct({ domain: EmailDomain })

/** An OpenID Connect provider of the organization, used for people with an email in its domains. */
export const SsoConnection = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	issuer: Schema.String,
	clientId: Schema.String,
	clientSecret: SecretState,
	/** Verified domains of the organization. People with an email in them sign in here. */
	domains: Schema.Array(EmailDomain),
	/** When true, people with an email in these domains cannot use the sign-in provider of the platform. */
	enforce: Schema.Boolean,
	/** Add this address to the allowed redirect URIs of the client at the provider. */
	redirectUri: Schema.String,
	version: Version,
	createdAt: Schema.String,
	updatedAt: Schema.String,
})
export type SsoConnection = typeof SsoConnection.Type
const ConnectionName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(120),
)
const ConnectionDomains = Schema.Array(EmailDomain).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(50),
)
export const CreateSsoConnectionRequest = Schema.Struct({
	name: ConnectionName,
	issuer: Issuer,
	clientId: ClientId,
	/** Leave it out for a public client that uses PKCE only. */
	clientSecret: Schema.optionalKey(SecretInput),
	domains: ConnectionDomains,
	enforce: Schema.Boolean,
})
export type CreateSsoConnectionRequest = typeof CreateSsoConnectionRequest.Type
export const UpdateSsoConnectionRequest = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(ConnectionName),
	issuer: Schema.optionalKey(Issuer),
	clientId: Schema.optionalKey(ClientId),
	/** Leave it out to keep the current secret. Send null for a public client. */
	clientSecret: Schema.optionalKey(Schema.NullOr(SecretInput)),
	domains: Schema.optionalKey(ConnectionDomains),
	enforce: Schema.optionalKey(Schema.Boolean),
})
export type UpdateSsoConnectionRequest = typeof UpdateSsoConnectionRequest.Type

export class DomainNotFound extends Schema.TaggedError<DomainNotFound>()(
	"DomainNotFound",
	{ domain: Schema.String },
) {}
/** Another organization already verified this domain. */
export class DomainTaken extends Schema.TaggedError<DomainTaken>()(
	"DomainTaken",
	{ domain: Schema.String },
) {}
/** OpenBot did not find the TXT record. DNS changes can take some time. */
export class DomainNotVerified extends Schema.TaggedError<DomainNotVerified>()(
	"DomainNotVerified",
	{ domain: Schema.String },
) {}
/** An SSO connection still uses the domain. */
export class DomainInUse extends Schema.TaggedError<DomainInUse>()(
	"DomainInUse",
	{ domain: Schema.String },
) {}
export class SsoConnectionNotFound extends Schema.TaggedError<SsoConnectionNotFound>()(
	"SsoConnectionNotFound",
	{ connectionId: Schema.String },
) {}
export class SsoConnectionConflict extends Schema.TaggedError<SsoConnectionConflict>()(
	"SsoConnectionConflict",
	{ version: Version },
) {}
/** The value is not valid, such as a domain that is not verified or that another connection uses. */
export class SsoConnectionInvalid extends Schema.TaggedError<SsoConnectionInvalid>()(
	"SsoConnectionInvalid",
	{ message: Schema.String },
) {}
export class SsoUnavailable extends Schema.TaggedError<SsoUnavailable>()(
	"SsoUnavailable",
	{},
) {}
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

const DomainParams = { domain: Schema.String }
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
