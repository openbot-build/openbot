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
const s3Endpoint = Flag.String("s3-endpoint").pipe(
	Flag.withSchema(Api.StorageEndpoint),
	Flag.optional,
	Flag.withDescription(
		"The address of the object storage for files, such as https://s3.us-east-1.amazonaws.com. Leave it out for no file uploads.",
	),
)
const s3PublicEndpoint = Flag.String("s3-public-endpoint").pipe(
	Flag.withSchema(Api.StorageEndpoint),
	Flag.optional,
	Flag.withDescription(
		"The address where clients put files with a signed upload, when it is not --s3-endpoint.",
	),
)
const s3Region = Flag.String("s3-region").pipe(
	Flag.withDefault("us-east-1"),
	Flag.withDescription("The region of the object storage."),
)
const s3Bucket = Flag.String("s3-bucket").pipe(
	Flag.withSchema(Api.BucketName),
	Flag.optional,
	Flag.withDescription("The bucket for files."),
)
const s3AccessKeyId = Flag.String("s3-access-key-id").pipe(
	Flag.optional,
	Flag.withDescription("The access key ID for the object storage."),
)
const s3SecretAccessKey = Flag.Redacted("s3-secret-access-key").pipe(
	Flag.withFallbackConfig(
		Config.Redacted("OPENBOT_SETUP_S3_SECRET_ACCESS_KEY"),
	),
	Flag.optional,
	Flag.withDescription(
		"The secret access key. You can also set OPENBOT_SETUP_S3_SECRET_ACCESS_KEY.",
	),
)
const s3PathStyle = Flag.Boolean("s3-path-style").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Put the bucket in the path. Most storage that is not AWS needs it.",
	),
)
const force = Flag.Boolean("force").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Write the settings even when they exist. Use it only when no platform admin can sign in.",
	),
)

const services = Layer.unwrap(
	Effect.map(EnvironmentConfiguration.load, (instance) =>
		PlatformAdminsPostgres.layer.pipe(
			Layer.provideMerge(OpenBot.layerShared(instance)),
		),
	),
)

// Read the settings only when the command runs, so --help works without them.
const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		// This program owns the whole application Layer scope.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(
			services.pipe(
				// The database URL and the secret keys may come from secret files.
				Layer.provide(Layer.merge(NodeServices.layer, SecretFiles.layer())),
			),
		),
	)

const setup = Command.make("openbot setup", {
	publicOrigin,
	issuer,
	clientId,
	clientSecret,
	adminEmails,
	s3Endpoint,
	s3PublicEndpoint,
	s3Region,
	s3Bucket,
	s3AccessKeyId,
	s3SecretAccessKey,
	s3PathStyle,
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
			const storage = [
				Option.isSome(input.s3Endpoint),
				Option.isSome(input.s3Bucket),
				Option.isSome(input.s3AccessKeyId),
				Option.isSome(input.s3SecretAccessKey),
			]
			if (storage.includes(true) && storage.includes(false))
				return yield* Setup.SetupInvalid.make({
					message:
						"Set --s3-endpoint, --s3-bucket, --s3-access-key-id and --s3-secret-access-key together.",
				})
			const fileStorage = Option.all({
				endpoint: input.s3Endpoint,
				bucket: input.s3Bucket,
				accessKeyId: input.s3AccessKeyId,
				secretAccessKey: Option.map(input.s3SecretAccessKey, Redacted.value),
			}).pipe(
				Option.map((storage) => ({
					...storage,
					publicEndpoint: Option.getOrNull(input.s3PublicEndpoint),
					region: input.s3Region,
					forcePathStyle: input.s3PathStyle,
				})),
				Option.getOrUndefined,
			)
			const outcome = yield* Setup.run({
				publicOrigin: input.publicOrigin,
				fileStorage,
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
			withServices,
		),
	),
)

const program = Command.run(setup, { version: "0.1.0" })

NodeRuntime.runMain(
	program.pipe(
		// This program owns the whole application Layer scope.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(NodeServices.layer),
	),
)
