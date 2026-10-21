import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Settings as Api } from "@openbot-build/api"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { Command, Flag } from "effect/cli"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as SecretFiles from "../configuration/SecretFiles.ts"
import * as PlatformAdminsPostgres from "../platform/PlatformAdminsPostgres.ts"
import * as Setup from "../platform/Setup.ts"
import * as OpenBot from "./OpenBot.ts"

const publicOrigin = Flag.String("public-origin").pipe(
	Flag.withSchema(Api.PublicOrigin),
	Flag.withDescription("The public HTTPS address of OpenBot."),
)
const issuer = Flag.String("oidc-issuer").pipe(
	Flag.withSchema(Api.Issuer),
	Flag.optional,
	Flag.withDescription(
		"The OpenID Connect provider of the platform. Leave it out when people sign in only through organization SSO.",
	),
)
const clientId = Flag.String("oidc-client-id").pipe(
	Flag.optional,
	Flag.withDescription("The client ID at the OpenID Connect provider."),
)
const clientSecret = Flag.Redacted("oidc-client-secret").pipe(
	// A secret on the command line can show up in process lists, so it can also come from the environment.
	Flag.withFallbackConfig(Config.Redacted("OPENBOT_SETUP_OIDC_CLIENT_SECRET")),
	Flag.optional,
	Flag.withDescription(
		"The client secret. Leave it out for a public PKCE client. You can also set OPENBOT_SETUP_OIDC_CLIENT_SECRET.",
	),
)
const adminEmails = Flag.String("admin-email").pipe(
	Flag.atLeast(1),
	Flag.withDescription(
		"A person with this verified email becomes a platform admin. Repeat it for more people.",
	),
)
const force = Flag.Boolean("force").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Write the settings even when they exist. Use it only when no platform admin can sign in.",
	),
)

const setup = Command.make("setup", {
	publicOrigin,
	issuer,
	clientId,
	clientSecret,
	adminEmails,
	force,
}).pipe(
	Command.withDescription(
		"Write the first platform settings and platform admins. Change them later through /v1/platform.",
	),
	Command.withHandler((input) =>
		Effect.gen(function* () {
			if (Option.isSome(input.issuer) !== Option.isSome(input.clientId))
				return yield* Setup.SetupInvalid.make({
					message: "Set --oidc-issuer and --oidc-client-id together.",
				})
			const identityProvider = Option.zipWith(
				input.issuer,
				input.clientId,
				(issuer, clientId) => ({
					issuer,
					clientId,
					clientSecret: Option.map(input.clientSecret, Redacted.value),
				}),
			)
			const outcome = yield* Setup.run({
				publicOrigin: input.publicOrigin,
				identityProvider,
				adminEmails: input.adminEmails,
				force: input.force,
			})
			yield* Effect.logInfo(
				outcome === "created"
					? "OpenBot wrote the platform settings."
					: outcome === "replaced"
						? "OpenBot replaced the platform settings."
						: "The platform settings were already the same. OpenBot added the admins.",
			)
		}).pipe(
			Effect.catchTag("SetupAlreadyDone", () =>
				Effect.fail(
					Setup.SetupInvalid.make({
						message:
							"The platform already has other settings. Change them through PATCH /v1/platform/settings, or run setup again with --force.",
					}),
				),
			),
		),
	),
)

const program = Command.run(setup, { version: "0.1.0" })

const services = Layer.unwrap(
	Effect.map(EnvironmentConfiguration.load, (instance) =>
		PlatformAdminsPostgres.layer.pipe(
			Layer.provideMerge(OpenBot.layerShared(instance)),
		),
	),
)

NodeRuntime.runMain(
	program.pipe(
		// This program owns the whole application Layer scope.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(
			Layer.merge(services, NodeServices.layer).pipe(
				// The database URL and the secret keys may come from secret files.
				Layer.provide(Layer.merge(NodeServices.layer, SecretFiles.layer())),
			),
		),
	),
)
