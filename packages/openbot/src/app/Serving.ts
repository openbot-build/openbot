/**
 * The parts of a server around the app: its own Node.js HTTP server, the
 * check that the platform has settings, and the fixed sign-in configuration
 * of tests and of the development server.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer needs a function that makes a Node HTTP server.
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Settings as Api } from "@openbot-build/api"
import { Effect, Layer, Option, Result } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as PlatformAdminsPostgres from "../plugin-platform/PlatformAdminsPostgres.ts"
import * as Setup from "../plugin-platform/Setup.ts"
import * as AuthConfiguration from "../server-kernel/auth/Configuration.ts"
import type { Configuration } from "../server-kernel/auth/Model.ts"
import * as Report from "../server-kernel/errors/Report.ts"
import { Settings } from "../server-kernel/settings/Settings.ts"

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

/** Logs a warning when the platform has no settings yet. */
export const warnBeforeSetup = Layer.effectDiscard(
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
 * Serves the app once, for the life of the process, with the check of the
 * platform settings around it. Values from the platform settings are read when
 * they are used, so a change to them works at once and stops no running
 * request or Turn.
 */
export const serve = <A, E, R>(app: Layer.Layer<A, E, R>) =>
	Layer.unwrap(
		Effect.map(Report.make, (report) =>
			HttpRouter.serve(app, {
				middleware: (http) => requireSetup(http, report),
			}),
		),
	)

/** The address that the server listens on. */
export interface Listen {
	readonly host: string
	readonly port: number
}

/** A Node.js HTTP server. OpenBot serves plain HTTP only. A reverse proxy in front of it serves HTTPS. */
export const nodeServer = (options: Listen) =>
	NodeHttpServer.layer(() => createServer(), {
		host: options.host,
		port: options.port,
	})

/** One sign-in configuration that the code gives, in place of `openbot setup`. */
export interface Fixed {
	readonly auth: Configuration
	/** The platform admins of a new platform. */
	readonly platformAdmins?: ReadonlyArray<string> | undefined
	/** The object storage for files. Without it, the platform keeps its own. */
	readonly fileStorage?: Api.FileStorageInput | undefined
}

/**
 * Writes one sign-in configuration into the platform settings: its public
 * origin, its sign-in secret and its provider. It replaces the stored one. In
 * development mode, the local test account may make organizations.
 */
export const fixed = (options: Fixed) =>
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
	).pipe(Layer.provide(PlatformAdminsPostgres.layer))
