import type { Etag, HttpPlatform } from "effect/http"
import type { NodeServices } from "@effect/platform-node"
import * as BillingHost from "./BillingHost.ts"
import * as ErrorRecords from "../server-kernel/errors/Records.ts"
import * as HttpFailureBoundary from "../server-kernel/errors/HttpBoundary.ts"
import * as HttpHost from "../server-kernel/errors/HttpHost.ts"
import type { PgClient } from "@effect/sql-pg"
import { Settings as Api } from "@openbot-build/api"

// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer needs a function that makes a Node HTTP server.
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import * as Http from "./Http.ts"
import * as Host from "./Host.ts"
import { Effect, Layer, Option, Redacted, Result } from "effect"
import type { SecureRandom } from "effect/crypto"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as OpenBot from "./OpenBot.ts"
import * as AuthHttpHandlers from "../plugin-auth/HttpHandlers.ts"
import * as AuthorizationLayer from "../plugin-authorization/Layer.ts"
import * as ErrorReporting from "../server-kernel/errors/Reporting.ts"
import * as Report from "../server-kernel/errors/Report.ts"
import * as PlatformAdminsPostgres from "../plugin-platform/PlatformAdminsPostgres.ts"
import * as Setup from "../plugin-platform/Setup.ts"
import type { Auth } from "../identity-contract/auth/Auth.ts"
import * as AuthConfiguration from "../server-kernel/auth/Configuration.ts"
import type { Configuration } from "../server-kernel/auth/Model.ts"
import * as HostTools from "../tools-contract/chats/HostTools.ts"
import type { IndexWork } from "../apps-contract/apps/IndexWork.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"

/** The OpenBot routes, with error logs for failed requests. */
export const layerApi = Layer.mergeAll(
	Http.layerGroups,
	Http.layerBetterAuth,
	ErrorReporting.layerHttp,
).pipe(
	// The authorization middleware stays open to the other groups, as before.
	Layer.provide(
		AuthHttpHandlers.layerMiddleware.pipe(
			Layer.provideMerge(AuthorizationLayer.layer),
		),
	),
	Layer.provide(HttpFailureBoundary.layer),
	Layer.provideMerge(HttpHost.layer),
)

export interface AppOptions extends OpenBot.Options {
	/** The same private RPC secret on every node. */
	readonly clusterSecret: Redacted.Redacted<string>
	/** The address that other nodes can reach. Defaults to the bound server address. */
	readonly clusterHost?: string | undefined
	/** Work that runs when the server starts, such as indexing the development App. */
	readonly startup?: Layer.Layer<
		never,
		never,
		| IndexWork
		| PgClient.PgClient
		| SecureRandom.SecureRandom
		| ErrorRecords.Records
	>
	/**
	 * More routes, such as the routes of the development tools. They can use the
	 * `Auth` service to check the sign-in cookie.
	 */
	readonly routes?: Layer.Layer<
		never,
		never,
		| HttpRouter.HttpRouter
		| NodeServices.NodeServices
		| Etag.Generator
		| HttpPlatform.HttpPlatform
		| Auth
		| Settings
		| BillingHost.Wallets
		| PgClient.PgClient
		| Layer.Services<typeof BillingHost.middleware>
	>
}

/**
 * The routes of the options. They come last, so they cannot take a route of
 * OpenBot.
 */
const layerRoutes = (options: AppOptions) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const host = yield* HttpHost.HttpHost
			if (options.routes !== undefined)
				yield* host.mountRoutes("routes", options.routes, { last: true })
		}).pipe(
			// Each name has one mount, so a conflict is a broken rule of the code.
			Effect.catchTag("MountConflict", Effect.die),
		),
	)

/**
 * The routes and services of OpenBot, on the plugin host. The host mounts the
 * private RPC routes of the cluster itself, before it opens the engine
 * generation, so at shutdown they close after the generation. It needs the
 * same services as `Host.layerKernel`.
 */
export const layerApp = (options: AppOptions) =>
	Layer.mergeAll(layerRoutes(options), options.startup ?? Layer.empty).pipe(
		Layer.provideMerge(Host.layerExposed(options)),
		// A startup failure stops the process, as before.
		Layer.orDie,
	)

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
	report: Report.Report,
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
			yield* report(
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
		const report = yield* Report.make
		yield* settings.platform.pipe(
			Effect.flatMap((platform) =>
				Option.isNone(platform)
					? Effect.logWarning(
							"The platform has no settings yet. Run `openbot setup`. Until then, every route except /health answers with SetupRequired.",
						)
					: Effect.void,
			),
			Effect.catchTag("SettingsUnavailable", (error) =>
				report("OpenBot could not read the platform settings.", error).pipe(
					Effect.asVoid,
				),
			),
		)
	}),
)

/**
 * Serves the app once, for the life of the process. Values from the platform
 * settings are read when they are used, so a change to them works at once and
 * stops no running request or Turn.
 */
const serve = (options: AppOptions) =>
	Layer.unwrap(
		Effect.map(Report.make, (report) =>
			HttpRouter.serve(layerApp(options), {
				middleware: (app) => requireSetup(app, report),
			}),
		),
	)

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
					if (auth.mode === "development") {
						// The local test account has no verified provider. Let it make test organizations.
						const settings = yield* Settings
						const platform = Option.getOrThrow(yield* settings.platform)
						yield* settings.updatePlatform(platform.version, (document) =>
							Effect.succeed({ ...document, organizationCreation: "anyone" }),
						)
					}
				}),
			).pipe(Layer.provide(PlatformAdminsPostgres.layer)),
		),
		Layer.provideMerge(nodeServer(options)),
	)
