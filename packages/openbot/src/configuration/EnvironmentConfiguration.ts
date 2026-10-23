import type * as Configuration from "./Configuration.ts"
import { Config, ConfigProvider, Option, Result } from "effect"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"

export const load: Configuration.Load = Config.all({
	host: Config.NonEmptyString("OPENBOT_HOST").pipe(
		Config.withDefault("127.0.0.1"),
	),
	port: Config.Port("OPENBOT_PORT").pipe(Config.withDefault(3000)),
	databaseUrl: Config.Redacted("OPENBOT_DATABASE_URL"),
	secretKeys: Config.Redacted("OPENBOT_SECRET_KEYS"),
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
	outboundAllow: Config.String("OPENBOT_OUTBOUND_ALLOW").pipe(
		Config.withDefault(""),
		Config.flatMap((input) =>
			Result.match(OutboundPolicy.parse(input), {
				onSuccess: (allow) => Config.succeed(allow),
				onFailure: (message) =>
					Config.fail(new ConfigProvider.SourceError({ message })),
			}),
		),
	),
})
