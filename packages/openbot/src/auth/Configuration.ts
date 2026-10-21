import { Option, Schema } from "effect"
import {
	DevelopmentConfiguration,
	NoProviderConfiguration,
	OidcConfiguration,
} from "./Model.js"

export const ResolvedConfiguration = Schema.Union([
	OidcConfiguration.pipe(
		Schema.extendTo(
			{ redirectUri: Schema.String },
			{
				redirectUri: (config) =>
					Option.some(config.publicOrigin + config.callbackPath),
			},
		),
	),
	DevelopmentConfiguration,
	NoProviderConfiguration,
]).check(
	Schema.makeFilter((config) => config.sessionCookie !== config.loginCookie, {
		message: "Session and login cookies must have different names",
	}),
)
export type ResolvedConfiguration = typeof ResolvedConfiguration.Type
