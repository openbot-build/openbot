import type * as Configuration from "./Configuration.ts"
import { Config, ConfigProvider, Option, Redacted } from "effect"

const authentication = Config.Boolean("OPENBOT_DEV_MODE").pipe(
	Config.withDefault(false),
	Config.flatMap((development) =>
		Config.all({
			publicOrigin: Config.NonEmptyString("OPENBOT_PUBLIC_ORIGIN"),
			secret: Config.Redacted("BETTER_AUTH_SECRET"),
		}).pipe(
			Config.flatMap((shared): Config.Config<Configuration.Settings["auth"]> =>
				development
					? Config.succeed({ ...shared, mode: "development" })
					: Config.all({
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

export const load: Configuration.Load = Config.all({
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
		Config.flatMap(({ certFile, keyFile }) =>
			Option.isSome(certFile) && Option.isSome(keyFile)
				? Config.succeed({ certFile: certFile.value, keyFile: keyFile.value })
				: Option.isNone(certFile) && Option.isNone(keyFile)
					? Config.succeed(undefined)
					: Config.fail(
							new ConfigProvider.SourceError({
								message:
									"Set both OPENBOT_TLS_CERT and OPENBOT_TLS_KEY to serve HTTPS.",
							}),
						),
		),
	),
})
