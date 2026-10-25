import type * as Configuration from "./Configuration.ts"
import { Config, ConfigProvider, Result } from "effect"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"

export const load: Configuration.Load = Config.all({
	host: Config.NonEmptyString("OPENBOT_HOST").pipe(
		Config.withDefault("127.0.0.1"),
	),
	port: Config.Port("OPENBOT_PORT").pipe(Config.withDefault(3000)),
	databaseUrl: Config.Redacted("OPENBOT_DATABASE_URL"),
	secretKeys: Config.Redacted("OPENBOT_SECRET_KEYS"),
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
