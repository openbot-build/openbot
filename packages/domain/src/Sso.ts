import { Schema, SchemaTransformation } from "effect"
import { ClientId, Issuer } from "./Settings.ts"
import { SecretInput, SecretState } from "./Secret.ts"
import { Version } from "./Version.ts"

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

export class DomainNotFound extends Schema.TaggedError<
	DomainNotFound,
	{ readonly brand: unique symbol }
>()("DomainNotFound", {
	domain: Schema.String.pipe(
		Schema.decodeTo(EmailDomain, SchemaTransformation.toLowerCase()),
	),
}) {}
/** Another organization already verified this domain. */
export class DomainTaken extends Schema.TaggedError<
	DomainTaken,
	{ readonly brand: unique symbol }
>()("DomainTaken", {
	domain: Schema.String.pipe(
		Schema.decodeTo(EmailDomain, SchemaTransformation.toLowerCase()),
	),
}) {}
/** OpenBot did not find the TXT record. DNS changes can take some time. */
export class DomainNotVerified extends Schema.TaggedError<
	DomainNotVerified,
	{ readonly brand: unique symbol }
>()("DomainNotVerified", {
	domain: Schema.String.pipe(
		Schema.decodeTo(EmailDomain, SchemaTransformation.toLowerCase()),
	),
}) {}
/** An SSO connection still uses the domain. */
export class DomainInUse extends Schema.TaggedError<
	DomainInUse,
	{ readonly brand: unique symbol }
>()("DomainInUse", {
	domain: Schema.String.pipe(
		Schema.decodeTo(EmailDomain, SchemaTransformation.toLowerCase()),
	),
}) {}
export class SsoConnectionNotFound extends Schema.TaggedError<
	SsoConnectionNotFound,
	{ readonly brand: unique symbol }
>()("SsoConnectionNotFound", { connectionId: Schema.String }) {}
export class SsoConnectionConflict extends Schema.TaggedError<
	SsoConnectionConflict,
	{ readonly brand: unique symbol }
>()("SsoConnectionConflict", { version: Version }) {}
/** The value is not valid, such as a domain that is not verified or that another connection uses. */
export class SsoConnectionInvalid extends Schema.TaggedError<
	SsoConnectionInvalid,
	{ readonly brand: unique symbol }
>()("SsoConnectionInvalid", { message: Schema.String }) {}
export class SsoUnavailable extends Schema.TaggedError<
	SsoUnavailable,
	{ readonly brand: unique symbol }
>()("SsoUnavailable", {}) {}
