import { AsyncLocalStorage } from "node:async_hooks"
import * as AccessModel from "@openbot-build/domain/Access"
import { Access, type Identity as AccessIdentity } from "../access/Access.ts"
import { AuthApi } from "@openbot-build/api"

import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { betterAuth } from "better-auth/minimal"
import {
	APIError,
	createAuthMiddleware,
	addOAuthServerContext,
	getOAuthState,
} from "better-auth/api"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { DrizzleQueryError } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { decodeJwt, SignJWT, jwtVerify } from "jose"
import { emailOTP } from "better-auth/plugins/email-otp"
import { Hex } from "effect/encoding"
import { Mail } from "../mail/Mail.ts"
import {
	Array as Arr,
	Cause,
	Crypto,
	String as Str,
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
import {
	AuthUnavailable,
	CredentialRejected,
	AuthConfigurationError,
} from "./Model.ts"
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
	readonly access: AccessModel.ProviderAccess
}

const oidcConfig = (
	provider: OidcProvider,
	publicOrigin: string,
	authorize: (
		provider: OidcProvider,
		tokens: { readonly idToken?: string | undefined },
		profile: {
			readonly sub?: unknown
			readonly email?: unknown
			readonly emailVerified?: unknown
		},
	) => Promise<string>,
) => ({
	providerId: provider.providerId,
	clientId: provider.clientId,
	clientSecret:
		provider.clientSecret === undefined
			? undefined
			: Redacted.value(provider.clientSecret),
	discoveryUrl: provider.issuer + "/.well-known/openid-configuration",
	redirectURI: publicOrigin + "/auth/callback/" + provider.providerId,
	scopes: ["openid", "profile", "email", ...provider.access.scopes],
	pkce: true,
	requireIdTokenVerification: true,
	accountSubject: ({
		tokens,
		profile,
	}: {
		readonly tokens: { readonly idToken?: string | undefined }
		readonly profile: {
			readonly sub?: unknown
			readonly email?: unknown
			readonly emailVerified?: unknown
		}
	}) => authorize(provider, tokens, profile),
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
	| Organization
	| PlatformAdmins
	| Sso
	| Settings
	| Secrets
	| Records
	| Access
	| Mail
	| Crypto.Crypto
> =>
	Layer.effect(
		Auth,
		Effect.gen(function* () {
			/** A signed-in account joins organizations by the rules of each one. */
			const organization = yield* Organization
			const access = yield* Access
			const mail = yield* Mail
			const crypto = yield* Crypto.Crypto
			// The SDK callbacks share only their own HTTP request state.
			const requestState = new AsyncLocalStorage<{
				identity?: AccessIdentity
				deliveryFailed?: boolean
				challenge?: string
				email?: string
				invitation?: string
				reason?: AccessModel.AccessDenied["reason"]
			}>()
			const admins = yield* PlatformAdmins
			const sso = yield* Sso
			const settings = yield* Settings
			const secrets = yield* Secrets
			const report = yield* Report.make
			const background = yield* Background.make
			const context = yield* Effect.context<never>()
			const callbacks = yield* FiberSet.make()
			const run = yield* FiberSet.runtime(callbacks)<never>()
			const runPromise = yield* FiberSet.runtimePromise(callbacks)<never>()
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
									access: connection.access ?? AccessModel.providerDefaults,
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
										access: (yield* access.registration).provider,
									},
									...connectionProviders,
								]
							: connectionProviders
					return { connections, providers }
				}).pipe(Effect.catch(unavailable("storage")))

			// @effect-diagnostics-next-line asyncFunction:off -- Better Auth calls these Promise callbacks inside its native request context.
			const checked = async <A>(
				effect: Effect.Effect<
					A,
					| AccessModel.AccessDenied
					| AccessModel.AccessConflict
					| AccessModel.AccessUnavailable
				>,
			) => {
				const result = await runPromise(effect.pipe(Effect.result))
				if (result._tag === "Failure") {
					const error = result.failure
					const state = requestState.getStore()
					if (error._tag === "AccessDenied" && state !== undefined)
						state.reason = error.reason
					rejectNative(
						error._tag === "AccessUnavailable"
							? "SERVICE_UNAVAILABLE"
							: "FORBIDDEN",
						{ message: "Sign-in is not allowed.", code: error._tag },
					)
				}
				return result.success
			}
			// @effect-diagnostics-next-line asyncFunction:off -- Better Auth calls these Promise callbacks inside its native request context.
			const authorize = async (
				provider: OidcProvider,
				tokens: { readonly idToken?: string | undefined },
				profile: {
					readonly sub?: unknown
					readonly email?: unknown
					readonly emailVerified?: unknown
				},
			) => {
				const state = requestState.getStore()
				if (
					state === undefined ||
					tokens.idToken === undefined ||
					tokens.idToken === ""
				)
					rejectNative("FORBIDDEN", {
						message: "A checked identity is required.",
					})
				// The SDK checks the signature, issuer, audience and nonce before this callback.
				const claims = decodeJwt(tokens.idToken)
				if (
					claims.sub !== profile.sub ||
					claims.sub === undefined ||
					claims.sub === "" ||
					claims.iss !== provider.issuer ||
					typeof profile.email !== "string"
				)
					rejectNative("FORBIDDEN", {
						message: "The identity does not match.",
					})
				const flow = await getOAuthState()
				const invitation = flow?.serverContext?.["openbotInvitation"]
				const identity: AccessIdentity = {
					providerId: provider.providerId,
					issuer: provider.issuer,
					subject: claims.sub,
					claims,
					email: profile.email,
					emailVerified: profile.emailVerified === true,
					groups:
						provider.access.groupsClaim === null
							? undefined
							: claims[provider.access.groupsClaim],
					...(typeof invitation === "string" ? { invitation } : {}),
				}
				state.identity = identity
				await checked(access.check(identity))
				return claims.sub
			}

			// Called only by hooks that run after the SDK has consumed a valid email code.
			// @effect-diagnostics-next-line asyncFunction:off -- The SDK owns this callback and requires a Promise.
			const emailIdentity = async (origin: string) => {
				const state = requestState.getStore()
				if (state?.email === undefined || state.challenge === undefined)
					rejectNative("FORBIDDEN", {
						message: "A checked email code is required.",
					})
				state.identity = {
					providerId: "email",
					issuer: origin,
					subject: state.email,
					email: state.email,
					emailVerified: true,
					groups: undefined,
					...(state.invitation === undefined
						? {}
						: { invitation: state.invitation }),
				}
				await checked(access.check(state.identity))
			}
			const make = (
				config: ResolvedConfiguration,
				providers: ReadonlyArray<OidcProvider>,
			) =>
				betterAuth({
					baseURL: config.publicOrigin,
					basePath: "/auth",
					secret: Redacted.value(config.secret),
					database,
					hooks: {
						// @effect-diagnostics-next-line asyncFunction:off -- Better Auth calls these Promise callbacks inside its native request context.
						before: createAuthMiddleware(async (ctx) => {
							if (
								ctx.path === "/sign-in/email-otp" ||
								Str.startsWith("/email-otp/")(ctx.path ?? "")
							) {
								const state = requestState.getStore()
								if (
									state?.challenge === undefined ||
									(ctx.path !== "/sign-in/email-otp" &&
										ctx.path !== "/email-otp/send-verification-otp") ||
									(ctx.path === "/email-otp/send-verification-otp" &&
										ctx.body?.type !== "sign-in")
								)
									rejectNative("FORBIDDEN", {
										message: "Use the email sign-in API.",
									})
								await checked(access.provider("email"))
								if (ctx.path === "/sign-in/email-otp")
									await checked(access.emailAccount(state.email ?? ""))
							}
							if (ctx.path === "/sign-in/social") {
								const invitation: unknown =
									ctx.body?.additionalData?.openbotInvitation
								if (typeof invitation === "string")
									await addOAuthServerContext({ openbotInvitation: invitation })
							}
						}),
					},
					databaseHooks: {
						user: {
							create: {
								// @effect-diagnostics-next-line asyncFunction:off -- Better Auth calls these Promise callbacks inside its native request context.
								before: async (_user, ctx) => {
									if (ctx?.path === "/sign-in/email-otp")
										await emailIdentity(config.publicOrigin)
									if (options.development) return
									const identity = requestState.getStore()?.identity
									if (identity === undefined)
										rejectNative("FORBIDDEN", {
											message: "A checked identity is required.",
										})
									await checked(access.check(identity))
								},
								// @effect-diagnostics-next-line asyncFunction:off -- The SDK calls this hook after a checked email code creates an account.
								after: async (user, ctx) => {
									if (ctx?.path === "/sign-in/email-otp")
										await checked(access.bindEmail(user.id, user.email))
								},
							},
						},
						session: {
							create: {
								// @effect-diagnostics-next-line asyncFunction:off -- Better Auth calls these Promise callbacks inside its native request context.
								before: async (session, ctx) => {
									if (ctx?.path === "/sign-in/email-otp")
										await emailIdentity(config.publicOrigin)
									if (
										!(await checked(
											access.active(
												session.userId,
												session.createdAt.getTime(),
											),
										))
									)
										rejectNative("FORBIDDEN", {
											message: "This account is suspended.",
										})
									const identity = requestState.getStore()?.identity
									if (identity !== undefined)
										await checked(access.sync(session.userId, identity))
								},
							},
						},
					},
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
						emailOTP({
							otpLength: 8,
							expiresIn: 300,
							allowedAttempts: 3,
							storeOTP: {
								// @effect-diagnostics-next-line asyncFunction:off -- The SDK requires a Promise for its OTP hash callback.
								hash: async (code) => {
									const challenge = requestState.getStore()?.challenge
									if (challenge === undefined)
										rejectNative("FORBIDDEN", {
											message: "A sign-in challenge is required.",
										})
									return Hex.encode(
										await runPromise(
											crypto
												.digest(
													"SHA-256",
													new TextEncoder().encode(challenge + "." + code),
												)
												.pipe(Effect.orDie),
										),
									)
								},
							},
							// @effect-diagnostics-next-line asyncFunction:off -- The SDK awaits this mail callback in its request scope.
							sendVerificationOTP: async ({ email, otp, type }) => {
								if (type !== "sign-in")
									rejectNative("FORBIDDEN", { message: "Use a sign-in code." })
								const result = await runPromise(mail.signInCode(email, otp))
								if (result.status !== "sent") {
									const state = requestState.getStore()
									if (state !== undefined) state.deliveryFailed = true
									rejectNative("SERVICE_UNAVAILABLE", {
										message: "Email could not be sent.",
									})
								}
							},
						}),
						...(config.mode === "development" ? [developmentLogin()] : []),
						...(providers.length === 0
							? []
							: [
									genericOAuth({
										config: Arr.map(providers, (provider) =>
											oidcConfig(provider, config.publicOrigin, authorize),
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

			const emailAttempt = <A>(
				state: {
					challenge: string
					email: string
					invitation?: string
					reason?: AccessModel.AccessDenied["reason"]
				},
				work: () => Promise<A>,
			) =>
				Effect.tryPromise(() => requestState.run(state, work)).pipe(
					Effect.catch(
						({
							cause,
						}): Effect.Effect<
							never,
							AccessModel.AccessDenied | AuthUnavailable | CredentialRejected
						> =>
							state.reason !== undefined
								? Effect.fail(
										AccessModel.AccessDenied.make({ reason: state.reason }),
									)
								: cause instanceof APIError &&
									  cause.status !== "SERVICE_UNAVAILABLE"
									? Effect.fail(CredentialRejected.make({ kind: "session" }))
									: Effect.fail(
											AuthConfigurationError.make({
												field: "configuration",
												cause,
											}),
										).pipe(
											Failures.replace("Email sign-in failed.", () =>
												AuthUnavailable.make({ dependency: "provider" }),
											),
										),
					),
				)

			return Auth.of({
				emailSend: (input) =>
					withCurrent((instance, current) =>
						Effect.gen(function* () {
							yield* access.provider("email")
							yield* access.emailRate("send-ip:" + input.address, 10)
							const email = Str.toLowerCase(Str.trim(input.email))
							yield* access.emailRate("send-email:" + email, 1)
							const id = yield* crypto.randomUUIDv7().pipe(Effect.orDie)
							const challenge = yield* Effect.promise(() =>
								new SignJWT({
									email,
									...(input.invitation === undefined
										? {}
										: { invitation: input.invitation }),
								})
									.setProtectedHeader({ alg: "HS256" })
									.setIssuer(instance.config.publicOrigin)
									.setAudience("openbot-email-sign-in")
									.setJti(id)
									.setIssuedAt()
									.setExpirationTime("5 minutes")
									.sign(
										new TextEncoder().encode(
											Redacted.value(instance.config.secret),
										),
									),
							)
							const state = {
								challenge,
								email,
								deliveryFailed: false,
								...(input.invitation === undefined
									? {}
									: { invitation: input.invitation }),
							}
							yield* emailAttempt(state, () =>
								current.sdk.api.sendVerificationOTP({
									body: { email, type: "sign-in" },
									headers: new Headers({
										origin: instance.config.publicOrigin,
									}),
								}),
							)
							if (state.deliveryFailed)
								return yield* AuthUnavailable.make({ dependency: "provider" })
							return { challenge }
						}),
					),
				emailVerify: (input) =>
					withCurrent((instance, current) =>
						Effect.gen(function* () {
							yield* access.provider("email")
							yield* access.emailRate("verify-ip:" + input.address, 30)
							const claims = yield* Effect.tryPromise(() =>
								jwtVerify(
									input.challenge,
									new TextEncoder().encode(
										Redacted.value(instance.config.secret),
									),
									{
										issuer: instance.config.publicOrigin,
										audience: "openbot-email-sign-in",
										algorithms: ["HS256"],
									},
								),
							).pipe(
								Failures.replace(
									"The email sign-in challenge is invalid.",
									() => CredentialRejected.make({ kind: "session" }),
								),
							)
							const payload = yield* Schema.decodeUnknownEffect(
								Schema.Struct({
									email: Schema.NonEmptyString,
									invitation: Schema.optionalKey(Schema.String),
								}),
							)(claims.payload).pipe(
								Failures.replace(
									"The email sign-in challenge is invalid.",
									() => CredentialRejected.make({ kind: "session" }),
								),
							)
							const result = yield* emailAttempt(
								{ challenge: input.challenge, ...payload },
								() =>
									current.sdk.api.signInEmailOTP({
										body: { email: payload.email, otp: input.code },
										headers: new Headers({
											origin: instance.config.publicOrigin,
										}),
										returnHeaders: true,
									}),
							)
							return { setCookies: result.headers.getSetCookie() }
						}),
					),
				handle: (request) =>
					withCurrent((instance, current) =>
						Effect.promise(() =>
							// @effect-diagnostics-next-line asyncFunction:off -- Better Auth calls these Promise callbacks inside its native request context.
							requestState.run({}, async () => {
								const response = await current.sdk.handler(request)
								const reason = requestState.getStore()?.reason
								return reason !== undefined
									? Response.redirect(
											new URL(
												"/sign-in?reason=" + reason,
												instance.config.publicOrigin,
											).href,
											302,
										)
									: response
							}),
						),
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
										errorCallbackURL: "/sign-in",
										additionalData:
											input.invitation !== undefined
												? { openbotInvitation: input.invitation }
												: {},
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
				resolveSession: (credential, sessionOptions) =>
					withCurrent((instance, current) =>
						attempt(
							() =>
								current.sdk.api.getSession({
									headers: headers(instance.config, credential),
									query: { disableRefresh: sessionOptions?.refresh === false },
									returnHeaders: true,
								}),
							() => AuthUnavailable.make({ dependency: "storage" }),
						).pipe(
							Effect.flatMap(({ response: result, headers }) =>
								Effect.gen(function* () {
									if (result === null)
										return yield* CredentialRejected.make({ kind: "session" })
									if (
										!(yield* access
											.active(
												result.user.id,
												result.session.createdAt.getTime(),
											)
											.pipe(Effect.catch(unavailable("storage"))))
									)
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
									const authProvider = yield* sso
										.providerOf(account.id)
										.pipe(Effect.catch(unavailable("storage")))
									const providerAccess =
										Option.isSome(authProvider) && !options.development
											? yield* access
													.provider(authProvider.value)
													.pipe(Effect.catch(unavailable("provider")))
											: undefined

									const memberships =
										providerAccess?.access.groupsClaim !== null &&
										providerAccess !== undefined
											? yield* organization.memberships(account.id)
											: yield* organization.admit(account, ssoOrganization)
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
										canCreateOrganization:
											platformAdmin ||
											Option.exists(
												yield* settings.platform.pipe(
													Effect.catch(unavailable("settings")),
												),
												(p) => p.document.organizationCreation === "anyone",
											),
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

/** Better Auth uses thrown APIError values at the boundary of its Promise hooks. */
function rejectNative(...args: ConstructorParameters<typeof APIError>): never {
	// @effect-rules-next-line throw -- The SDK only accepts a thrown APIError from its native hooks.
	throw new APIError(...args)
}
