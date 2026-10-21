import type * as Configuration from "./Configuration.ts"
import { Config, ConfigProvider, Option, Redacted } from "effect"

const authentication = Config.Boolean("OPENBOT_DEV_MODE").pipe(
	Config.withDefault(false),
	Config.flatMap((development) =>
		Config.all({
			publicOrigin: Config.NonEmptyString("OPENBOT_PUBLIC_ORIGIN"),
			sessionCookie: Config.NonEmptyString("OPENBOT_AUTH_SESSION_COOKIE").pipe(
				Config.withDefault("__Host-openbot-session"),
			),
			loginCookie: Config.NonEmptyString("OPENBOT_AUTH_LOGIN_COOKIE").pipe(
				Config.withDefault("__Host-openbot-login"),
			),
			secret: Config.Redacted("BETTER_AUTH_SECRET"),
		}).pipe(
			Config.flatMap((shared): Config.Config<Configuration.Settings["auth"]> =>
				development
					? Config.succeed({ ...shared, mode: "development" })
					: Config.all({
							providerId: Config.NonEmptyString(
								"OPENBOT_OIDC_PROVIDER_ID",
							).pipe(Config.withDefault("oidc")),
							callbackPath: Config.NonEmptyString(
								"OPENBOT_OIDC_CALLBACK_PATH",
							).pipe(Config.withDefault("/auth/callback/oidc")),
							issuer: Config.NonEmptyString("OPENBOT_OIDC_ISSUER"),
							clientId: Config.NonEmptyString("OPENBOT_OIDC_CLIENT_ID"),
							clientSecret: Config.Redacted("OPENBOT_OIDC_CLIENT_SECRET").pipe(
								Config.map((secret) =>
									Redacted.value(secret) === "" ? undefined : secret,
								),
								Config.withDefault(undefined),
							),
						}).pipe(
							Config.map((oidc) => ({ ...shared, ...oidc, mode: "oidc" })),
						),
			),
		),
	),
)

/** A comma-separated list. An empty value is an empty list. */
const list = (name: string, lowercase = true) =>
	Config.String(name).pipe(
		Config.withDefault(""),
		Config.map((value) =>
			value
				.split(",")
				.map((item) => (lowercase ? item.trim().toLowerCase() : item.trim()))
				.filter((item) => item !== ""),
		),
	)

const execution = Config.option(
	Config.NonEmptyString("OPENBOT_EXECUTION_AUTHORITY_ORIGIN"),
).pipe(
	Config.flatMap((origin) =>
		Option.isNone(origin)
			? Config.succeed(undefined)
			: Config.Redacted("OPENBOT_EXECUTION_AUTHORITY_TOKEN").pipe(
					Config.map((token) => ({
						origin: origin.value,
						token,
						backend: "openbot" as const,
					})),
				),
	),
)

export const load: Configuration.Load = Config.all({
	developerVerification: Config.all({
		metadataKeys: list(
			"OPENBOT_DEVELOPER_VERIFICATION_METADATA_ALIASES",
			false,
		),
		dnsLabels: list("OPENBOT_DEVELOPER_VERIFICATION_DNS_ALIASES"),
	}),
	execution,
	organization: Config.all({
		ownerUserIds: list("OPENBOT_OWNER_USER_IDS", false),
		memberUserIds: list("OPENBOT_MEMBER_USER_IDS", false),
		allowFirstLoginAdmin: Config.Boolean(
			"OPENBOT_ALLOW_FIRST_LOGIN_ADMIN",
		).pipe(Config.withDefault(true)),
		allowMemberSignup: Config.Boolean("OPENBOT_ALLOW_MEMBER_SIGNUP").pipe(
			Config.withDefault(false),
		),
		ownerEmails: list("OPENBOT_OWNER_EMAILS"),
		allowedEmailDomains: list("OPENBOT_ALLOWED_EMAIL_DOMAINS"),
	}),
	host: Config.NonEmptyString("OPENBOT_HOST").pipe(
		Config.withDefault("127.0.0.1"),
	),
	port: Config.Port("OPENBOT_PORT").pipe(Config.withDefault(3000)),
	databaseUrl: Config.Redacted("OPENBOT_DATABASE_URL"),
	appEncryptionKey: Config.Redacted("OPENBOT_APP_ENCRYPTION_KEY"),
	auth: authentication,
	tls: Config.all({
		certFile: Config.option(Config.NonEmptyString("OPENBOT_TLS_CERT")),
		keyFile: Config.option(Config.NonEmptyString("OPENBOT_TLS_KEY")),
	}).pipe(
		Config.flatMap((files) =>
			Option.match(Option.all(files), {
				onSome: (tls): Config.Config<Configuration.Settings["tls"]> =>
					Config.succeed(tls),
				onNone: () =>
					Option.isNone(files.certFile) && Option.isNone(files.keyFile)
						? Config.succeed(undefined)
						: Config.fail(
								new ConfigProvider.SourceError({
									message:
										"Set both OPENBOT_TLS_CERT and OPENBOT_TLS_KEY to serve HTTPS.",
								}),
							),
			}),
		),
	),
})
