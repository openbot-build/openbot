import type * as Configuration from "./Configuration.ts"
import { Config, Result, Schema, SchemaIssue } from "effect"
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
				// The value is there but it is not right, so this is a schema error,
				// not a source error (a source that could not be read).
				onFailure: (message) =>
					Config.fail(
						new Schema.SchemaError(new SchemaIssue.InvalidValue({ message })),
					),
			}),
		),
	),
})
