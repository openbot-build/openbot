import { Settings as Api } from "@openbot-build/api"
import { Config, Effect, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import * as Setup from "../platform/Setup.ts"

const publicOrigin = Flag.String("public-origin").pipe(
	Flag.withSchema(Api.PublicOrigin),
	Flag.withFallbackConfig(
		Config.schema(Api.PublicOrigin, "OPENBOT_SETUP_PUBLIC_ORIGIN"),
	),
	Flag.withDescription("The public HTTPS address of OpenBot."),
)
const issuer = Flag.String("oidc-issuer").pipe(
	Flag.withSchema(Api.Issuer),
	Flag.withFallbackConfig(
		Config.schema(Api.Issuer, "OPENBOT_SETUP_OIDC_ISSUER"),
	),
	Flag.optional,
	Flag.withDescription(
		"The OpenID Connect provider of the platform. Leave it out to preserve the existing provider, or for organization SSO on a new platform.",
	),
)
const clientId = Flag.String("oidc-client-id").pipe(
	Flag.withFallbackConfig(Config.String("OPENBOT_SETUP_OIDC_CLIENT_ID")),
	Flag.optional,
	Flag.withDescription("The client ID at the OpenID Connect provider."),
)
const clientSecret = Flag.Redacted("oidc-client-secret").pipe(
	// A secret on the command line can show up in process lists, so it can also come from the environment.
	Flag.withFallbackConfig(Config.Redacted("OPENBOT_SETUP_OIDC_CLIENT_SECRET")),
	Flag.optional,
	Flag.withDescription(
		"The client secret. Omit to preserve the same provider's secret, or for a new public PKCE client. You can also set OPENBOT_SETUP_OIDC_CLIENT_SECRET.",
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

const providerId = Flag.String("oidc-provider-id").pipe(
	Flag.withSchema(Api.ProviderId),
	Flag.withFallbackConfig(
		Config.schema(Api.ProviderId, "OPENBOT_SETUP_OIDC_PROVIDER_ID"),
	),
	Flag.optional,
	Flag.withDescription(
		"The stored provider ID. Keep it unchanged when moving an existing login.",
	),
)
const callbackPath = Flag.String("oidc-callback-path").pipe(
	Flag.withSchema(Api.CallbackPath),
	Flag.withFallbackConfig(
		Config.schema(Api.CallbackPath, "OPENBOT_SETUP_OIDC_CALLBACK_PATH"),
	),
	Flag.optional,
	Flag.withDescription("The existing same-origin OIDC callback path."),
)
const scopes = Flag.String("oidc-scopes").pipe(
	Flag.withSchema(Schema.fromJsonString(Api.OidcScopes)),
	Flag.withFallbackConfig(
		Config.schema(
			Schema.fromJsonString(Api.OidcScopes),
			"OPENBOT_SETUP_OIDC_SCOPES",
		),
	),
	Flag.optional,
	Flag.withDescription(
		'OIDC scopes as a JSON array, including openid. For example: ["openid","profile","email","offline_access"].',
	),
)
const browserAuth = Flag.String("browser-auth").pipe(
	Flag.withSchema(Schema.fromJsonString(Api.BrowserAuth)),
	Flag.withFallbackConfig(
		Config.schema(
			Schema.fromJsonString(Api.BrowserAuth),
			"OPENBOT_SETUP_BROWSER_AUTH",
		),
	),
	Flag.optional,
	Flag.withDescription(
		"Browser cookie names and sessionTtlMs as JSON. Keep existing names when moving a login.",
	),
)
const authSecret = Flag.Redacted("auth-secret").pipe(
	Flag.withFallbackConfig(Config.Redacted("OPENBOT_SETUP_AUTH_SECRET")),
	Flag.optional,
	Flag.withDescription(
		"Existing session signing secret. Prefer OPENBOT_SETUP_AUTH_SECRET or /run/secrets/OPENBOT_SETUP_AUTH_SECRET.",
	),
)
const memberSignupOrganizationId = Flag.String(
	"member-signup-organization-id",
).pipe(
	Flag.withSchema(Api.MemberSignupOrganizationId),
	Flag.withFallbackConfig(
		Config.schema(
			Api.MemberSignupOrganizationId,
			"OPENBOT_SETUP_MEMBER_SIGNUP_ORGANIZATION_ID",
		),
	),
	Flag.optional,
	Flag.withDescription(
		"Opt in to verified platform accounts joining this existing organization as ordinary members.",
	),
)

/** What the command says after each outcome of setup. */
const done: Record<Setup.Outcome, string> = {
	created: "OpenBot wrote the platform settings.",
	replaced: "OpenBot replaced the platform settings.",
	unchanged:
		"The platform settings were already the same. OpenBot added the admins.",
}

export const make = <E, R>(
	run: (input: Setup.Input) => Effect.Effect<Setup.Outcome, E, R>,
) =>
	Command.make("openbot setup", {
		publicOrigin,
		issuer,
		clientId,
		clientSecret,
		providerId,
		callbackPath,
		scopes,
		browserAuth,
		authSecret,
		memberSignupOrganizationId,
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
				if (
					Option.isNone(input.issuer) &&
					(Option.isSome(input.providerId) ||
						Option.isSome(input.callbackPath) ||
						Option.isSome(input.scopes) ||
						Option.isSome(input.clientSecret))
				)
					return yield* Setup.SetupInvalid.make({
						message: "OIDC options require --oidc-issuer and --oidc-client-id.",
					})
				const identityProvider = Option.zipWith(
					input.issuer,
					input.clientId,
					(issuer, clientId) => ({
						...(Option.isSome(input.providerId)
							? { providerId: input.providerId.value }
							: {}),
						...(Option.isSome(input.callbackPath)
							? { callbackPath: input.callbackPath.value }
							: {}),
						...(Option.isSome(input.scopes)
							? { scopes: input.scopes.value }
							: {}),
						issuer,
						clientId,
						clientSecret: input.clientSecret,
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
					secretAccessKey: input.s3SecretAccessKey,
				}).pipe(
					Option.map((storage) => ({
						...storage,
						publicEndpoint: Option.getOrNull(input.s3PublicEndpoint),
						region: input.s3Region,
						forcePathStyle: input.s3PathStyle,
					})),
				)
				const outcome = yield* run({
					publicOrigin: input.publicOrigin,
					fileStorage,
					identityProvider,
					adminEmails: input.adminEmails,
					force: input.force,
					authSecret: input.authSecret,
					...(Option.isSome(input.browserAuth)
						? { browserAuth: input.browserAuth.value }
						: {}),
					...(Option.isSome(input.memberSignupOrganizationId)
						? {
								memberSignupOrganizationId:
									input.memberSignupOrganizationId.value,
							}
						: {}),
				})
				yield* Effect.logInfo(done[outcome])
			}),
		),
	)
