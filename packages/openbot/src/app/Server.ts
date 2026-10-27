import type { PgClient } from "@effect/sql-pg"
import { Settings as Api } from "@openbot-build/api"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer needs a function that makes a Node HTTP server.
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import * as Http from "./Http.ts"
import { type Crypto, Effect, Layer, Option, Redacted, Result } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as OpenBot from "./OpenBot.ts"
import * as AuthHttpHandlers from "../auth/HttpHandlers.ts"
import * as ErrorReporting from "./ErrorReporting.ts"
import * as PlatformAdminsPostgres from "../platform/PlatformAdminsPostgres.ts"
import * as Setup from "../platform/Setup.ts"
import type { Auth } from "../auth/Auth.ts"
import * as AuthConfiguration from "../auth/Configuration.ts"
import type { Configuration } from "../auth/Model.ts"
import * as HostTools from "../chats/HostTools.ts"
import type { IndexWork } from "../apps/IndexWork.ts"
import { Settings } from "../settings/Settings.ts"

/** The OpenBot routes, with error logs for failed requests. */
export const layerApi = Layer.mergeAll(
	Http.layerPlatform,
	ErrorReporting.layerHttp,
	AuthHttpHandlers.layerBetterAuth,
).pipe(Layer.provide(AuthHttpHandlers.layer))

export interface AppOptions extends OpenBot.Options {
	/** Work that runs when the server starts, such as indexing the development App. */
	readonly startup?: Layer.Layer<
		never,
		never,
		IndexWork | PgClient.PgClient | Crypto.Crypto
	>
	/**
	 * More routes, such as the routes of the development tools. They can use the
	 * `Auth` service to check the sign-in cookie.
	 */
	readonly routes?: Layer.Layer<
		never,
		never,
		HttpRouter.HttpRouter | Auth | Settings
	>
}

/** The routes and services of OpenBot. It needs the same services as `OpenBot.layer`. */
export const layerApp = (options: AppOptions) =>
	Layer.mergeAll(
		layerApi,
		options.routes ?? Layer.empty,
		options.startup ?? Layer.empty,
	).pipe(Layer.provideMerge(OpenBot.layer(options)))

/** The answer of every route except `/health` while the platform has no settings. */
const setupRequired = HttpServerResponse.schemaJson(Api.SetupRequired)(
	Api.SetupRequired.make({}),
	{ status: 503 },
)
const settingsUnavailable = HttpServerResponse.schemaJson(
	Api.SettingsUnavailable,
)(Api.SettingsUnavailable.make({}), { status: 503 })

/**
 * While nobody has run `openbot setup`, every route except `/health` answers
 * with SetupRequired. It wraps the router, so the error logs of failed
 * requests do not count these answers.
 */
const requireSetup = <E, R>(
	app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		// A request target that is not a valid URL is not /health.
		if (
			Option.exists(
				HttpServerRequest.toURL(request),
				(url) => url.pathname === "/health",
			)
		)
			return yield* app
		const settings = yield* Settings
		const platform = yield* Effect.result(settings.platform)
		if (Result.isFailure(platform)) {
			yield* Effect.logError(
				"OpenBot could not read the platform settings.",
				platform.failure,
			)
			// The schema encodes a constant value, so a failure here is a defect.
			return yield* Effect.orDie(settingsUnavailable)
		}
		if (Option.isNone(platform.success))
			return yield* Effect.orDie(setupRequired)
		return yield* app
	})

const warnBeforeSetup = Layer.effectDiscard(
	Effect.gen(function* () {
		const settings = yield* Settings
		const platform = yield* settings.platform
		if (Option.isNone(platform))
			yield* Effect.logWarning(
				"The platform has no settings yet. Run `openbot setup`. Until then, every route except /health answers with SetupRequired.",
			)
	}).pipe(
		Effect.catchTag("SettingsUnavailable", (error) =>
			Effect.logWarning("OpenBot could not read the platform settings.", error),
		),
	),
)

/**
 * Serves the app once, for the life of the process. Values from the platform
 * settings are read when they are used, so a change to them works at once and
 * stops no running request or Turn.
 */
const serve = (options: AppOptions) =>
	HttpRouter.serve(layerApp(options), { middleware: requireSetup })

/** The address that the server listens on. */
export interface Listen {
	readonly host: string
	readonly port: number
}

// OpenBot serves plain HTTP only. A reverse proxy in front of it serves HTTPS.
const nodeServer = (options: Listen) =>
	NodeHttpServer.layer(() => createServer(), {
		host: options.host,
		port: options.port,
	})

/**
 * Serves OpenBot with its own Node.js HTTP server. Sign-in follows the
 * platform settings: the public origin, the sign-in secret and the sign-in
 * provider. It gives the app services to the caller too.
 *
 * It needs the shared services (`OpenBot.layerShared`), the services from
 * outside of OpenBot (`OpenBot.layerOutside`), the tools of the host
 * (`HostTools.none` for none), and the platform services. `layerLive` gives
 * all but the platform services.
 */
export const layer = (options: AppOptions & Listen) =>
	Layer.merge(serve(options), warnBeforeSetup).pipe(
		Layer.provideMerge(nodeServer(options)),
	)

/**
 * Serves OpenBot like `layer`, with the shared services of `secretKeys` and
 * `databaseUrl`, the real services from outside, and no tools of the host.
 * The `openbot-server` program runs it. It needs only the platform services.
 */
export const layerLive = (
	options: AppOptions &
		Listen & { readonly secretKeys: Redacted.Redacted<string> },
) =>
	layer(options).pipe(
		Layer.provide(Layer.merge(OpenBot.layerOutside, HostTools.none)),
		Layer.provideMerge(OpenBot.layerShared(options)),
	)

/**
 * Serves OpenBot like `layer`, and first writes one sign-in configuration into
 * the platform settings: its public origin, its sign-in secret and its
 * provider. The development mode of `auth` uses the local test account. Tests
 * and the development server use it. It needs the same services as `layer`.
 */
export const layerFixed = (
	options: Omit<AppOptions, "development"> &
		Listen & {
			readonly auth: Configuration
			/** The platform admins of a new platform. */
			readonly platformAdmins?: ReadonlyArray<string>
			/** The object storage for files. Without it, the platform keeps its own. */
			readonly fileStorage?: Api.FileStorageInput | undefined
		},
) =>
	serve({ ...options, development: options.auth.mode === "development" }).pipe(
		Layer.provide(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const auth = yield* AuthConfiguration.resolve(options.auth)
					yield* Setup.run({
						publicOrigin: auth.publicOrigin,
						identityProvider:
							auth.mode === "oidc"
								? Option.some({
										issuer: auth.issuer,
										clientId: auth.clientId,
										clientSecret: Option.fromNullishOr(auth.clientSecret),
									})
								: Option.none(),
						adminEmails: options.platformAdmins ?? ["developer@localhost.test"],
						// The configuration in the code wins over the stored one.
						force: true,
						authSecret: Option.some(auth.secret),
						fileStorage: Option.fromUndefinedOr(options.fileStorage),
					}).pipe(
						// force: true replaces the settings, so SetupAlreadyDone cannot occur.
						Effect.catchTag("SetupAlreadyDone", (error) => Effect.die(error)),
					)
				}),
			).pipe(Layer.provide(PlatformAdminsPostgres.layer)),
		),
		Layer.provideMerge(nodeServer(options)),
	)
