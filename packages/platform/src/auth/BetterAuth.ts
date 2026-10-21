import { AuthApi } from "@openbot-build/platform-api"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { betterAuth } from "better-auth/minimal"
import { APIError } from "better-auth/api"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { DrizzleQueryError } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { decodeJwt } from "jose"
import { Effect, Exit, Layer, Match, Redacted, Predicate } from "effect"
import * as tables from "../database/AuthSchema.ts"
import { Auth } from "./Auth.ts"
import { developmentLogin } from "./DevelopmentLogin.ts"
import { type ResolvedConfiguration } from "./Configuration.ts"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"

/** The Better Auth provider ID. The provider callback is `/auth/callback/oidc`. */
const providerId = "oidc"

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
): Layer.Layer<Auth, AuthUnavailable> =>
	Layer.effect(
		Auth,
		Effect.gen(function* () {
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
										providerId,
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
						session_token: { name: AuthApi.SessionCookie },
						state: { name: AuthApi.LoginCookie },
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
						AuthApi.SessionCookie +
						"=" +
						encodeURIComponent(Redacted.value(credential)),
					origin: config.publicOrigin,
				})
			return Auth.of({
				handler: sdk.handler,
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
								: Effect.succeed({
										identity: {
											userId: result.user.id,
											tenantId: result.user.id,
										},
										profile: {
											name: result.user.name,
											email: result.user.email,
											emailVerified: result.user.emailVerified,
										},
										expiresAt: result.session.expiresAt.toISOString(),
										setCookies: headers.getSetCookie(),
									}),
						),
					),
			})
		}),
	)
