import type { ProviderAccess } from "@openbot-build/domain/Access"
import type { Sso as SsoModel } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	type Effect,
	type Option,
	pipe,
	type Redacted,
	String as Str,
} from "effect"

/** A stored SSO connection. The client secret stays sealed until sign-in needs it. */
export interface Connection {
	readonly id: string
	readonly organizationId: string
	readonly name: string
	readonly issuer: string
	readonly clientId: string
	readonly clientSecret: string | null
	readonly clientSecretHint: string | null
	readonly domains: ReadonlyArray<string>
	readonly access?: ProviderAccess
	readonly enforce: boolean
	readonly version: number
	readonly createdAt: number
	readonly updatedAt: number
}

export type Errors =
	| SsoModel.DomainNotFound
	| SsoModel.DomainTaken
	| SsoModel.DomainNotVerified
	| SsoModel.DomainInUse
	| SsoModel.SsoConnectionNotFound
	| SsoModel.SsoConnectionConflict
	| SsoModel.SsoConnectionInvalid
	| SsoModel.SsoUnavailable

/** The TXT record that proves control of a domain. */
export const recordName = (domain: string) => "_openbot-verification." + domain

/** The email domains and SSO connections of organizations. */
export class Sso extends Context.Service<
	Sso,
	{
		readonly listDomains: (
			organizationId: string,
		) => Effect.Effect<ReadonlyArray<SsoModel.Domain>, SsoModel.SsoUnavailable>
		readonly addDomain: (
			organizationId: string,
			domain: string,
		) => Effect.Effect<SsoModel.Domain, Errors>
		/** Looks up the TXT record. Only one organization can verify a domain. */
		readonly verifyDomain: (
			organizationId: string,
			domain: string,
		) => Effect.Effect<SsoModel.Domain, Errors>
		readonly removeDomain: (
			organizationId: string,
			domain: string,
		) => Effect.Effect<void, Errors>
		readonly listConnections: (
			organizationId: string,
		) => Effect.Effect<ReadonlyArray<Connection>, SsoModel.SsoUnavailable>
		readonly getConnection: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Connection>, SsoModel.SsoUnavailable>
		readonly createConnection: (
			organizationId: string,
			input: SsoModel.CreateSsoConnectionRequest,
		) => Effect.Effect<Connection, Errors>
		readonly updateConnection: (
			organizationId: string,
			id: string,
			patch: SsoModel.UpdateSsoConnectionRequest,
		) => Effect.Effect<Connection, Errors>
		readonly deleteConnection: (
			organizationId: string,
			id: string,
		) => Effect.Effect<void, Errors>
		/** Every connection of the platform, for the sign-in service. */
		readonly all: Effect.Effect<
			ReadonlyArray<Connection>,
			SsoModel.SsoUnavailable
		>
		readonly openSecret: (
			connection: Connection,
		) => Effect.Effect<
			Option.Option<Redacted.Redacted<string>>,
			SsoModel.SsoUnavailable
		>
		/** The sign-in provider of the account of a user, such as `oidc` or a connection ID. */
		readonly providerOf: (
			userId: string,
		) => Effect.Effect<Option.Option<string>, SsoModel.SsoUnavailable>
	}
>()("@openbot-build/openbot/sso/Sso") {}

/** The connection that signs in people with this email, if there is one. */
export const connectionFor = ({
	connections,
	email,
}: {
	readonly connections: ReadonlyArray<Connection>
	readonly email: string
}) => {
	const domain = pipe(email, Str.split("@"), Arr.lastNonEmpty, Str.toLowerCase)
	return Arr.findFirst(connections, (connection) =>
		connection.domains.includes(domain),
	)
}
