import { hostname } from "node:os"
import { Config, ConfigProvider, Effect, type Option, Redacted } from "effect"

export interface Settings {
	readonly webhookUrl: Redacted.Redacted<string>
	readonly signingSecret: Redacted.Redacted<string>
	readonly environment: string
	readonly version: string
	readonly instance: string
}

export const load: Config.Config<Option.Option<Settings>> = Config.all({
	webhookUrl: Config.Redacted("OPENBOT_LARK_WEBHOOK_URL").pipe(
		Config.withDefault(Redacted.make("")),
	),
	signingSecret: Config.Redacted("OPENBOT_LARK_SIGNING_SECRET").pipe(
		Config.withDefault(Redacted.make("")),
	),
	environment: Config.NonEmptyString("OPENBOT_ENVIRONMENT").pipe(
		Config.withDefault("development"),
	),
	version: Config.NonEmptyString("OPENBOT_VERSION").pipe(
		Config.withDefault("unknown"),
	),
	instance: Config.String("OPENBOT_INSTANCE").pipe(
		Config.withDefault(""),
		Config.map((value) => (value === "" ? hostname() : value)),
	),
}).pipe(
	Config.mapEffect((settings) => {
		const url = Redacted.value(settings.webhookUrl)
		if (url === "") return Effect.succeedNone
		if (
			!/^https:\/\/open\.larksuite\.com\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(
				url,
			)
		)
			return Effect.fail(
				new Config.ConfigError(
					new ConfigProvider.SourceError({
						message:
							"OPENBOT_LARK_WEBHOOK_URL must be an HTTPS Lark custom bot URL",
					}),
				),
			)
		return Effect.succeedSome(settings)
	}),
)
