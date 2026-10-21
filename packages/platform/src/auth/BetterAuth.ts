import { createHmac } from "node:crypto"
import * as PrivateSession from "./PrivateSession.ts"
import { Barrier } from "./Barrier.ts"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { betterAuth } from "better-auth/minimal"
import { APIError } from "better-auth/api"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { DrizzleQueryError } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { decodeJwt } from "jose"
import { Effect, Exit, Layer, Match, Redacted, Predicate, Option } from "effect"
import * as tables from "../database/AuthSchema.ts"
import { Auth } from "./Auth.ts"
import { Organization } from "../organization/Organization.ts"
import { developmentLogin } from "./DevelopmentLogin.ts"
import { type ResolvedConfiguration } from "./Configuration.ts"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"

import * as BrowserRoutes from "./BrowserRoutes.ts"

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

export const layer = (
	config: ResolvedConfiguration & {
		readonly databaseUrl: Redacted.Redacted<string>
	},
): Layer.Layer<Auth, AuthUnavailable, Organization> =>
	Layer.effect(
		Auth,
		Effect.gen(function* () {
			/** Every signed-in account must be a member of the organization. */
			const organization = yield* Organization
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
			const plugins = [
				...Match.value(config).pipe(
					Match.discriminatorsExhaustive("mode")({
						oidc: (config) => [
							genericOAuth({
								config: [
									{
										providerId: config.providerId,
										clientId: config.clientId,
										clientSecret:
											config.clientSecret === undefined
												? undefined
												: Redacted.value(config.clientSecret),
										discoveryUrl:
											config.issuer + "/.well-known/openid-configuration",
										redirectURI: config.redirectUri,
										scopes: ["openid", "profile", "email"],
										pkce: true,
										requireIdTokenVerification: true,
										accountSubject: ({ tokens, profile }) => {
											if (tokens.idToken === undefined) return ""
											// Generic OAuth checks the ID token before it finds the account subject.
											const claims = decodeJwt(tokens.idToken)
											return claims.sub === profile.sub
												? (claims.sub ?? "")
												: ""
										},
										tokenEndpointAuth: {
											method:
												config.clientSecret === undefined
													? "none"
													: "client_secret_basic",
										},
										disableProviderLogout: true,
									},
								],
							}),
						],
						development: () => [developmentLogin()],
					}),
				),
			]
			const sdk = betterAuth({
				baseURL: config.publicOrigin,
				basePath: "/auth",
				secret: Redacted.value(config.secret),
				database: drizzleAdapter(drizzle({ client: pool }), {
					provider: "pg",
					schema: tables,
					transaction: true,
				}),
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
				plugins,
			})
			yield* attempt(
				() => sdk.$context,
				() => AuthUnavailable.make({ dependency: "provider" }),
			)
			const headers = (credential: Redacted.Redacted<string>) =>
				new Headers({
					cookie:
						config.sessionCookie +
						"=" +
						encodeURIComponent(Redacted.value(credential)),
					origin: config.publicOrigin,
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
									context: await sdk.$context,
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
								const adapter = (await sdk.$context).internalAdapter
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
									context: await sdk.$context,
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
						handler: sdk.handler,
						signIn: async (target, headers) => {
							try {
								if (config.mode === "oidc")
									return await sdk.api.signInSocial({
										body: {
											provider: config.providerId,
											callbackURL: config.publicOrigin + target,
										},
										headers,
										request: new Request(config.publicOrigin + "/auth/login"),
										asResponse: true,
									})
								const response = await sdk.api.signInDevelopment({
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
							sdk.api.signOut({ headers, asResponse: true }),
					},
				),
				resolveSession: (credential, options) =>
					attempt(
						() =>
							sdk.api.getSession({
								headers: headers(credential),
								query: { disableRefresh: options?.refresh === false },
								returnHeaders: true,
							}),
						() => AuthUnavailable.make({ dependency: "storage" }),
					).pipe(
						Effect.flatMap(({ response: result, headers }) =>
							result === null
								? Effect.fail(CredentialRejected.make({ kind: "session" }))
								: organization
										.admit({
											id: result.user.id,
											email: result.user.email,
											name: result.user.name,
											emailVerified: result.user.emailVerified,
										})
										.pipe(
											Effect.mapError((error) =>
												error._tag === "MembershipRejected"
													? CredentialRejected.make({ kind: "membership" })
													: AuthUnavailable.make({ dependency: "storage" }),
											),
											Effect.map(({ organizationId }) => ({
												identity: {
													userId: result.user.id,
													organizationId: organizationId,
												},
												profile: {
													name: result.user.name,
													email: result.user.email,
													emailVerified: result.user.emailVerified,
												},
												expiresAt: result.session.expiresAt.toISOString(),
												setCookies: headers.getSetCookie(),
											})),
										),
						),
					),
			})
			if (Option.isNone(barrier)) return service
			const fence = barrier.value
			const runWeb = Effect.runPromiseWith(yield* Effect.context<never>())
			return Auth.of({
				...service,
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
