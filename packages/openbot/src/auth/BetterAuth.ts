import { AuthApi } from "@openbot-build/api"

import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { betterAuth } from "better-auth/minimal"
import { APIError } from "better-auth/api"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { DrizzleQueryError } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { decodeJwt } from "jose"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Equal,
	FiberSet,
	Layer,
	Option,
	Predicate,
	RcMap,
	Redacted,
	Ref,
	Schema,
	Schedule,
	Stream,
} from "effect"
import { HttpServerResponse } from "effect/http"
import * as tables from "../database/AuthSchema.ts"
import { Auth } from "./Auth.ts"
import { Organization } from "../organization/Organization.ts"
import { PlatformAdmins } from "../platform/PlatformAdmins.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import {
	type Connection as SsoConnection,
	connectionFor,
	Sso,
} from "../sso/Sso.ts"
import { developmentLogin } from "./DevelopmentLogin.ts"
import { ResolvedConfiguration } from "./Configuration.ts"
import { AuthUnavailable, CredentialRejected } from "./Model.ts"
import * as Background from "../execution/Background.ts"
import * as Failures from "../errors/Failures.ts"
import * as Report from "../errors/Report.ts"
import type { Records } from "../errors/Records.ts"

/**
 * The Better Auth provider ID of the platform provider. Its callback is
 * `/auth/callback/oidc`. An SSO connection uses its own ID, such as
 * `/auth/callback/sso_...`.
 */
const providerId = "oidc"

/**
 * SDK rejections and database errors go to the typed error channel. Other
 * errors are programming errors, so they are defects. The mapped error keeps
 * each rejection private until the outside boundary saves it. `tryPromise`
 * keeps the rejection as the `cause` of its `UnknownError`.
 */
const attempt = <A, E>(
	run: (signal: AbortSignal) => Promise<A>,
	onApiError: (error: APIError) => E,
): Effect.Effect<A, E | AuthUnavailable> =>
	Effect.tryPromise((signal) => run(signal)).pipe(
		Effect.catch(({ cause }): Effect.Effect<never, E | AuthUnavailable> =>
			cause instanceof APIError
				? Effect.fail(cause).pipe(
						Failures.replace("Better Auth refused a call.", () =>
							onApiError(cause),
						),
					)
				: cause instanceof DrizzleQueryError ||
					  (Predicate.isError(cause) && Predicate.hasProperty(cause, "code"))
					? Effect.fail(cause).pipe(
							Failures.replace("Better Auth could not use its database.", () =>
								AuthUnavailable.make({ dependency: "storage" }),
							),
						)
					: Effect.die(cause),
		),
	)

/** Keep a service failure private until the outside boundary saves it. */
const unavailable =
	(dependency: AuthUnavailable["dependency"]) =>
	<E>(error: E) =>
		Effect.fail(error).pipe(
			Failures.replace("Sign-in could not use a service that it needs.", () =>
				AuthUnavailable.make({ dependency }),
			),
		)

/** One OpenID Connect provider for Better Auth: the platform provider, or the SSO connection of an organization. */
interface OidcProvider {
	readonly providerId: string
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
	redirectURI: publicOrigin + "/auth/callback/" + provider.providerId,
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

export interface Options {
	readonly databaseUrl: Redacted.Redacted<string>
	/** Use the local test account instead of a sign-in provider. */
	readonly development: boolean
}

/**
 * How long a Better Auth instance stays open after its last call. A change of
 * the sign-in settings makes a new instance, and the old one closes this long
 * after the calls that still use it end.
 */
const idleTimeToLive = Duration.minutes(5)

/**
 * Sign-in with Better Auth, for the sign-in settings of the platform: the
 * public origin, the sign-in secret and the platform provider. Each call reads
 * the current platform settings and borrows the Better Auth instance of these
 * settings for the time of the call. Equal settings share one instance.
 */
export const layer = (
	options: Options,
): Layer.Layer<
	Auth,
	never,
	Organization | PlatformAdmins | Sso | Settings | Secrets | Records
> =>
	Layer.effect(
		Auth,
		Effect.gen(function* () {
			/** A signed-in account joins organizations by the rules of each one. */
			const organization = yield* Organization
			const admins = yield* PlatformAdmins
			const sso = yield* Sso
			const settings = yield* Settings
			const secrets = yield* Secrets
			const report = yield* Report.make
			const background = yield* Background.make
			const context = yield* Effect.context<never>()
			const callbacks = yield* FiberSet.make()
			const run = yield* FiberSet.runtime(callbacks)<never>()
			// Every instance uses this pool, so a new instance opens no new connections.
			const pool = yield* Effect.acquireRelease(
				Effect.sync(() => {
					const pool = new Pool({
						connectionString: Redacted.value(options.databaseUrl),
					})
					// pg emits "error" on the pool when an idle connection fails. With no
					// listener, Node throws it and the process stops. pg has already
					// removed the broken connection, so a log is enough.
					pool.on("error", (error) => {
						run(
							// Effect 4.0.6 registers runtime fibers after they start. Yield before logging.
							Effect.andThen(
								Effect.yieldNow,
								report(
									"An idle connection of the auth database pool failed",
									error,
								),
							),
						)
					})
					return pool
				}),
				// Closing the pool is best-effort cleanup. Log a failure, but do not fail shutdown.
				(pool) =>
					Effect.tryPromise(() => pool.end()).pipe(
						Effect.catch((error) =>
							report("The auth database pool did not close", error).pipe(
								Effect.asVoid,
							),
						),
					),
			)
			const database = drizzleAdapter(drizzle({ client: pool }), {
				provider: "pg",
				schema: tables,
				transaction: true,
			})

			/** The platform provider and every SSO connection, with open secrets. */
			const loadProviders = (config: ResolvedConfiguration) =>
				Effect.gen(function* () {
					const connections = yield* sso.all
					const connectionProviders = yield* Effect.forEach(
						connections,
						(connection) =>
							Effect.map(
								sso.openSecret(connection),
								(secret): OidcProvider => ({
									providerId: connection.id,
									issuer: connection.issuer,
									clientId: connection.clientId,
									clientSecret: Option.getOrUndefined(secret),
								}),
							),
					)
					const providers: ReadonlyArray<OidcProvider> =
						config.mode === "oidc"
							? [
									{
										providerId,
										issuer: config.issuer,
										clientId: config.clientId,
										clientSecret: config.clientSecret,
									},
									...connectionProviders,
								]
							: connectionProviders
					return { connections, providers }
				}).pipe(Effect.catch(unavailable("storage")))

			const make = (
				config: ResolvedConfiguration,
				providers: ReadonlyArray<OidcProvider>,
			) =>
				betterAuth({
					baseURL: config.publicOrigin,
					basePath: "/auth",
					secret: Redacted.value(config.secret),
					database,
					trustedOrigins: [config.publicOrigin],
					// SDK messages can hold tokens or SQL values. Seal them before logging.
					logger: {
						log: (level, message, ...args) =>
							run(
								// Effect 4.0.6 registers runtime fibers after they start. Yield before reporting.
								Effect.yieldNow.pipe(
									Effect.andThen(
										report("Better Auth wrote a diagnostic record", {
											level,
											message,
											args,
										}),
									),
								),
							),
					},
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
						// better-auth turns its Origin check off when NODE_ENV is "test" or
						// TEST is set. Keep the check on, whatever the environment says.
						disableOriginCheck: false,
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
					plugins: [
						...(config.mode === "development" ? [developmentLogin()] : []),
						...(providers.length === 0
							? []
							: [
									genericOAuth({
										config: Arr.map(providers, (provider) =>
											oidcConfig(provider, config.publicOrigin),
										),
									}),
								]),
					],
				})
			type Sdk = ReturnType<typeof make>
			/** The SDK of one instance, for the SSO connections that it knows. */
			interface Current {
				/** The ID and version of each SSO connection. A change means that the SDK must change. */
				readonly versions: ReadonlyArray<readonly [string, number]>
				readonly sdk: Sdk
				readonly connections: ReadonlyArray<SsoConnection>
			}
			const build = (config: ResolvedConfiguration) =>
				Effect.gen(function* () {
					const loaded = yield* loadProviders(config)
					const sdk = make(config, loaded.providers)
					yield* attempt(
						() => sdk.$context,
						() => AuthUnavailable.make({ dependency: "provider" }),
					)
					return {
						versions: Arr.map(
							loaded.connections,
							(connection) => [connection.id, connection.version] as const,
						),
						sdk,
						connections: loaded.connections,
					} satisfies Current
				})

			/**
			 * Makes the Better Auth instance of one set of sign-in settings. It lives
			 * in its own scope, which the map closes when nobody used it for a while.
			 */
			const instance = Effect.fn("BetterAuth.instance")(function* (
				key: Platform.SignInSettings,
			) {
				const config = yield* Platform.authConfiguration(secrets, {
					settings: key,
					development: options.development,
				}).pipe(
					Effect.catch(unavailable("settings")),
					Effect.flatMap((configuration) =>
						Schema.decodeEffect(ResolvedConfiguration)(configuration).pipe(
							Effect.catch(unavailable("settings")),
						),
					),
				)
				/** A new SSO connection replaces the SDK of this instance. */
				const current = yield* Ref.make(yield* build(config))
				const reload = build(config).pipe(
					Effect.flatMap((next) =>
						Ref.update(current, (previous) =>
							Equal.equals(next.versions, previous.versions) ? previous : next,
						),
					),
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: report(
									"OpenBot could not load the SSO connections. It keeps the current ones.",
									cause,
								).pipe(Effect.asVoid),
					),
				)
				// A missed notice must not keep old connections for ever, so also check from time to time.
				yield* background.repeat(
					reload.pipe(Effect.delay("30 seconds"), Effect.setContext(context)),
					{
						schedule: Schedule.forever,
						message: "OpenBot could not load the SSO connections.",
					},
				)
				yield* Stream.filter(
					settings.changes,
					(scope) => scope.kind === "signIn",
				).pipe(
					Stream.runForEach(() => reload),
					// The loop lives as long as the instance, so it must not keep the
					// context of the call that made the instance, such as its request
					// id. `setContext` takes the place of that context, and
					// `provideContext` would only add to it.
					Effect.setContext(context),
					Effect.forkScoped,
				)
				return { config, current }
			})
			type Instance = Effect.Success<ReturnType<typeof instance>>
			const instances: RcMap.RcMap<
				Platform.SignInSettings,
				Instance,
				AuthUnavailable
			> = yield* RcMap.make({
				lookup: (key: Platform.SignInSettings) =>
					instance(key).pipe(
						// A failed build must not stay in the map, so the next call builds again.
						Effect.onError((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.void
								: RcMap.invalidate(instances, key),
						),
					),
				idleTimeToLive,
			})

			/** Borrows the instance of the current platform settings until the scope closes. */
			const borrow = Effect.gen(function* () {
				const platform = yield* settings.platform.pipe(
					Effect.catch(unavailable("settings")),
				)
				if (Option.isNone(platform))
					return yield* AuthUnavailable.make({ dependency: "settings" })
				return yield* RcMap.get(
					instances,
					Platform.signInKey(platform.value.document),
				)
			})
			/** Runs `use` with the current instance and the SDK that it has now. */
			const withCurrent = <A, E>(
				use: (instance: Instance, current: Current) => Effect.Effect<A, E>,
			) =>
				Effect.scoped(
					Effect.flatMap(borrow, (instance) =>
						Effect.flatMap(Ref.get(instance.current), (current) =>
							use(instance, current),
						),
					),
				)

			// The `/auth/*` routes answer like the API when sign-in cannot work now.
			const unavailableResponse = yield* HttpServerResponse.schemaJson(
				AuthApi.AuthenticationUnavailable,
			)(AuthApi.AuthenticationUnavailable.make({}), { status: 503 }).pipe(
				// The schema encodes a constant value, so a failure here is a defect.
				Effect.orDie,
			)

			const headers = (
				config: ResolvedConfiguration,
				credential: Redacted.Redacted<string>,
			) =>
				new Headers({
					cookie:
						AuthApi.SessionCookie +
						"=" +
						encodeURIComponent(Redacted.value(credential)),
					origin: config.publicOrigin,
				})
			/**
			 * An SSO connection may only sign in people with an email in its own domains.
			 * When a connection enforces SSO, people with an email in its domains may not
			 * use another provider. Accounts are never linked, so each user has one provider.
			 */
			const checkProvider = (
				connections: ReadonlyArray<SsoConnection>,
				user: {
					readonly id: string
					readonly email: string
				},
			) =>
				Effect.gen(function* () {
					const provider = yield* sso
						.providerOf(user.id)
						.pipe(Effect.catch(unavailable("storage")))
					const byEmail = connectionFor({ connections, email: user.email })
					const used = Option.flatMap(provider, (id) =>
						Arr.findFirst(connections, (connection) => connection.id === id),
					)
					if (Option.isSome(used)) {
						if (
							!Option.exists(
								byEmail,
								(connection) => connection.id === used.value.id,
							)
						)
							return yield* CredentialRejected.make({ kind: "session" })
						return Option.some(used.value.organizationId)
					}
					if (Option.exists(byEmail, (connection) => connection.enforce))
						return yield* CredentialRejected.make({ kind: "session" })
					return Option.none<string>()
				})

			return Auth.of({
				handle: (request) =>
					withCurrent((_, current) =>
						Effect.promise(() => current.sdk.handler(request)),
					).pipe(
						Effect.catchTag("AuthUnavailable", () =>
							Effect.sync(() => HttpServerResponse.toWeb(unavailableResponse)),
						),
					),
				startSignIn: (input) =>
					withCurrent((instance, current) =>
						attempt(
							() =>
								current.sdk.api.signInSocial({
									body: {
										provider: input.providerId,
										callbackURL: input.returnTo ?? "/",
										disableRedirect: true,
									},
									headers: new Headers({
										origin: instance.config.publicOrigin,
									}),
									returnHeaders: true,
								}),
							() => AuthUnavailable.make({ dependency: "provider" }),
						),
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
					withCurrent((instance, current) =>
						Effect.succeed(
							Option.match(
								Option.flatMap(Option.fromNullishOr(email), (email) =>
									connectionFor({ connections: current.connections, email }),
								),
								{
									onSome: (connection) => Option.some(connection.id),
									onNone: () =>
										instance.config.mode === "oidc"
											? Option.some(providerId)
											: Option.none(),
								},
							),
						),
					),
				resolveSession: (credential, options) =>
					withCurrent((instance, current) =>
						attempt(
							() =>
								current.sdk.api.getSession({
									headers: headers(instance.config, credential),
									query: { disableRefresh: options?.refresh === false },
									returnHeaders: true,
								}),
							() => AuthUnavailable.make({ dependency: "storage" }),
						).pipe(
							Effect.flatMap(({ response: result, headers }) =>
								Effect.gen(function* () {
									if (result === null)
										return yield* CredentialRejected.make({ kind: "session" })
									const ssoOrganization = yield* checkProvider(
										current.connections,
										result.user,
									)
									const account = {
										id: result.user.id,
										email: result.user.email,
										name: result.user.name,
										emailVerified: result.user.emailVerified,
									}
									const memberships = yield* organization.admit(
										account,
										ssoOrganization,
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
										OrganizationUnavailable: unavailable("storage"),
										PlatformAdminsUnavailable: unavailable("storage"),
									}),
								),
							),
						),
					),
			})
		}),
	)
