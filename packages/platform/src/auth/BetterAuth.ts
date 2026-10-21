import { AuthApi } from "@openbot-build/platform-api"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { betterAuth } from "better-auth/minimal"
import { APIError } from "better-auth/api"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { DrizzleQueryError } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { decodeJwt } from "jose"
import { Effect, Exit, Layer, Match, Redacted, Predicate, Schema } from "effect"
import * as tables from "../database/AuthSchema.ts"
import { Auth } from "./Auth.ts"
import { Organization } from "../organization/Organization.ts"
import { developmentLogin } from "./DevelopmentLogin.ts"
import { type ResolvedConfiguration } from "./Configuration.ts"
import {
	AuthUnavailable,
	CredentialRejected,
	AuthRequestInvalid,
} from "./Model.ts"

/** The Better Auth provider ID. The public callback stays at `/auth/callback`. */
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
				startLogin: (requestHeaders, returnTo = "/") =>
					Effect.gen(function* () {
						const target = yield* Schema.decodeEffect(AuthApi.ReturnTo)(
							returnTo,
						).pipe(Effect.mapError(() => AuthRequestInvalid.make({})))
						return yield* Match.value(config).pipe(
							Match.discriminatorsExhaustive("mode")({
								oidc: () =>
									attempt(
										(signal) =>
											sdk.api.signInSocial({
												body: {
													provider: providerId,
													callbackURL: config.publicOrigin + target,
												},
												headers: requestHeaders,
												request: new Request(
													config.publicOrigin + "/auth/login",
													{
														signal,
													},
												),
												asResponse: true,
											}),
										() => AuthUnavailable.make({ dependency: "provider" }),
									).pipe(
										Effect.flatMap((response) =>
											response.ok && response.headers.has("location")
												? Effect.succeed(
														new Response(null, {
															status: 303,
															headers: response.headers,
														}),
													)
												: Effect.fail(
														AuthUnavailable.make({ dependency: "provider" }),
													),
										),
									),
								development: () =>
									attempt(
										() =>
											sdk.api.signInDevelopment({
												headers: requestHeaders,
												asResponse: true,
											}),
										() => AuthUnavailable.make({ dependency: "storage" }),
									).pipe(
										Effect.flatMap((response) => {
											if (!response.ok)
												return Effect.fail(
													AuthUnavailable.make({ dependency: "storage" }),
												)
											const headers = new Headers(response.headers)
											headers.set("location", config.publicOrigin + target)
											return Effect.succeed(
												new Response(null, { status: 303, headers }),
											)
										}),
									),
							}),
						)
					}),
				completeLogin: (url, requestHeaders) =>
					Match.value(config).pipe(
						Match.discriminatorsExhaustive("mode")({
							development: () =>
								Effect.succeed(new Response(null, { status: 400 })),
							oidc: () =>
								attempt(
									(signal) => {
										const callback = new URL(url, config.publicOrigin)
										if (
											[...callback.searchParams.keys()].some(
												(key) => callback.searchParams.getAll(key).length !== 1,
											)
										)
											return Promise.resolve(
												new Response(null, { status: 400 }),
											)
										callback.pathname = "/auth/callback/" + providerId
										return sdk.handler(
											new Request(callback, {
												headers: requestHeaders,
												signal,
											}),
										)
									},
									() => AuthUnavailable.make({ dependency: "provider" }),
								).pipe(
									Effect.map((response) => {
										if (response.status >= 400)
											return new Response(null, {
												status: response.status >= 500 ? 503 : 400,
												headers: response.headers,
											})
										const location = response.headers.get("location")
										const error =
											location === null
												? null
												: new URL(
														location,
														config.publicOrigin,
													).searchParams.get("error")
										return new Response(null, {
											status:
												error === null
													? 303
													: error === "oauth_provider_not_found"
														? 503
														: 401,
											headers: response.headers,
										})
									}),
								),
						}),
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
				logout: (credential) =>
					attempt(
						() =>
							sdk.api.signOut({
								headers: headers(credential),
								asResponse: true,
							}),
						() => AuthUnavailable.make({ dependency: "storage" }),
					).pipe(
						Effect.map(
							(response) =>
								new Response(null, { status: 204, headers: response.headers }),
						),
					),
			})
		}),
	)
