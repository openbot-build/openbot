import { createHmac } from "node:crypto"
import { Barrier } from "./Barrier.ts"
import * as PrivateSession from "./PrivateSession.ts"
import * as BrowserRoutes from "./BrowserRoutes.ts"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { betterAuth } from "better-auth/minimal"
import { APIError } from "better-auth/api"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { DrizzleQueryError } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { decodeJwt } from "jose"
import {
	Effect,
	Exit,
	Layer,
	Match,
	Option,
	Redacted,
	Predicate,
	Stream,
} from "effect"
import * as tables from "../database/AuthSchema.ts"
import { Auth } from "./Auth.ts"
import { Organization } from "../organization/Organization.ts"
import { PlatformAdmins } from "../platform/PlatformAdmins.ts"
import { Settings } from "../settings/Settings.ts"
import {
	type Connection as SsoConnection,
	connectionFor,
	Sso,
} from "../sso/Sso.ts"
import { developmentLogin } from "./DevelopmentLogin.ts"
import { type ResolvedConfiguration } from "./Configuration.ts"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"

/** SDK rejections go to the typed error channel. Programming errors stay defects. */
const attempt = <A, E>(
	run: (signal: AbortSignal) => Promise<A>,
	onApiError: (error: APIError) => E,
): Effect.Effect<A, E | AuthUnavailable> =>
	Effect.flatten(
		Effect.promise((signal) =>
			run(signal).then(
				(value) => Exit.succeed(value),
				(cause: unknown): Exit.Exit<never, E | AuthUnavailable> =>
					cause instanceof APIError
						? Exit.fail(onApiError(cause))
						: cause instanceof DrizzleQueryError ||
							  (Predicate.isError(cause) &&
									Predicate.hasProperty(cause, "code"))
							? Exit.fail(AuthUnavailable.make({ dependency: "storage" }))
							: Exit.die(cause),
			),
		),
	)

/** One OpenID Connect provider for Better Auth: the platform provider, or the SSO connection of an organization. */
interface OidcProvider {
	readonly providerId: string
	readonly redirectUri?: string
	readonly issuer: string
	readonly clientId: string
	readonly clientSecret: Redacted.Redacted<string> | undefined
}

const oidcConfig = (provider: OidcProvider, publicOrigin: string) => ({
	providerId: provider.providerId,
	clientId: provider.clientId,
	clientSecret:
		provider.clientSecret === undefined
			? undefined
			: Redacted.value(provider.clientSecret),
	discoveryUrl: provider.issuer + "/.well-known/openid-configuration",
	redirectURI:
		provider.redirectUri ??
		publicOrigin + "/auth/callback/" + provider.providerId,
	scopes: ["openid", "profile", "email"],
	pkce: true,
	requireIdTokenVerification: true,
	accountSubject: ({
		tokens,
		profile,
	}: {
		readonly tokens: { readonly idToken?: string | undefined }
		readonly profile: { readonly sub?: unknown }
	}) => {
		if (tokens.idToken === undefined) return ""
		// Generic OAuth checks the ID token before it finds the account subject.
		const claims = decodeJwt(tokens.idToken)
		return claims.sub === profile.sub ? (claims.sub ?? "") : ""
	},
	tokenEndpointAuth: {
		method:
			provider.clientSecret === undefined
				? ("none" as const)
				: ("client_secret_basic" as const),
	},
	disableProviderLogout: true,
})

export const layer = (
	config: ResolvedConfiguration & {
		readonly databaseUrl: Redacted.Redacted<string>
	},
): Layer.Layer<
	Auth,
	AuthUnavailable,
	Organization | PlatformAdmins | Sso | Settings
> =>
	Layer.effect(
		Auth,
		Effect.gen(function* () {
			/** A signed-in account joins organizations by the rules of each one. */
			const organization = yield* Organization
			const admins = yield* PlatformAdmins
			const sso = yield* Sso
			const settings = yield* Settings
			const pool = yield* Effect.acquireRelease(
				Effect.sync(
					() =>
						new Pool({ connectionString: Redacted.value(config.databaseUrl) }),
				),
				// Closing the pool is best-effort cleanup. Log a failure, but do not fail shutdown.
				(pool) =>
					Effect.tryPromise(() => pool.end()).pipe(
						Effect.catch((error) =>
							Effect.logWarning("The auth database pool did not close", error),
						),
					),
			)
			const database = drizzleAdapter(drizzle({ client: pool }), {
				provider: "pg",
				schema: tables,
				transaction: true,
			})

			/** The platform provider and every SSO connection, with open secrets. */
			const loadProviders = Effect.gen(function* () {
				const connections = yield* sso.all
				const providers: Array<OidcProvider> =
					config.mode === "oidc"
						? [
								{
									providerId: config.providerId,
									redirectUri: config.redirectUri,
									issuer: config.issuer,
									clientId: config.clientId,
									clientSecret: config.clientSecret,
								},
							]
						: []
				for (const connection of connections) {
					const secret = yield* sso.openSecret(connection)
					providers.push({
						providerId: connection.id,
						issuer: connection.issuer,
						clientId: connection.clientId,
						clientSecret: Option.getOrUndefined(secret),
					})
				}
				return { connections, providers }
			}).pipe(
				Effect.mapError(() => AuthUnavailable.make({ dependency: "storage" })),
			)

			const make = (providers: ReadonlyArray<OidcProvider>) =>
				betterAuth({
					baseURL: config.publicOrigin,
					basePath: "/auth",
					secret: Redacted.value(config.secret),
					database,
					trustedOrigins: [config.publicOrigin],
					user: { modelName: "openbot_auth_user" },
					session: {
						modelName: "openbot_auth_session",
						expiresIn: config.sessionTtlMs / 1000,
						updateAge: Math.min(24 * 60 * 60, config.sessionTtlMs / 2000),
						cookieCache: { enabled: false },
					},
					account: {
						modelName: "openbot_auth_account",
						accountLinking: { enabled: false },
					},
					verification: { modelName: "openbot_auth_verification" },
					advanced: {
						// Explicit __Host names replace the __Secure prefix that the SDK adds itself.
						useSecureCookies: false,
						defaultCookieAttributes: {
							secure: true,
							httpOnly: true,
							sameSite: "lax",
							path: "/",
						},
						cookies: {
							session_token: { name: config.sessionCookie },
							state: { name: config.loginCookie },
						},
					},
					plugins: [
						...(config.mode === "development" ? [developmentLogin()] : []),
						...(providers.length === 0
							? []
							: [
									genericOAuth({
										config: providers.map((provider) =>
											oidcConfig(provider, config.publicOrigin),
										),
									}),
								]),
					],
				})
			type Sdk = ReturnType<typeof make>
			interface Current {
				readonly key: string
				readonly sdk: Sdk
				readonly connections: ReadonlyArray<SsoConnection>
			}
			const build = Effect.gen(function* () {
				const loaded = yield* loadProviders
				const sdk = make(loaded.providers)
				yield* attempt(
					() => sdk.$context,
					() => AuthUnavailable.make({ dependency: "provider" }),
				)
				return {
					key: JSON.stringify(
						loaded.connections.map((connection) => [
							connection.id,
							connection.version,
						]),
					),
					sdk,
					connections: loaded.connections,
				} satisfies Current
			})
			/**
			 * The Web handler of Better Auth is a plain function, so it reads the
			 * current SDK from a variable. A new SSO connection replaces the SDK.
			 */
			let current: Current = yield* build
			const reload = build.pipe(
				Effect.tap((next) =>
					Effect.sync(() => {
						if (next.key !== current.key) current = next
					}),
				),
				Effect.catchCause((cause) =>
					Effect.logWarning(
						"OpenBot could not load the SSO connections. It keeps the current ones.",
						cause,
					),
				),
			)
			// A missed notice must not keep old connections for ever, so also check from time to time.
			yield* Stream.merge(
				Stream.filter(settings.changes, (scope) => scope.kind === "signIn"),
				Stream.tick("30 seconds"),
			).pipe(
				Stream.runForEach(() => reload),
				Effect.forkScoped,
			)

			const headers = (credential: Redacted.Redacted<string>) =>
				new Headers({
					cookie:
						config.sessionCookie +
						"=" +
						encodeURIComponent(Redacted.value(credential)),
					origin: config.publicOrigin,
				})
			const rejected = () => CredentialRejected.make({ kind: "session" })
			/**
			 * An SSO connection may only sign in people with an email in its own domains.
			 * When a connection enforces SSO, people with an email in its domains may not
			 * use another provider. Accounts are never linked, so each user has one provider.
			 */
			const checkProvider = (user: {
				readonly id: string
				readonly email: string
			}) =>
				Effect.gen(function* () {
					const provider = yield* sso
						.providerOf(user.id)
						.pipe(
							Effect.mapError(() =>
								AuthUnavailable.make({ dependency: "storage" }),
							),
						)
					const byEmail = connectionFor({
						connections: current.connections,
						email: user.email,
					})
					const used = Option.flatMap(provider, (id) =>
						Option.fromNullishOr(
							current.connections.find((connection) => connection.id === id),
						),
					)
					if (Option.isSome(used)) {
						if (byEmail?.id !== used.value.id) return yield* rejected()
						return Option.some(used.value.organizationId)
					}
					if (byEmail?.enforce === true) return yield* rejected()
					return Option.none<string>()
				})

			const barrier = yield* Effect.serviceOption(Barrier)
			if (Option.isSome(barrier))
				yield* barrier.value.register({
					secret: config.secret,
					readSession: (headers) =>
						Effect.tryPromise({
							try: async () => {
								const result = await PrivateSession.read({
									headers,
									context: await current.sdk.$context,
									returnHeaders: true,
								})
								return {
									...result.response,
									setCookies: result.headers.getSetCookie(),
								}
							},
							catch: () => AuthUnavailable.make({ dependency: "storage" }),
						}),
					revocationStatus: (input) =>
						Effect.tryPromise({
							try: async () => {
								const adapter = (await current.sdk.$context).internalAdapter
								const matching = (
									sessions: Awaited<ReturnType<typeof adapter.listSessions>>,
								) =>
									sessions.filter(
										(session) =>
											createHmac("sha256", Redacted.value(input.key))
												.update(session.token)
												.digest("hex") === input.credentialDigest,
									)
								const sessions = matching(
									await adapter.listSessions(input.accountId),
								)
								if (input.retry)
									for (const session of sessions)
										await adapter.deleteSession(session.token)
								return (
									matching(await adapter.listSessions(input.accountId))
										.length === 0
								)
							},
							catch: () => AuthUnavailable.make({ dependency: "storage" }),
						}),
					revokeSession: (input) =>
						Effect.tryPromise({
							try: async () => {
								const result = await PrivateSession.revoke({
									...input,
									key: Redacted.value(input.key),
								})({
									headers: input.headers,
									context: await current.sdk.$context,
									returnHeaders: true,
								})
								return result.headers.getSetCookie()
							},
							catch: () => AuthUnavailable.make({ dependency: "storage" }),
						}),
					profile: {
						...Match.value(config).pipe(
							Match.discriminatorsExhaustive("mode")({
								oidc: (value) => ({
									issuer: value.issuer,
									clientId: value.clientId,
									providerId: value.providerId,
									redirectUri: value.redirectUri,
								}),
								none: (value) => ({
									issuer: "none",
									clientId: "none",
									providerId: "none",
									redirectUri: value.publicOrigin + "/auth/callback",
								}),
								development: (value) => ({
									issuer: "development",
									clientId: "development",
									providerId: "development",
									redirectUri: value.publicOrigin + "/auth/callback",
								}),
							}),
						),
						publicOrigin: config.publicOrigin,
						sessionCookie: config.sessionCookie,
						loginCookie: config.loginCookie,
						basePath: "/auth",
						sdkVersion: "1.7.8",
					},
				})
			const service = Auth.of({
				sessionCookie: config.sessionCookie,
				handler: BrowserRoutes.handler(
					{
						publicOrigin: config.publicOrigin,
						...(config.mode === "oidc"
							? {
									providerId: config.providerId,
									callbackPath: config.callbackPath,
								}
							: {}),
					},
					{
						handler: (request) => current.sdk.handler(request),
						signIn: async (target, headers) => {
							try {
								if (config.mode === "oidc")
									return await current.sdk.api.signInSocial({
										body: {
											provider: config.providerId,
											callbackURL: config.publicOrigin + target,
										},
										headers,
										request: new Request(config.publicOrigin + "/auth/login"),
										asResponse: true,
									})
								if (config.mode !== "development")
									return new Response(null, { status: 503 })
								const response = await current.sdk.api.signInDevelopment({
									headers,
									asResponse: true,
								})
								const result = new Headers(response.headers)
								result.set("location", config.publicOrigin + target)
								return new Response(null, {
									status: response.status,
									headers: result,
								})
							} catch (error) {
								if (
									error instanceof APIError ||
									error instanceof DrizzleQueryError
								)
									return new Response(null, { status: 503 })
								throw error
							}
						},
						signOut: (headers) =>
							current.sdk.api.signOut({ headers, asResponse: true }),
					},
				),
				startSignIn: (input) =>
					attempt(
						() =>
							current.sdk.api.signInSocial({
								body: {
									provider: input.providerId,
									callbackURL: input.returnTo ?? "/",
									disableRedirect: true,
								},
								headers: new Headers({ origin: config.publicOrigin }),
								returnHeaders: true,
							}),
						() => AuthUnavailable.make({ dependency: "provider" }),
					).pipe(
						Effect.flatMap(({ response, headers }) =>
							response.url === undefined
								? Effect.fail(AuthUnavailable.make({ dependency: "provider" }))
								: Effect.succeed({
										url: response.url,
										setCookies: headers.getSetCookie(),
									}),
						),
					),
				signInProvider: (email) =>
					Option.match(
						Option.flatMap(Option.fromNullishOr(email), (email) =>
							Option.fromNullishOr(
								connectionFor({ connections: current.connections, email }),
							),
						),
						{
							onSome: (connection) => Option.some(connection.id),
							onNone: () =>
								config.mode === "oidc"
									? Option.some(config.providerId)
									: Option.none(),
						},
					),
				resolveSession: (credential, options) =>
					attempt(
						() =>
							current.sdk.api.getSession({
								headers: headers(credential),
								query: { disableRefresh: options?.refresh === false },
								returnHeaders: true,
							}),
						() => AuthUnavailable.make({ dependency: "storage" }),
					).pipe(
						Effect.flatMap(({ response: result, headers }) =>
							Effect.gen(function* () {
								if (result === null) return yield* rejected()
								const ssoOrganization = yield* checkProvider(result.user)
								const account = {
									id: result.user.id,
									email: result.user.email,
									name: result.user.name,
									emailVerified: result.user.emailVerified,
								}
								const memberships = yield* organization.admit(
									account,
									Option.match(ssoOrganization, {
										onNone: () => undefined,
										onSome: (only) => ({ only }),
									}),
								)
								const platformAdmin = yield* admins.check(account)
								return {
									userId: result.user.id,
									profile: {
										name: result.user.name,
										email: result.user.email,
										emailVerified: result.user.emailVerified,
									},
									memberships,
									platformAdmin,
									expiresAt: result.session.expiresAt.toISOString(),
									setCookies: headers.getSetCookie(),
								}
							}).pipe(
								Effect.catchTags({
									OrganizationUnavailable: () =>
										Effect.fail(
											AuthUnavailable.make({ dependency: "storage" }),
										),
									PlatformAdminsUnavailable: () =>
										Effect.fail(
											AuthUnavailable.make({ dependency: "storage" }),
										),
								}),
							),
						),
					),
			})
			if (Option.isNone(barrier)) return service
			const fence = barrier.value
			const runWeb = Effect.runPromiseWith(yield* Effect.context<never>())
			return Auth.of({
				...service,
				startSignIn: (input) => fence.wrap(service.startSignIn(input)),
				resolveSession: (...args) =>
					fence.wrap(service.resolveSession(...args)),
				// The Web handler is a Promise boundary; hold the auth lease until the SDK settles.
				handler: (request) =>
					runWeb(
						fence
							.wrap(
								Effect.tryPromise({
									try: () => service.handler(request),
									catch: () => AuthUnavailable.make({ dependency: "storage" }),
								}),
							)
							.pipe(
								Effect.catchTag("AuthUnavailable", () =>
									Effect.succeed(new Response(null, { status: 503 })),
								),
							),
					),
			})
		}),
	)
