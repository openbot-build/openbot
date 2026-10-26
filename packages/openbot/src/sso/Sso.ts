import type { SsoApi } from "@openbot-build/api"
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
	readonly enforce: boolean
	readonly version: number
	readonly createdAt: number
	readonly updatedAt: number
}

export type Errors =
	| SsoApi.DomainNotFound
	| SsoApi.DomainTaken
	| SsoApi.DomainNotVerified
	| SsoApi.DomainInUse
	| SsoApi.SsoConnectionNotFound
	| SsoApi.SsoConnectionConflict
	| SsoApi.SsoConnectionInvalid
	| SsoApi.SsoUnavailable

/** The TXT record that proves control of a domain. */
export const recordName = (domain: string) => "_openbot-verification." + domain

/** The email domains and SSO connections of organizations. */
export class Sso extends Context.Service<
	Sso,
	{
		readonly listDomains: (
			organizationId: string,
		) => Effect.Effect<ReadonlyArray<SsoApi.Domain>, SsoApi.SsoUnavailable>
		readonly addDomain: (
			organizationId: string,
			domain: string,
		) => Effect.Effect<SsoApi.Domain, Errors>
		/** Looks up the TXT record. Only one organization can verify a domain. */
		readonly verifyDomain: (
			organizationId: string,
			domain: string,
		) => Effect.Effect<SsoApi.Domain, Errors>
		readonly removeDomain: (
			organizationId: string,
			domain: string,
		) => Effect.Effect<void, Errors>
		readonly listConnections: (
			organizationId: string,
		) => Effect.Effect<ReadonlyArray<Connection>, SsoApi.SsoUnavailable>
		readonly getConnection: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Connection>, SsoApi.SsoUnavailable>
		readonly createConnection: (
			organizationId: string,
			input: SsoApi.CreateSsoConnectionRequest,
		) => Effect.Effect<Connection, Errors>
		readonly updateConnection: (
			organizationId: string,
			id: string,
			patch: SsoApi.UpdateSsoConnectionRequest,
		) => Effect.Effect<Connection, Errors>
		readonly deleteConnection: (
			organizationId: string,
			id: string,
		) => Effect.Effect<void, Errors>
		/** Every connection of the platform, for the sign-in service. */
		readonly all: Effect.Effect<
			ReadonlyArray<Connection>,
			SsoApi.SsoUnavailable
		>
		readonly openSecret: (
			connection: Connection,
		) => Effect.Effect<
			Option.Option<Redacted.Redacted<string>>,
			SsoApi.SsoUnavailable
		>
		/** The sign-in provider of the account of a user, such as `oidc` or a connection ID. */
		readonly providerOf: (
			userId: string,
		) => Effect.Effect<Option.Option<string>, SsoApi.SsoUnavailable>
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
